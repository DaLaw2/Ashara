import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { ClientRepository, createDb, LlmCallRepository, resolveTestDatabaseUrl } from "@ashara/db";
import { ClientChanges, ClientMessageRepository, VisionRepository, createProjectWithTender } from "@ashara/engagement";
import type { ClientChangeStore } from "@ashara/engagement";
import { DEFAULT_WORK_BUDGETS, GuardedModelAccess, LlmCallLedger, SpendCap } from "@ashara/finance";
import { buildGateway, sdkLanguageModels } from "@ashara/model-access";
import type { ModelConfig } from "@ashara/model-access";
import { memoryStepContainment, recordingLogger } from "@ashara/shared";
import type { ProjectId } from "@ashara/shared";
import { createClientChangeStore } from "@ashara/server/client-change-store";

// A client's change is read the cycle it arrives into operations on the contract in force, applied
// as the next vision version with its revision record, and answered with one impact note in reply to
// it. Every row belongs to a project this suite creates under a unique name, and the Liaison is
// narrowed to those projects. No real LLM call is made: the provider factory returns a MockLanguageModelV4.

const stub = vi.hoisted(() => ({ model: undefined as unknown }));
vi.mock("@ai-sdk/deepseek", () => ({ createDeepSeek: () => () => stub.model }));

const DATABASE_URL = resolveTestDatabaseUrl(process.env);
const NAME_PREFIX = `client-change-test-${randomUUID().slice(0, 8)}`;
const TENDER = "Build a command that prints a greeting.";

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

/** A model answering every correction reading with `reading`. */
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

function liaison(wrap: (store: ClientChangeStore) => ClientChangeStore = (s) => s): ClientChanges {
  const store = createClientChangeStore(db, DEFAULT_WORK_BUDGETS);
  return new ClientChanges({
    llm: gateway,
    store: wrap({ ...store, openChanges: async () => (await store.openChanges()).filter((c) => ourProjects.has(c.projectId)) }),
    containment: memoryStepContainment(() => true),
  });
}

/** A project at work with vision v1 in the guarantees form: one interface entry, one guarantee, no exclusion. */
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

async function sendChange(projectId: ProjectId, body: string) {
  return new ClientMessageRepository(db).insertInbound({ projectId, kind: "change", body, inReplyTo: null });
}

async function repliesTo(changeId: string) {
  const result = await db.execute(sql`
    SELECT body FROM client_messages WHERE in_reply_to = ${changeId} AND direction = 'outbound' AND kind = 'report'`);
  return z.array(z.object({ body: z.string() })).parse(result.rows);
}

async function consumedAt(messageId: string) {
  const result = await db.execute(sql`SELECT consumed_at AS "consumedAt" FROM client_messages WHERE id = ${messageId}`);
  return z.array(z.object({ consumedAt: z.coerce.date().nullable() })).parse(result.rows)[0]?.consumedAt ?? null;
}

async function revisionsOf(projectId: ProjectId) {
  const result = await db.execute(sql`
    SELECT author, approver, direction, cause, status, version, source_message_id AS "sourceMessageId"
    FROM vision_revisions WHERE project_id = ${projectId} ORDER BY created_at`);
  return result.rows;
}

async function exclusionsOf(projectId: ProjectId) {
  const result = await db.execute(sql`SELECT version, exclusions FROM vision_documents WHERE project_id = ${projectId} ORDER BY version`);
  return z.array(z.object({ version: z.number(), exclusions: z.array(z.object({ id: z.string(), text: z.string() }).loose()) })).parse(result.rows);
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
            models: [model("change-strong", "Strong"), model("change-frontier", "Frontier")],
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

describe("a client's change", () => {
  test("sent mid-run is applied as the next version with the client's revision record and one impact note, and a restart does not read it again", async () => {
    const projectId = await contractedProject();
    readingModel(LEAVE_OUT_COLOUR);
    expect(await liaison().runPending()).toEqual([]);

    const change = await sendChange(projectId, "Never colour the output.");
    const outcomes = await liaison().runPending();
    expect(outcomes).toEqual([
      { kind: "recorded", changeId: change.id, projectId, confirmed: [], revision: { status: "applied", visionVersion: 2, direction: "narrows" } },
    ]);
    expect(await exclusionsOf(projectId)).toMatchObject([
      { version: 1, exclusions: [] },
      { version: 2, exclusions: [{ id: "X1", text: "Coloured output." }] },
    ]);
    expect(await revisionsOf(projectId)).toEqual([
      { author: "client", approver: "client", direction: "narrows", cause: "client-change", status: "applied", version: 2, sourceMessageId: change.id },
    ]);
    const replies = await repliesTo(change.id);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.body).toContain("Leave out: Coloured output.");
    expect(replies[0]?.body).toContain("The contract is now version 2");
    expect(await consumedAt(change.id)).not.toBeNull();

    // A restart: a fresh Liaison finds nothing open.
    expect(await liaison().runPending()).toEqual([]);
    expect(await repliesTo(change.id)).toHaveLength(1);
    expect(await revisionsOf(projectId)).toHaveLength(1);
  });

  test("a failed write leaves the change open and unanswered with no version or revision written, and the next cycle answers it once", async () => {
    const projectId = await contractedProject();
    readingModel(LEAVE_OUT_COLOUR);
    const change = await sendChange(projectId, "Never colour the output.");
    // The note, the transaction's last write, breaks the channel's non-empty body CHECK.
    const failing = liaison((store) => ({ ...store, recordCorrection: (write) => store.recordCorrection({ ...write, note: "" }) }));
    await expect(failing.runPending()).rejects.toThrow();
    expect(await repliesTo(change.id)).toHaveLength(0);
    expect(await consumedAt(change.id)).toBeNull();
    expect((await exclusionsOf(projectId)).map((v) => v.version)).toEqual([1]);
    expect(await revisionsOf(projectId)).toEqual([]);

    const answered = await liaison().runPending();
    expect(answered.map((o) => (o.kind === "recorded" ? o.changeId : o.kind))).toEqual([change.id]);
    expect(await repliesTo(change.id)).toHaveLength(1);
    expect(await consumedAt(change.id)).not.toBeNull();
  });
});
