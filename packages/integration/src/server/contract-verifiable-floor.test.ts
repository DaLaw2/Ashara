import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { ClientRepository, createDb, resolveTestDatabaseUrl } from "@ashara/db";
import { createFirstPlanStore } from "@ashara/delivery";
import { ClientAnswers, ClientChanges, ClientMessageRepository, ClientReceipts, TenderIntake, createProjectWithTender } from "@ashara/engagement";
import type { AnswerStore, ClientChangeStore, ClientReceiptStore, IntakeStore } from "@ashara/engagement";
import { DEFAULT_WORK_BUDGETS, GuardedModelAccess, LlmCallLedger, LlmCallRepository, SpendCap } from "@ashara/finance";
import { buildGateway, sdkLanguageModels } from "@ashara/model-access";
import type { ModelConfig } from "@ashara/model-access";
import { memoryStepContainment, recordingLogger } from "@ashara/shared/testing";
import type { ProjectId } from "@ashara/shared";
import { createAnswerStore } from "@ashara/server/answer-store";
import { createClientChangeStore } from "@ashara/server/client-change-store";
import { createClientReceiptStore } from "@ashara/server/client-receipt-store";
import { createIntakeStore } from "@ashara/server/intake-store";
import { createRosterStore } from "@ashara/server/roster-store";
import { terminalReportsOf } from "./terminal-reports.js";

// What Ashara can verify of a contract is told to the client before work, never found at acceptance:
// every contract version that reaches the client states how many of its guarantees Ashara can verify;
// one in which it can verify none is declined: every message posted while it is in force says so and
// asks for the guarantees restated, no work starts, the client's confirming it as written changes
// nothing, and only a restatement holding a guarantee Ashara can verify releases it. A change that would
// write such a version is declined, never held for confirmation. A drafter's "undecided" observation is
// recorded as such, never as stored-data and never as not verifiable: it is not counted as one Ashara
// can verify, and it is put to the client. A guarantee is marked not verifiable only with its reason. Every
// row belongs to a project this suite creates under a unique name. No real LLM call is made: the
// provider factory returns a MockLanguageModelV4 answering each prompt as the test scripts it.

const stub = vi.hoisted(() => ({ model: undefined as unknown }));
vi.mock("@ai-sdk/deepseek", () => ({ createDeepSeek: () => () => stub.model }));

const DATABASE_URL = resolveTestDatabaseUrl(process.env);
const NAME_PREFIX = `verifiable-floor-test-${randomUUID().slice(0, 8)}`;
const TENDER = "A ledger that keeps every entry the client records. Entries survive a restart.";

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

/** A model answering every call with `value`, as JSON. */
function answering(value: unknown): void {
  stub.model = new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text" as const, text: JSON.stringify(value) }],
      usage: {
        inputTokens: { total: 500, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 200, text: 200, reasoning: undefined },
      },
      finishReason: { unified: "stop" as const, raw: "stop" },
      warnings: [],
    }),
  });
}

type Observation = "output" | "errors" | "exit-status" | "stored-data" | "undecided";

/** A first reading of TENDER asking one question, its guarantees observed as `observations` say, in order G1, G2. */
function reading(observations: readonly [Observation, Observation]) {
  const quote = (text: string) => ({ kind: "tender", quote: text });
  return {
    summary: "A ledger of the client's entries.",
    interface: [{ id: "I1", text: "ledger add ENTRY; ledger list", source: quote("A ledger") }],
    guarantees: [
      { id: "G1", statement: "Every entry the client records is kept.", observable: { interface: ["I1"], observation: observations[0] }, refutedBy: ["a recorded entry is missing from the list"], source: quote("keeps every entry the client records") },
      { id: "G2", statement: "Entries survive a restart.", observable: { interface: ["I1"], observation: observations[1] }, refutedBy: ["an entry recorded before a restart is missing after it"], source: quote("Entries survive a restart.") },
    ],
    questions: [
      {
        text: "How many entries does the ledger hold at most?",
        whyItMatters: "It decides how entries are stored.",
        assumption: { id: "A1", statement: "The ledger holds up to a million entries.", rationale: "A personal ledger stays small.", kind: "client-visible", underpins: ["G1"] },
      },
    ],
    assumptions: [],
    exclusions: [],
  };
}

function intake(): TenderIntake {
  const store = createIntakeStore(db);
  const ours: IntakeStore = { ...store, openTenders: async () => (await store.openTenders()).filter((t) => ourProjects.has(t.projectId)) };
  return new TenderIntake({ shutdownSignal: new AbortController().signal, containment: memoryStepContainment(() => true), llm: gateway, store: ours });
}

function liaison(): ClientChanges {
  const store = createClientChangeStore(db, DEFAULT_WORK_BUDGETS);
  const ours: ClientChangeStore = { ...store, openChanges: async () => (await store.openChanges()).filter((c) => ourProjects.has(c.projectId)) };
  return new ClientChanges({ shutdownSignal: new AbortController().signal, llm: gateway, store: ours, containment: memoryStepContainment(() => true) });
}

function answers(): ClientAnswers {
  const store = createAnswerStore(db);
  const ours: AnswerStore = { ...store, openAnswers: async () => (await store.openAnswers()).filter((a) => ourProjects.has(a.projectId)) };
  return new ClientAnswers({ shutdownSignal: new AbortController().signal, containment: memoryStepContainment(() => true), llm: gateway, store: ours });
}

async function tendered(): Promise<ProjectId> {
  const { project } = await createProjectWithTender(db, clientId, `${NAME_PREFIX}-${randomUUID().slice(0, 6)}`, TENDER);
  ourProjects.add(project.id);
  return project.id;
}

/** The project's tender read with `observations`: vision v1 written, and the project's id. */
async function readTender(observations: readonly [Observation, Observation]): Promise<ProjectId> {
  const projectId = await tendered();
  answering(reading(observations));
  expect(await intake().runPending()).toMatchObject([{ kind: "recorded", projectId }]);
  return projectId;
}

/** A roster recorded for the project without a model call, so only the hold keeps it from its first plan. */
async function rostered(projectId: ProjectId): Promise<void> {
  const role = { id: randomUUID(), name: "Developer", responsibility: "Builds and checks the ledger.", capabilities: ["write-source"] as ["write-source"] };
  expect(await createRosterStore(db).recordRoster({ projectId, visionVersion: 1, revision: 1, roles: [role] })).toBe("recorded");
}

/** Whether any step that starts work lists the project: its roster's derivation, and with a roster its first plan. */
async function workMayStart(projectId: ProjectId): Promise<{ readonly roster: boolean; readonly firstPlan: boolean }> {
  const roster = (await createRosterStore(db).projectsAwaitingRoster()).some((p) => p.projectId === projectId);
  const firstPlan = (await createFirstPlanStore(db).projectsAwaitingPlan()).some((p) => p.projectId === projectId);
  return { roster, firstPlan };
}

async function contractDraftOf(projectId: ProjectId): Promise<string> {
  const result = await db.execute(sql`SELECT body FROM client_messages WHERE project_id = ${projectId} AND reports_on = 'contract-draft'`);
  const [row, ...more] = z.array(z.object({ body: z.string() })).parse(result.rows);
  if (row === undefined || more.length > 0) throw new Error(`project ${projectId}: expected one contract draft, got ${result.rows.length}`);
  return row.body;
}

const RevisionRowSchema = z.object({
  author: z.string(),
  approver: z.string().nullable(),
  status: z.string(),
  basedOn: z.number(),
  version: z.number().nullable(),
  pushback: z.unknown(),
});

async function revisionsOf(projectId: ProjectId) {
  const result = await db.execute(sql`
    SELECT author, approver, status, based_on_version AS "basedOn", version, pushback
    FROM vision_revisions WHERE project_id = ${projectId} ORDER BY created_at, id`);
  return z.array(RevisionRowSchema).parse(result.rows);
}

const StoredGuaranteeSchema = z.looseObject({
  id: z.string(),
  observable: z.looseObject({ observation: z.string() }),
  verification: z.string().optional(),
  unverifiableBecause: z.string().optional(),
});

async function guaranteesOf(projectId: ProjectId, version: number) {
  const result = await db.execute(sql`SELECT guarantees FROM vision_documents WHERE project_id = ${projectId} AND version = ${version}`);
  const [row] = z.array(z.object({ guarantees: z.array(StoredGuaranteeSchema) })).parse(result.rows);
  if (row === undefined) throw new Error(`project ${projectId} has no vision v${version}`);
  return row.guarantees.map((g) => ({ id: g.id, observation: g.observable.observation, verification: g.verification, because: g.unverifiableBecause }));
}

async function visionVersionsOf(projectId: ProjectId): Promise<number[]> {
  const result = await db.execute(sql`SELECT version FROM vision_documents WHERE project_id = ${projectId} ORDER BY version`);
  return z.array(z.object({ version: z.number() })).parse(result.rows).map((row) => row.version);
}

async function sendChange(projectId: ProjectId, body: string) {
  return new ClientMessageRepository(db).insertInbound({ projectId, kind: "change", body, inReplyTo: null });
}

async function noteOn(changeId: string): Promise<string> {
  const result = await db.execute(
    sql`SELECT body FROM client_messages WHERE in_reply_to = ${changeId} AND direction = 'outbound' AND kind = 'report' AND receipt_of IS NULL`,
  );
  const [row, ...more] = z.array(z.object({ body: z.string() })).parse(result.rows);
  if (row === undefined || more.length > 0) throw new Error(`change ${changeId}: expected one note, got ${result.rows.length}`);
  return row.body;
}

/** How every message posted while a contract is declined begins its decline; at intake its terminal message alone says it. */
const DECLINE = "Ashara cannot verify any guarantee of this contract as written";
/** What every intake message on a declined contract says in the decline's place. */
const NOT_STARTED = "Work has not started on this contract";
/** What no message posted while a contract is declined may say: each claims work under way or not waiting. */
const UNDER_WAY = [
  "Work does not wait",
  "work proceeds",
  "Work proceeds",
  "Work has started",
  "nothing waits",
  "continues meanwhile",
  "we proceed on this assumption",
  "This project is at work",
  "planned again",
  "the work it touches",
];

/** G1 or G2 restated whole, observed in `observation`. */
function restated(id: "G1" | "G2", observation: Observation) {
  return {
    op: "amend-guarantee",
    id,
    statement: id === "G1" ? "Every entry the client records is listed." : "Entries are listed after a restart.",
    interface: ["I1"],
    observation,
    refutedBy: [id === "G1" ? "a recorded entry is missing from the list" : "an entry recorded before a restart is missing from the list after it"],
    direction: "neutral",
  };
}

/** Every message Ashara posted on the project, with its kind. */
async function outboundOf(projectId: ProjectId): Promise<Array<{ readonly id: string; readonly kind: string; readonly body: string }>> {
  const result = await db.execute(sql`SELECT id, kind, body FROM client_messages WHERE project_id = ${projectId} AND direction = 'outbound' ORDER BY created_at, id`);
  return z.array(z.object({ id: z.string(), kind: z.string(), body: z.string() })).parse(result.rows);
}

/** The receipt for a message, posted by the receipts step for this suite's projects. */
async function receiptOn(messageId: string): Promise<string> {
  const store = createClientReceiptStore(db);
  const ours: ClientReceiptStore = { ...store, dueReceipts: async () => (await store.dueReceipts()).filter((due) => ourProjects.has(due.projectId)) };
  await new ClientReceipts(ours, memoryStepContainment(() => true)).runPending({ kind: "running" });
  const result = await db.execute(sql`SELECT body FROM client_messages WHERE receipt_of = ${messageId}`);
  const [row, ...more] = z.array(z.object({ body: z.string() })).parse(result.rows);
  if (row === undefined || more.length > 0) throw new Error(`message ${messageId}: expected one receipt, got ${result.rows.length}`);
  return row.body;
}

async function workItemsOf(projectId: ProjectId): Promise<number> {
  const result = await db.execute(sql`SELECT count(*)::int AS n FROM work_items WHERE project_id = ${projectId}`);
  const [row] = z.array(z.object({ n: z.number() })).parse(result.rows);
  return row?.n ?? Number.NaN;
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
            models: [model("floor-strong", "Strong"), model("floor-frontier", "Frontier")],
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
});

afterAll(async () => {
  const pattern = `${NAME_PREFIX}%`;
  const ours = sql`SELECT id FROM projects WHERE name LIKE ${pattern}`;
  await db.execute(sql`DELETE FROM roster_roles WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM intake_readings WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM vision_revisions WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM vision_documents WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM llm_calls WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM guarantee_verdicts WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM client_messages WHERE project_id IN (${ours}) AND in_reply_to IS NOT NULL`);
  await db.execute(sql`DELETE FROM client_messages WHERE project_id IN (${ours})`);
  await db.execute(sql`DELETE FROM projects WHERE name LIKE ${pattern}`);
  await db.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
  await db.$client.end();
});

describe("a contract in which Ashara can verify no guarantee", () => {
  test("drafted at intake is declined: the proposal states 0 verifiable, exactly one message tells the decline with the guarantee table, and none says work is under way", async () => {
    const projectId = await readTender(["stored-data", "stored-data"]);
    await rostered(projectId);

    const draft = await contractDraftOf(projectId);
    expect(draft).toMatch(/^This is the contract drafted from your tender\.\n\n/);
    expect(draft).toContain("Ashara can verify 0 of the 2 guarantees of this contract with the checks it can run today.");
    const intake = await outboundOf(projectId);
    expect(intake.map((m) => m.kind).sort()).toEqual(["question", "report"]);
    for (const { body } of intake) expect(body).toContain(NOT_STARTED);

    expect(await terminalReportsOf(db, (id) => id === projectId, { unswept: true, kinds: ["declined"] }).runPending(["declined"])).toEqual([
      { kind: "posted", projectId, terminal: "declined" },
    ]);
    const posted = await outboundOf(projectId);
    const declines = posted.filter(({ body }) => body.includes(DECLINE));
    expect(declines).toHaveLength(1);
    const [decline] = declines;
    expect(decline?.body).toMatch(/^Ashara declines the contract drafted from your tender as written\./);
    for (const id of ["G1", "G2"]) expect(decline?.body).toMatch(new RegExp(`^- ${id}: .* \\| verdict: not verified, `, "m"));
    for (const { body } of posted) {
      for (const proceeds of UNDER_WAY) expect(body).not.toContain(proceeds);
    }
    expect(await revisionsOf(projectId)).toEqual([]);
    expect(await workMayStart(projectId)).toEqual({ roster: false, firstPlan: false });
  });

  test("confirmed by the client as written stays declined: nothing is written, the note and the receipt say so, and no work item is created", async () => {
    const projectId = await readTender(["stored-data", "undecided"]);
    await rostered(projectId);

    answering({ correction: { ops: [], confirms: [] } });
    const change = await sendChange(projectId, "I confirm the contract as written.");
    expect(await liaison().runPending()).toEqual([{ kind: "recorded", changeId: change.id, projectId, confirmed: [], revision: { status: "unchanged" } }]);
    expect(await visionVersionsOf(projectId)).toEqual([1]);
    expect(await revisionsOf(projectId)).toEqual([]);
    const note = await noteOn(change.id);
    expect(note).toContain("Your message was read as asking for no change to the contract, so nothing in it changed.");
    expect(note).toContain(DECLINE);
    for (const body of [note, await receiptOn(change.id)]) {
      expect(body).toContain(DECLINE);
      for (const proceeds of UNDER_WAY) expect(body).not.toContain(proceeds);
    }

    expect(await workMayStart(projectId)).toEqual({ roster: false, firstPlan: false });
    expect(await createFirstPlanStore(db).projectsAwaitingPlan()).not.toContainEqual(expect.objectContaining({ projectId }));
    expect(await workItemsOf(projectId)).toBe(0);

    const [question] = (await outboundOf(projectId)).filter((m) => m.kind === "question");
    if (question === undefined) throw new Error(`project ${projectId}: no question posted`);
    const answer = await new ClientMessageRepository(db).insertInbound({ projectId, kind: "answer", body: "At most a thousand.", inReplyTo: question.id });
    const answerReceipt = await receiptOn(answer.id);
    expect(answerReceipt).toContain(DECLINE);
    for (const proceeds of UNDER_WAY) expect(answerReceipt).not.toContain(proceeds);
    answering({ reading: { verdict: "confirms", amends: [] } });
    expect(await answers().runPending()).toMatchObject([{ kind: "stated", projectId, answerId: answer.id, replanRequested: false }]);
    expect(await workMayStart(projectId)).toEqual({ roster: false, firstPlan: false });
    expect(await workItemsOf(projectId)).toBe(0);
  });

  test("restated by the client so Ashara can verify a guarantee is released: work may start, and the note no longer declines", async () => {
    const projectId = await readTender(["stored-data", "stored-data"]);
    expect(await workMayStart(projectId)).toEqual({ roster: false, firstPlan: false });

    answering({ correction: { ops: [restated("G1", "output")], confirms: [] } });
    const change = await sendChange(projectId, "You can check G1 by listing the entries.");
    expect(await liaison().runPending()).toEqual([
      { kind: "recorded", changeId: change.id, projectId, confirmed: [], revision: { status: "applied", visionVersion: 2, direction: "neutral" } },
    ]);
    const note = await noteOn(change.id);
    expect(note).toContain("Ashara can verify 1 of the 2 guarantees of this contract with the checks it can run today.");
    expect(note).not.toContain(DECLINE);
    expect(await workMayStart(projectId)).toEqual({ roster: true, firstPlan: false });
  });

  test("restated by the client still so that Ashara can verify none is declined again: no version is written and it stays declined", async () => {
    const projectId = await readTender(["stored-data", "stored-data"]);

    answering({ correction: { ops: [restated("G1", "stored-data")], confirms: [] } });
    const change = await sendChange(projectId, "G1 is about what is kept on disk.");
    expect(await liaison().runPending()).toEqual([{ kind: "recorded", changeId: change.id, projectId, confirmed: [], revision: { status: "declined" } }]);
    expect(await visionVersionsOf(projectId)).toEqual([1]);
    expect(await revisionsOf(projectId)).toEqual([]);
    const note = await noteOn(change.id);
    expect(note).toContain("This change is not made: it would leave your contract with no guarantee Ashara can verify as written");
    expect(note).toContain(DECLINE);
    expect(await workMayStart(projectId)).toEqual({ roster: false, firstPlan: false });
  });

  test("stays declined through a later version that leaves its guarantees as they were: a change that touches none, and an answer to the intake question", async () => {
    const projectId = await readTender(["stored-data", "stored-data"]);
    await rostered(projectId);

    answering({ correction: { ops: [{ op: "add-exclusion", text: "No export to CSV.", direction: "narrows" }], confirms: [] } });
    const change = await sendChange(projectId, "Leave out CSV export.");
    expect(await liaison().runPending()).toMatchObject([{ kind: "recorded", changeId: change.id, revision: { status: "applied", visionVersion: 2 } }]);
    const note = await noteOn(change.id);
    expect(note).toContain("Ashara can verify 0 of the 2 guarantees of this contract with the checks it can run today.");
    expect(note).toContain(DECLINE);
    expect(note).not.toContain("Work already planned continues meanwhile");
    expect(await workMayStart(projectId)).toEqual({ roster: false, firstPlan: false });

    const [question] = (await new ClientMessageRepository(db).listByProject(projectId)).filter((m) => m.kind === "question");
    if (question === undefined) throw new Error(`project ${projectId} has no intake question`);
    await new ClientMessageRepository(db).insertInbound({ projectId, kind: "answer", body: "Yes, up to a million.", inReplyTo: question.id });
    answering({ reading: { verdict: "confirms", amends: [] } });
    expect(await answers().runPending()).toMatchObject([{ kind: "stated", projectId, visionVersion: 3 }]);
    expect(await visionVersionsOf(projectId)).toEqual([1, 2, 3]);
    expect(await workMayStart(projectId)).toEqual({ roster: false, firstPlan: false });
    expect(await workItemsOf(projectId)).toBe(0);
  });

  // A contract stored before guarantees carried the mark was never told the client as unverifiable, so
  // it stays unmarked through every later version that carries its guarantees over, and is never declined.
  test("stored before the mark is never declined by a later version that carries its guarantees over: a change touching none, and an answer", async () => {
    const projectId = await readTender(["stored-data", "stored-data"]);
    await db.execute(sql`
      UPDATE vision_documents SET guarantees = (
        SELECT jsonb_agg(g - 'verification' - 'unverifiableBecause' ORDER BY i) FROM jsonb_array_elements(guarantees) WITH ORDINALITY AS t(g, i))
      WHERE project_id = ${projectId}`);
    expect(await workMayStart(projectId)).toEqual({ roster: true, firstPlan: false });

    answering({ correction: { ops: [{ op: "add-exclusion", text: "No export to CSV.", direction: "narrows" }], confirms: [] } });
    const change = await sendChange(projectId, "Leave out CSV export.");
    expect(await liaison().runPending()).toMatchObject([{ kind: "recorded", changeId: change.id, revision: { status: "applied", visionVersion: 2 } }]);
    expect((await guaranteesOf(projectId, 2)).map((g) => g.verification)).toEqual([undefined, undefined]);
    expect(await noteOn(change.id)).not.toContain(DECLINE);
    expect(await receiptOn(change.id)).not.toContain(DECLINE);

    const [question] = (await new ClientMessageRepository(db).listByProject(projectId)).filter((m) => m.kind === "question");
    if (question === undefined) throw new Error(`project ${projectId} has no intake question`);
    await new ClientMessageRepository(db).insertInbound({ projectId, kind: "answer", body: "Yes, up to a million.", inReplyTo: question.id });
    answering({ reading: { verdict: "confirms", amends: [] } });
    expect(await answers().runPending()).toMatchObject([{ kind: "stated", projectId, visionVersion: 3 }]);
    expect((await guaranteesOf(projectId, 3)).map((g) => g.verification)).toEqual([undefined, undefined]);
    expect(await workMayStart(projectId)).toEqual({ roster: true, firstPlan: false });
  });

  test("that a client's change would write is declined, not held for confirmation, and the version in force stays", async () => {
    const projectId = await readTender(["output", "stored-data"]);
    expect(await contractDraftOf(projectId)).toContain("Ashara can verify 1 of the 2 guarantees of this contract with the checks it can run today.");
    expect(await contractDraftOf(projectId)).not.toContain(DECLINE);

    answering({ correction: { ops: [restated("G1", "stored-data")], confirms: [] } });
    const change = await sendChange(projectId, "G1 is about what is kept on disk.");
    expect(await liaison().runPending()).toEqual([{ kind: "recorded", changeId: change.id, projectId, confirmed: [], revision: { status: "declined" } }]);
    expect(await visionVersionsOf(projectId)).toEqual([1]);
    expect(await revisionsOf(projectId)).toEqual([]);
    const note = await noteOn(change.id);
    expect(note).toContain("This change is not made: it would leave your contract with no guarantee Ashara can verify as written");
    expect(note).toContain("confirming this change or sending it again as it is does not make it.");
    expect(note).toContain("As this change would have left it: Ashara can verify 0 of the 2 guarantees of this contract with the checks it can run today.");
    // The contract in force is one Ashara can verify, so the note does not decline it.
    expect(note).not.toContain(DECLINE);
  });
});

describe("a drafter's undecided observation", () => {
  test("is recorded undecided, never stored-data or not verifiable, and put to the client", async () => {
    const projectId = await readTender(["output", "undecided"]);
    expect(await guaranteesOf(projectId, 1)).toEqual([
      { id: "G1", observation: "output", verification: "by-ashara", because: undefined },
      { id: "G2", observation: "undecided", verification: "undecided", because: undefined },
    ]);
    const draft = await contractDraftOf(projectId);
    expect(draft).toContain(
      "- G2: Entries survive a restart. (basis: what your tender states; Ashara could not tell where you would see it hold or break, so it does not count it as one it can verify " +
        "and it cannot be shown to hold; tell us where you would see it and Ashara can check it)",
    );
    expect(draft).not.toMatch(/- G2: [^\n]*not verifiable by Ashara/);
    expect(draft).not.toMatch(/- G1: [^\n]*could not tell/);

    // A change whose reading cannot tell either is recorded and told the same way.
    const added = {
      op: "add-guarantee",
      statement: "An entry keeps the time it was recorded.",
      interface: ["I1"],
      observation: "undecided",
      refutedBy: ["a listed entry shows no time"],
      direction: "widens",
    };
    answering({ correction: { ops: [added], confirms: [] } });
    const change = await sendChange(projectId, "Keep the time of each entry.");
    expect(await liaison().runPending()).toMatchObject([{ kind: "recorded", changeId: change.id, revision: { status: "applied", visionVersion: 2 } }]);
    expect((await guaranteesOf(projectId, 2)).at(-1)).toEqual({ id: "G3", observation: "undecided", verification: "undecided", because: undefined });
    const note = await noteOn(change.id);
    expect(note).toContain("Add a guarantee: An entry keeps the time it was recorded. (Ashara could not tell where you would see it hold or break");
    expect(note).toContain("Ashara can verify 1 of the 3 guarantees of this contract with the checks it can run today.");
  });

  test("counted openly at intake: a contract whose every observation is undecided is declined, each guarantee put to the client", async () => {
    const projectId = await readTender(["undecided", "undecided"]);
    expect(await guaranteesOf(projectId, 1)).toEqual([
      { id: "G1", observation: "undecided", verification: "undecided", because: undefined },
      { id: "G2", observation: "undecided", verification: "undecided", because: undefined },
    ]);
    const draft = await contractDraftOf(projectId);
    expect(draft).toContain(NOT_STARTED);
    expect(draft.match(/Ashara could not tell where you would see it hold or break/g)).toHaveLength(2);
    expect(await workMayStart(projectId)).toEqual({ roster: false, firstPlan: false });
  });
});

describe("a guarantee marked not verifiable by Ashara", () => {
  test("carries its stated reason in the contract and in the proposal", async () => {
    const projectId = await readTender(["output", "stored-data"]);
    expect(await guaranteesOf(projectId, 1)).toEqual([
      { id: "G1", observation: "output", verification: "by-ashara", because: undefined },
      { id: "G2", observation: "stored-data", verification: "not-by-ashara", because: "outside-interface" },
    ]);
    expect(await contractDraftOf(projectId)).toContain("- G2: Entries survive a restart. (basis: what your tender states; not verifiable by Ashara: it is seen only outside what the product's interface shows");
  });
});
