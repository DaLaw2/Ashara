import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { ClientRepository, createDb, resolveTestDatabaseUrl } from "@ashara/db";
import { LlmCallRepository } from "@ashara/finance";
import { ProjectHaltRepository } from "@ashara/delivery";
import { ClientChanges, ClientMessageRepository, ClientReceipts, ClientStops, VisionRepository, acceptProject, consumeTenderWithoutIntake, createProjectWithTender } from "@ashara/engagement";
import { DEFAULT_WORK_BUDGETS, GuardedModelAccess, LlmCallLedger, SpendCap } from "@ashara/finance";
import { buildGateway, sdkLanguageModels } from "@ashara/model-access";
import type { ModelConfig } from "@ashara/model-access";
import { memoryStepContainment, recordingLogger } from "@ashara/shared/testing";
import type { ProjectId } from "@ashara/shared";
import { createClientChangeStore } from "@ashara/server/client-change-store";
import { createClientReceiptStore } from "@ashara/server/client-receipt-store";
import { createClientStopStore } from "@ashara/server/client-stop-store";

// Every message the client sends gets one receipt in the cycle that first sees it, whatever its
// project's state: at work, halted, stopped or delivered. The receipt names the state and what
// happens to the message, and a restart posts no second one. A change sent while the project is
// halted is read into its operations and a revision all the same, and the halt stays open; a
// closed project's message is recorded and consumed by its receipt, never acted on. Each cycle
// here runs the Liaison's inbound steps in the core loop's order: stops, receipts, changes. Every
// row belongs to a project this suite creates under a unique name, and each step is narrowed to
// those projects. No real LLM call is made: the provider factory returns a MockLanguageModelV4.

const stub = vi.hoisted(() => ({ model: undefined as unknown }));
vi.mock("@ai-sdk/deepseek", () => ({ createDeepSeek: () => () => stub.model }));

const DATABASE_URL = resolveTestDatabaseUrl(process.env);
const NAME_PREFIX = `client-receipt-test-${randomUUID().slice(0, 8)}`;
const TENDER = "Build a command that prints a greeting.";
const LEAVE_OUT_COLOUR = { ops: [{ op: "add-exclusion", text: "Coloured output.", direction: "neutral" }], confirms: [] };

let db: ReturnType<typeof createDb>;
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

/**
 * One cycle of the Liaison's inbound steps, in the core loop's order, by a freshly composed Liaison (a
 * restart between any two). With all work stopped at the deployment's cap it is the halted cycle's:
 * stops and receipts, and no reading.
 */
async function cycle(work: "running" | "stopped-at-cap" = "running"): Promise<void> {
  const containment = memoryStepContainment(() => true);
  const stops = createClientStopStore(db);
  await new ClientStops({ ...stops, openStops: async () => (await stops.openStops()).filter((s) => ourProjects.has(s.projectId)) }, containment).runPending();
  const receipts = createClientReceiptStore(db);
  await new ClientReceipts({ ...receipts, dueReceipts: async () => (await receipts.dueReceipts()).filter((r) => ourProjects.has(r.projectId)) }, containment).runPending({ kind: work });
  if (work === "stopped-at-cap") return;
  const changes = createClientChangeStore(db, DEFAULT_WORK_BUDGETS);
  await new ClientChanges({ shutdownSignal: new AbortController().signal,
    llm: gateway,
    store: { ...changes, openChanges: async () => (await changes.openChanges()).filter((c) => ourProjects.has(c.projectId)) },
    containment,
  }).runPending();
}

/** A project at work with vision v1 in the guarantees form, its tender's receipt already posted. */
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
  // The tender is consumed as intake would consume it, so the cycles below read only what each test sends.
  const [tender] = await new ClientMessageRepository(db).listByProject(project.id);
  if (tender !== undefined) await consumeTenderWithoutIntake(db, { id: tender.id, projectId: project.id });
  return project.id;
}

function send(projectId: ProjectId, kind: "change" | "stop", body: string) {
  return new ClientMessageRepository(db).insertInbound({ projectId, kind, body, inReplyTo: null });
}

/** The client's answer to a question the Liaison posted. */
async function sendAnswer(projectId: ProjectId, body: string) {
  const messages = new ClientMessageRepository(db);
  const [question] = await messages.insertQuestions(projectId, (await messages.listByProject(projectId))[0]?.id ?? "", ["Should the greeting be in colour?"]);
  return messages.insertInbound({ projectId, kind: "answer", body, inReplyTo: z.string().parse(question?.id) });
}

/** The receipts naming the message: there is to be exactly one. */
async function receiptsOf(messageId: string): Promise<string[]> {
  const result = await db.execute(sql`
    SELECT body FROM client_messages WHERE receipt_of = ${messageId} AND in_reply_to = ${messageId} AND direction = 'outbound' AND kind = 'report'`);
  return z.array(z.object({ body: z.string() })).parse(result.rows).map((row) => row.body);
}

/** The other reports in reply to the message: its reader's own (the impact note). */
async function readerRepliesOf(messageId: string): Promise<string[]> {
  const result = await db.execute(sql`
    SELECT body FROM client_messages WHERE in_reply_to = ${messageId} AND receipt_of IS NULL AND direction = 'outbound' AND kind = 'report'`);
  return z.array(z.object({ body: z.string() })).parse(result.rows).map((row) => row.body);
}

async function consumed(messageId: string): Promise<boolean> {
  const result = await db.execute(sql`SELECT consumed_at IS NOT NULL AS consumed FROM client_messages WHERE id = ${messageId}`);
  return z.array(z.object({ consumed: z.boolean() })).length(1).parse(result.rows)[0]?.consumed === true;
}

async function revisionsOf(projectId: ProjectId) {
  const result = await db.execute(sql`SELECT version, author, source_message_id AS "sourceMessageId", status FROM vision_revisions WHERE project_id = ${projectId} ORDER BY version`);
  return result.rows;
}

async function openHalts(projectId: ProjectId): Promise<string[]> {
  const result = await db.execute(sql`SELECT kind FROM project_blocks WHERE project_id = ${projectId} AND ended_at IS NULL`);
  return z.array(z.object({ kind: z.string() })).parse(result.rows).map((row) => row.kind);
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
            models: [model("receipt-strong", "Strong"), model("receipt-frontier", "Frontier")],
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
  vi.spyOn(console, "warn").mockImplementation(() => {});
  readingModel(LEAVE_OUT_COLOUR);
});

afterAll(async () => {
  const pattern = `${NAME_PREFIX}%`;
  const ours = sql`SELECT id FROM projects WHERE name LIKE ${pattern}`;
  await db.execute(sql`DELETE FROM correction_holds WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM vision_revisions WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM vision_documents WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM llm_calls WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM acceptance_sweeps WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM project_blocks WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM client_messages WHERE project_id IN (${ours}) AND receipt_of IS NOT NULL`);
  await db.execute(sql`DELETE FROM client_messages WHERE project_id IN (${ours}) AND in_reply_to IS NOT NULL`);
  await db.execute(sql`DELETE FROM client_messages WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM projects WHERE name LIKE ${pattern}`);
  await db.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
  await db.$client.end();
});

describe("every client message gets one receipt naming its project's state", () => {
  test("at work: the change's receipt says it is read now, and the impact note follows in the same cycle", async () => {
    const projectId = await contractedProject();
    const change = await send(projectId, "change", "Never colour the output.");
    await cycle();

    const [receipt, ...more] = await receiptsOf(change.id);
    expect(more).toEqual([]);
    expect(receipt).toContain("Ashara has received your change.");
    expect(receipt).toContain("This project is at work.");
    expect(receipt).toContain("Ashara reads it in this or the next round of work");
    expect(await readerRepliesOf(change.id)).toHaveLength(1);
    expect(await consumed(change.id)).toBe(true);

    await cycle();
    expect(await receiptsOf(change.id)).toHaveLength(1);
    expect(await readerRepliesOf(change.id)).toHaveLength(1);
  });

  test("halted on a plan repair: the change is read into a revision while the halt stays open, and its receipt and note say the pause holds the work", async () => {
    const projectId = await contractedProject();
    expect(await new ProjectHaltRepository(db).block(projectId, { category: "plan_repair", errorClass: "PlanRepairBound", reason: "repaired its bound of times" })).toBe("blocked");
    const change = await send(projectId, "change", "Never colour the output.");
    await cycle();

    const [receipt, ...more] = await receiptsOf(change.id);
    expect(more).toEqual([]);
    expect(receipt).toContain("Work on this project is paused");
    expect(receipt).toContain("Ashara reads it all the same");
    expect(receipt).toContain("This change does not end the pause");
    expect(receipt).toContain("The pause ends when the team's operator resumes the project");

    expect(await consumed(change.id)).toBe(true);
    expect(await revisionsOf(projectId)).toEqual([{ version: 2, author: "client", sourceMessageId: change.id, status: "applied" }]);
    const [note, ...notes] = await readerRepliesOf(change.id);
    expect(notes).toEqual([]);
    expect(note).toContain("Leave out: Coloured output.");
    expect(note).toContain("this message does not end the pause");
    expect(note).not.toContain("Work already planned continues meanwhile.");
    expect(await openHalts(projectId)).toEqual(["plan_repair"]);

    await cycle();
    expect(await receiptsOf(change.id)).toHaveLength(1);
    expect(await revisionsOf(projectId)).toHaveLength(1);
  });

  test("all work stopped at the deployment's cap: a project at work and one halted on a plan repair are each told nothing reads the message until the limit is raised", async () => {
    const atWork = await contractedProject();
    const halted = await contractedProject();
    expect(await new ProjectHaltRepository(db).block(halted, { category: "plan_repair", errorClass: "PlanRepairBound", reason: "repaired its bound of times" })).toBe("blocked");
    const changes = [await send(atWork, "change", "Never colour the output."), await send(halted, "change", "Never colour the output.")];
    await cycle("stopped-at-cap");

    for (const change of changes) {
      const [receipt, ...more] = await receiptsOf(change.id);
      expect(more).toEqual([]);
      expect(receipt).toContain("Ashara has stopped all work: the spending limit set for the whole deployment is reached.");
      expect(receipt).toContain("nothing reads it while all work is stopped");
      expect(receipt).not.toContain("round of work");
      expect(receipt).not.toContain("This project is at work.");
      expect(await consumed(change.id)).toBe(false);
    }
    expect(await receiptsOf(changes[1]?.id ?? "")).toEqual([expect.stringContaining("Work on this project is paused")]);

    await cycle("stopped-at-cap");
    for (const change of changes) expect(await receiptsOf(change.id)).toHaveLength(1);
  });

  test("stopped: the stop's receipt says it is taken, a later change and stop are recorded and not acted on, each answered once", async () => {
    const projectId = await contractedProject();
    const stop = await send(projectId, "stop", "Stop the work.");
    await cycle();
    expect(await receiptsOf(stop.id)).toEqual([expect.stringContaining("Your request is taken")]);

    const change = await send(projectId, "change", "Never colour the output.");
    const again = await send(projectId, "stop", "Stop, really.");
    await cycle();

    const [receipt, ...more] = await receiptsOf(change.id);
    expect(more).toEqual([]);
    expect(receipt).toContain("Work on this project has stopped at your request");
    expect(receipt).toContain("It is recorded, but not acted on: Ashara does no further work on a stopped project.");
    expect(await consumed(change.id)).toBe(true);
    expect(await readerRepliesOf(change.id)).toEqual([]);
    expect(await revisionsOf(projectId)).toEqual([]);
    expect(await receiptsOf(again.id)).toEqual([expect.stringContaining("The project was already stopped, so this request changes nothing.")]);

    await cycle();
    expect(await receiptsOf(change.id)).toHaveLength(1);
    expect(await receiptsOf(stop.id)).toHaveLength(1);
    expect(await receiptsOf(again.id)).toHaveLength(1);
  });

  test("delivered: a change and an answer are recorded and not acted on, each answered once", async () => {
    const projectId = await contractedProject();
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
      await tx.execute(sql`
        INSERT INTO acceptance_sweeps (project_id, main_commit, environment_version, checked_tasks, unchecked_tasks, passed, details)
        VALUES (${projectId}, ${"a".repeat(40)}, 'v1', '[]'::jsonb, '[]'::jsonb, true, 'all suites passed')`);
      await acceptProject(tx, projectId);
    });
    const change = await send(projectId, "change", "Never colour the output.");
    const answer = await sendAnswer(projectId, "No colour.");
    await cycle();

    for (const message of [change, answer]) {
      const [receipt, ...more] = await receiptsOf(message.id);
      expect(more).toEqual([]);
      expect(receipt).toContain("This project is delivered");
      expect(receipt).toContain("It is recorded, but not acted on: Ashara does no further work on a delivered project.");
      expect(await consumed(message.id)).toBe(true);
      expect(await readerRepliesOf(message.id)).toEqual([]);
    }
    expect(await revisionsOf(projectId)).toEqual([]);

    await cycle();
    expect(await receiptsOf(change.id)).toHaveLength(1);
    expect(await receiptsOf(answer.id)).toHaveLength(1);
  });
});
