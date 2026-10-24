import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { ClientRepository, createDb, resolveTestDatabaseUrl } from "@ashara/db";
import type { Database } from "@ashara/db";
import { attemptProfileOf } from "@ashara/delivery";
import { ClientChanges, ClientMessageRepository, VisionRepository, createProjectWithTender } from "@ashara/engagement";
import type { CellBackend } from "@ashara/execution-infra";
import { DEFAULT_WORK_BUDGETS, GuardedModelAccess, LlmCallLedger, LlmCallRepository, SpendCap, modelCallAbortedOf } from "@ashara/finance";
import { buildGateway, sdkLanguageModels } from "@ashara/model-access";
import type { ModelConfig } from "@ashara/model-access";
import type { ProjectId } from "@ashara/shared";
import { createWorkItemId } from "@ashara/shared";
import { memoryStepContainment, recordingLogger } from "@ashara/shared/testing";
import { createClientChangeStore } from "@ashara/server/client-change-store";
import { serveAshara } from "@ashara/server/process-lifecycle";
import type { ServedComposition } from "@ashara/server/process-lifecycle";
import { runAttempt } from "@ashara/workplace";

// A SIGTERM while a model call is in flight: the process's shutdown signal reaches the provider
// request of a structured call (a client's change read by the Liaison) and of an agent session's
// turn, so the shutdown ends within its deadline; each call is settled in llm_calls as aborted, never
// left pending and never ok, and the change is read afresh after the restart. No real LLM call is
// made: the provider factory returns a MockLanguageModelV4 that answers only once its request is aborted.

const stub = vi.hoisted(() => ({ model: undefined as unknown }));
vi.mock("@ai-sdk/deepseek", () => ({ createDeepSeek: () => () => stub.model }));

const DATABASE_URL = resolveTestDatabaseUrl(process.env);
const NAME_PREFIX = `shutdown-inflight-test-${randomUUID().slice(0, 8)}`;
const TENDER = "Build a command that prints a greeting.";
/** The deadline the shutdown is given: far above an aborted call's settling, far below a hung call. */
const SHUTDOWN_DEADLINE_MS = 10_000;
/** How far past the shutdown's deadline this test waits before it fails the shutdown as unbounded. */
const TEST_BOUND_MARGIN_MS = 2_000;

let db: Database;
let gateway: GuardedModelAccess;
let clientId: string;
const ourProjects = new Set<string>();

function model(id: string, capabilityLevel: ModelConfig["capabilityLevel"]): ModelConfig {
  return {
    id,
    apiModelId: `${id}-api`,
    provider: "deepseek",
    capabilityLevel,
    thinkingOffCapabilityLevel: capabilityLevel,
    inputCostPer1M: 1,
    outputCostPer1M: 2,
    maxContextTokens: 100_000,
    cacheReadCostPer1M: null,
    cacheWriteCostPer1M: null,
    priceWindows: [], priceTiers: [], datedPrices: [],
  };
}

/** A provider that never answers: each request it receives is counted, and ends only when its abort signal aborts. */
function hangingModel(onRequest: () => void): void {
  stub.model = new MockLanguageModelV4({
    doGenerate: (options) =>
      new Promise((_, reject) => {
        onRequest();
        const signal = options.abortSignal;
        // A request sent with no signal is one nothing can cancel: it hangs, as a provider that never answers does.
        if (signal === undefined) return;
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  });
}

/** A provider answering every correction reading with `reading`. */
function readingModel(reading: unknown): void {
  stub.model = new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text" as const, text: JSON.stringify({ correction: reading }) }],
      usage: {
        inputTokens: { total: 500, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 200, text: 200, reasoning: undefined },
      },
      finishReason: { unified: "stop" as const, raw: "stop" },
      warnings: [],
    }),
  });
}

const LEAVE_OUT_COLOUR = { ops: [{ op: "add-exclusion", text: "Coloured output.", direction: "neutral" }], confirms: [] };

/** The Liaison's change reading, narrowed to this suite's projects; an aborted call escapes its containment as the server's does. */
function liaison(shutdownSignal: AbortSignal, containment = memoryStepContainment((error) => modelCallAbortedOf(error) !== null)): ClientChanges {
  const store = createClientChangeStore(db, DEFAULT_WORK_BUDGETS);
  return new ClientChanges({
    llm: gateway,
    store: { ...store, openChanges: async () => (await store.openChanges()).filter((c) => ourProjects.has(c.projectId)) },
    containment,
    shutdownSignal,
  });
}

async function contractedProject(): Promise<ProjectId> {
  const { project } = await createProjectWithTender(db, clientId, `${NAME_PREFIX}-${randomUUID().slice(0, 6)}`, TENDER);
  ourProjects.add(project.id);
  await new VisionRepository(db).create(project.id, {
    visionText: TENDER,
    summary: "A greeting command.",
    contract: {
      interface: [{ id: "I1", text: "The command.", source: { kind: "tender", quote: "Build a command" } }],
      guarantees: [
        {
          id: "G1",
          statement: "The command prints a greeting.",
          observable: { interface: ["I1"], observation: "output" },
          refutedBy: ["The command prints no greeting."],
          source: { kind: "tender", quote: "prints a greeting" },
        },
      ],
      exclusions: [],
    },
  });
  return project.id;
}

function unused(what: string): never {
  throw new Error(`${what} is not called by an attempt whose first turn never answers`);
}

const cell: CellBackend = {
  readFile: () => unused("readFile"),
  writeFile: () => unused("writeFile"),
  listDirectory: () => unused("listDirectory"),
  search: () => unused("search"),
  run: () => unused("run"),
};

/** An agent session on the project's task, through the same guarded port, cancelled by `signal`. */
function agentSession(projectId: ProjectId, signal: AbortSignal) {
  return runAttempt(
    {
      projectId,
      taskId: createWorkItemId(),
      role: { id: "worker", name: "Worker" },
      ...attemptProfileOf(null),
      brief: {
        goal: "Write hello.txt",
        intent: "A greeting file",
        visionVersion: 1,
        assumptions: [],
        interfaceEntries: [],
        projectEnvironment: { kind: "to-define" },
        context: "An empty workspace.",
        deliverables: ["hello.txt"],
      },
      model: gateway.resolveModel("Strong", "agent-runner"),
      cellImage: { kind: "base-cell", image: "base@sha256:" + "0".repeat(64), digest: "sha256:" + "0".repeat(64) },
      limits: { maxTurns: 2, perCommandTimeoutSeconds: 60 },
    },
    { llm: gateway, cell, clock: { now: () => Date.now() }, records: { append: async () => {} }, signal, environment: null, checks: null, taskChecks: null },
  );
}

const CallRow = z.object({
  callSite: z.string(),
  state: z.string(),
  outcome: z.string().nullable(),
  errorKind: z.string().nullable(),
  finishReason: z.string().nullable(),
});

async function callsOf(projectId: ProjectId) {
  const result = await db.execute(sql`
    SELECT call_site AS "callSite", state, outcome, error_kind AS "errorKind", finish_reason AS "finishReason"
    FROM llm_calls WHERE project_id = ${projectId} ORDER BY call_site`);
  return z.array(CallRow).parse(result.rows);
}

async function consumedAt(messageId: string) {
  const result = await db.execute(sql`SELECT consumed_at AS "consumedAt" FROM client_messages WHERE id = ${messageId}`);
  return z.array(z.object({ consumedAt: z.coerce.date().nullable() })).parse(result.rows)[0]?.consumedAt ?? null;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  clientId = (await new ClientRepository(db).create(`${NAME_PREFIX}-client`)).id;
  gateway = new GuardedModelAccess(
    buildGateway({
      models: sdkLanguageModels,
      config: {
        providers: [
          {
            name: "deepseek",
            providerType: "deepseek",
            apiKey: "test-key",
            baseUrl: "https://stub.invalid/v1",
            models: [model("shutdown-strong", "Strong"), model("shutdown-frontier", "Frontier")],
            enabled: true,
          },
        ],
        defaultProvider: "deepseek",
        contextOverflow: { statuses: [400], codes: ["context_length_exceeded"], phrases: [] },
      },
      checkedSources: ["test"],
      clock: () => new Date(),
    }),
    new LlmCallLedger(new LlmCallRepository(db), new SpendCap({ ledger: new LlmCallRepository(db), caps: { deploymentUsd: 1_000_000, perProjectUsd: 1_000_000 } })),
    recordingLogger(),
  );
});

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterAll(async () => {
  const pattern = `${NAME_PREFIX}%`;
  const ours = sql`SELECT id FROM projects WHERE name LIKE ${pattern}`;
  await db.execute(sql`DELETE FROM vision_revisions WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM vision_documents WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM llm_calls WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM client_messages WHERE project_id IN (${ours}) AND in_reply_to IS NOT NULL`);
  await db.execute(sql`DELETE FROM client_messages WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM projects WHERE name LIKE ${pattern}`);
  await db.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
  await db.$client.end();
});

describe("a shutdown while model calls are in flight", () => {
  test("ends within its deadline, settles each call as aborted with its reservation released, and the restart reads the change afresh", async () => {
    const projectId = await contractedProject();
    const change = await new ClientMessageRepository(db).insertInbound({ projectId, kind: "change", body: "Never colour the output.", inReplyTo: null });

    let requests = 0;
    let bothInFlight: () => void = () => {};
    const inFlight = new Promise<void>((resolve) => (bothInFlight = resolve));
    hangingModel(() => {
      requests += 1;
      if (requests === 2) bothInFlight();
    });

    const shutdown = new AbortController();
    const containment = memoryStepContainment((error) => modelCallAbortedOf(error) !== null);
    const ended: { change?: unknown; attempt?: Awaited<ReturnType<typeof agentSession>> } = {};
    const logger = recordingLogger();
    const ashara: ServedComposition = {
      logger,
      booted: (work) => work(),
      port: 0,
      shutdownSignal: shutdown.signal,
      startup: async () => {},
      // The runner's cycle: the Liaison reading the change, and a lane's agent session, each with a call in flight.
      runner: {
        run: async (signal) => {
          const [read, attempt] = await Promise.allSettled([liaison(signal, containment).runPending(), agentSession(projectId, signal)]);
          ended.change = read.status === "rejected" ? read.reason : read.value;
          if (attempt.status === "fulfilled") ended.attempt = attempt.value;
          return null;
        },
      },
      abort: () => shutdown.abort(new Error("SIGTERM")),
      teardownCells: async () => {},
      closeDatabase: async () => {},
    };
    const served = await serveAshara(ashara, () => ({ close: () => {} }), SHUTDOWN_DEADLINE_MS);
    await inFlight;

    // Bounded by this test, not by the shutdown's own deadline: a shutdown that never settles fails here.
    const started = Date.now();
    let bound: NodeJS.Timeout | undefined;
    const shutdownOutcome = await Promise.race([
      served.shutdown(),
      new Promise<"test-bound-passed">((resolve) => (bound = setTimeout(() => resolve("test-bound-passed"), SHUTDOWN_DEADLINE_MS + TEST_BOUND_MARGIN_MS))),
    ]).finally(() => clearTimeout(bound));
    expect(shutdownOutcome).toBe("stopped");
    expect(Date.now() - started).toBeLessThan(SHUTDOWN_DEADLINE_MS);

    // The change's reading ended on the abort and escaped its containment: no fault is counted on it.
    expect(modelCallAbortedOf(ended.change)?.reason).toEqual(new Error("SIGTERM"));
    expect(containment.recorded.size).toBe(0);
    // The agent session ended cancelled by the shutdown, not as a transport failure.
    expect(ended.attempt?.kind).toBe("cancelled");

    // Each call's row is settled as aborted: recorded, never pending, never ok.
    expect(await callsOf(projectId)).toEqual([
      { callSite: "agent-runner", state: "recorded", outcome: "error", errorKind: "aborted", finishReason: "no-response" },
      { callSite: "liaison-intake", state: "recorded", outcome: "error", errorKind: "aborted", finishReason: "no-response" },
    ]);
    // Nothing is held in flight against the project's cap: each reservation was settled.
    expect((await new LlmCallRepository(db).spend({ kind: "project", projectId })).inFlightUsd).toBe(0);
    expect(requests).toBe(2);

    // The restart: the change is still unread, and a fresh Liaison reads it.
    expect(await consumedAt(change.id)).toBeNull();
    readingModel(LEAVE_OUT_COLOUR);
    const [outcome] = await liaison(new AbortController().signal).runPending();
    expect(outcome).toMatchObject({ kind: "recorded", changeId: change.id, projectId });
    expect(await consumedAt(change.id)).not.toBeNull();
  });
});
