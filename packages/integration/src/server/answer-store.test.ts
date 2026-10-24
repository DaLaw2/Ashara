import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { ClientRepository, createDb, resolveTestDatabaseUrl } from "@ashara/db";
import type { Database } from "@ashara/db";
import { LlmCallRepository } from "@ashara/finance";
import { ClientAnswers, ClientReceipts, TenderIntake, ClientMessageRepository, createProjectWithTender } from "@ashara/engagement";
import type { AnswerStore, IntakeStore } from "@ashara/engagement";
import { BudgetExceeded, GuardedModelAccess, LlmCallLedger, SPEND_CAP_ERROR_CLASS, SpendCap } from "@ashara/finance";
import { buildGateway, sdkLanguageModels } from "@ashara/model-access";
import type { ModelConfig } from "@ashara/model-access";
import { RosterDerivation } from "@ashara/organization";
import type { RosterStore } from "@ashara/organization";
import { FirstPlanner, ProjectHaltRepository, createFirstPlanStore, stepContainment } from "@ashara/delivery";
import type { FirstPlanStore } from "@ashara/delivery";
import { systemClock, type ProjectId } from "@ashara/shared";
import { recordingLogger } from "@ashara/shared/testing";
import type { StepContainment } from "@ashara/shared";
import { createAnswerStore } from "@ashara/server/answer-store";
import { createClientReceiptStore } from "@ashara/server/client-receipt-store";
import { createIntakeStore } from "@ashara/server/intake-store";
import { createRosterStore } from "@ashara/server/roster-store";
import { citingItemsToCheck } from "../simulator/stand-ins/planner.js";

// Every row here belongs to a project this suite creates under a unique name, and
// afterAll deletes exactly those rows. Each store is narrowed to this suite's
// projects. No real LLM call is made: the provider factory returns a MockLanguageModelV4.

const stub = vi.hoisted(() => ({ model: undefined as unknown }));
vi.mock("@ai-sdk/deepseek", () => ({ createDeepSeek: () => () => stub.model }));

const DATABASE_URL = resolveTestDatabaseUrl(process.env);
const TEST_SPEND_CAPS = { deploymentUsd: 1_000_000, perProjectUsd: 1_000_000 };
const NAME_PREFIX = `client-answer-test-${randomUUID().slice(0, 8)}`;

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

function jsonResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    usage: {
      inputTokens: { total: 500, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 200, text: 200, reasoning: undefined },
    },
    finishReason: { unified: "stop" as const, raw: "stop" },
    warnings: [],
  };
}

const INTAKE = {
  summary: "A booking page for the client's two pottery studios.",
  interface: [{ id: "I1", text: "The booking page.", source: { kind: "tender", quote: "Booking page" } }],
  guarantees: [
    {
      id: "G1",
      statement: "A client books a class at either studio.",
      observable: { interface: ["I1"], observation: "output" },
      refutedBy: ["A booking at either studio is refused."],
      source: { kind: "tender", quote: "Booking page for my two pottery studios." },
    },
  ],
  assumptions: [{ id: "A3", statement: "Bookings need no account.", rationale: "The tender says walk-in customers book.", kind: "client-visible", underpins: ["G1"] }],
  questions: [
    {
      text: "Which studio opens first?",
      whyItMatters: "It orders the work.",
      assumption: { id: "A1", statement: "The harbour studio opens first.", rationale: "The tender names it first.", kind: "client-visible", underpins: ["G1"] },
    },
    {
      text: "How many seats does a class have?",
      whyItMatters: "It sets the booking limit.",
      assumption: { id: "A2", statement: "A class has twelve seats.", rationale: "The tender mentions a dozen wheels.", kind: "client-visible", underpins: ["G1"] },
    },
  ],
  exclusions: [],
};

const ROSTER = {
  roles: [
    { name: "Liaison", responsibility: "Talks to the studio owner.", capabilities: ["client-comms"] },
    { name: "Platform", responsibility: "Defines how the page is built and tested.", capabilities: ["write-environment"] },
    { name: "Implementer", responsibility: "Builds the booking page.", capabilities: ["write-source"] },
    { name: "Check author", responsibility: "Writes the checks the page must pass.", capabilities: ["author-checks"] },
  ],
};

const TASKS = {
  tasks: [
    {
      ref: "t1", title: "Create the class list", description: "List classes.", dependsOn: [], goal: "",
      endState: "Classes are listed", scope: "class listing", deliverables: [{ text: "class list", sources: ["G1"] }], acceptance: [{ text: "a client uses the class list", sources: ["G1"] }],
      capability: "Medium", capabilityReason: "graded for the test",
    },
  ],
};

/**
 * One model for every call of the pipeline, answering each by what its prompt asks:
 * intake, roster, the tasks, and the answer reading.
 */
function pipelineModel(reading: unknown): MockLanguageModelV4 {
  const mock = new MockLanguageModelV4({
    doGenerate: async (options) => {
      const prompt = JSON.stringify(options.prompt);
      if (prompt.includes("Read their answer and say what it does")) return jsonResult({ reading });
      if (prompt.includes("prepare the first version of the project's vision")) return jsonResult(INTAKE);
      if (prompt.includes("client-comms")) return jsonResult(ROSTER);
      return jsonResult(citingItemsToCheck(TASKS, prompt));
    },
  });
  stub.model = mock;
  return mock;
}

function ours<T extends { readonly projectId: string }>(list: () => Promise<readonly T[]>): () => Promise<T[]> {
  return async () => (await list()).filter((row) => ourProjects.has(row.projectId));
}

/** The cycle's containment, as the composition root supplies it; a spend-cap refusal escapes. */
function containment(): StepContainment {
  return stepContainment(db, systemClock, (error) => error instanceof BudgetExceeded, recordingLogger());
}

function answers(): ClientAnswers {
  const store = createAnswerStore(db);
  const narrowed: AnswerStore = { ...store, openAnswers: ours(() => store.openAnswers()) };
  return new ClientAnswers({ shutdownSignal: new AbortController().signal, containment: containment(), llm: gateway, store: narrowed });
}

function intake(): TenderIntake {
  const store = createIntakeStore(db);
  const narrowed: IntakeStore = { ...store, openTenders: ours(() => store.openTenders()) };
  return new TenderIntake({ shutdownSignal: new AbortController().signal, containment: containment(), llm: gateway, store: narrowed });
}

function roster(): RosterDerivation {
  const store = createRosterStore(db);
  const narrowed: RosterStore = { ...store, projectsAwaitingRoster: ours(() => store.projectsAwaitingRoster()) };
  return new RosterDerivation({ shutdownSignal: new AbortController().signal, containment: containment(), llm: gateway, store: narrowed });
}

function planner(): FirstPlanner {
  const store = createFirstPlanStore(db);
  const narrowed: FirstPlanStore = { ...store, projectsAwaitingPlan: ours(() => store.projectsAwaitingPlan()) };
  return new FirstPlanner({ shutdownSignal: new AbortController().signal, logger: recordingLogger(), containment: containment(), llm: gateway, store: narrowed });
}

/** A tender taken in: vision v1 with A1 and A2 adopted by the two questions, A3 unasked. */
async function intakenProject(): Promise<{ projectId: ProjectId; tenderId: string; questionIds: string[] }> {
  const created = await createProjectWithTender(db, clientId, `${NAME_PREFIX}-${randomUUID().slice(0, 6)}`, "Booking page for my two pottery studios.");
  ourProjects.add(created.project.id);
  pipelineModel({ verdict: "confirms", amends: [] });
  expect((await intake().runPending()).map((o) => o.kind)).toEqual(["recorded"]);
  const questions = (await new ClientMessageRepository(db).listByProject(created.project.id)).filter((m) => m.kind === "question");
  return { projectId: created.project.id, tenderId: created.message.id, questionIds: questions.map((q) => q.id) };
}

async function answer(projectId: ProjectId, questionId: string, body: string): Promise<string> {
  const row = await new ClientMessageRepository(db).insertInbound({ projectId, kind: "answer", body, inReplyTo: questionId });
  return row.id;
}

const InferenceSchema = z.looseObject({
  key: z.string(),
  statement: z.string(),
  status: z.string(),
  clientAnswer: z
    .object({ messageId: z.string(), questionMessageId: z.string(), question: z.string(), answer: z.string(), verdict: z.string().optional() })
    .optional(),
});
const VisionRowSchema = z.object({
  version: z.number(),
  inferences: z.array(InferenceSchema),
  openQuestions: z.array(z.looseObject({ messageId: z.string() })),
  changeReason: z.string().nullable(),
});

async function visionsOf(projectId: ProjectId) {
  const result = await db.execute(sql`
    SELECT version, inferences, open_questions AS "openQuestions", change_reason AS "changeReason"
    FROM vision_documents WHERE project_id = ${projectId} ORDER BY version`);
  return z.array(VisionRowSchema).parse(result.rows);
}

/** The kind of the project's open block episode, or null when it is not halted. */
async function haltKindOf(projectId: ProjectId): Promise<string | null> {
  const result = await db.execute(sql`SELECT kind FROM project_blocks WHERE project_id = ${projectId} AND ended_at IS NULL`);
  return z.array(z.object({ kind: z.string() })).parse(result.rows)[0]?.kind ?? null;
}

/** The answer's count of failed readings, and whether the last reading's error is kept on record. */
async function attemptsOf(answerId: string): Promise<{ attempts: number; kept: boolean }> {
  const stored = await db.execute(sql`SELECT intake_attempts AS "attempts", intake_last_error IS NOT NULL AS "kept" FROM client_messages WHERE id = ${answerId}`);
  const [row] = z.array(z.object({ attempts: z.number(), kept: z.boolean() })).length(1).parse(stored.rows);
  if (row === undefined) throw new Error(`no client message ${answerId}`);
  return row;
}

/** The client messages whose correction's plan revision the project awaits (correction_holds), oldest first. */
async function awaitedChangesOf(projectId: ProjectId): Promise<string[]> {
  const result = await db.execute(sql`
    SELECT requested_by AS "answerId" FROM correction_holds WHERE project_id = ${projectId} AND plan_revision_id IS NULL ORDER BY created_at`);
  return z.array(z.object({ answerId: z.string() })).parse(result.rows).map((row) => row.answerId);
}

/** Model access through the stub provider under `caps`. */
function modelAccess(caps: typeof TEST_SPEND_CAPS): GuardedModelAccess {
  return new GuardedModelAccess(buildGateway({
    models: sdkLanguageModels,
    config: {
      providers: [
        {
          name: "deepseek",
          providerType: "deepseek",
          apiKey: "test-key",
          baseUrl: "https://stub.invalid/v1",
          models: [model("answer-strong", "Strong"), model("answer-frontier", "Frontier")],
          enabled: true,
        },
      ],
      defaultProvider: "deepseek",
      contextOverflow: { statuses: [400], codes: ["context_length_exceeded"], phrases: [] },
    },
    checkedSources: ["test"],
    clock: () => new Date(),
  }), new LlmCallLedger(
    new LlmCallRepository(db),
    new SpendCap({ ledger: new LlmCallRepository(db), caps }),
  ), recordingLogger());
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  clientId = (await new ClientRepository(db).create(`${NAME_PREFIX}-client`)).id;
  gateway = modelAccess(TEST_SPEND_CAPS);
});

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  ourProjects.clear();
});

afterAll(async () => {
  const pattern = `${NAME_PREFIX}%`;
  const projects = sql`SELECT id FROM projects WHERE name LIKE ${pattern}`;
  await db.execute(sql`DELETE FROM correction_holds WHERE project_id IN (${projects})`);
  await db.execute(sql`DELETE FROM llm_calls WHERE project_id IN (${projects})`);
  await db.execute(sql`DELETE FROM work_items WHERE project_id IN (${projects})`);
  await db.execute(sql`DELETE FROM roster_roles WHERE project_id IN (${projects})`);
  await db.execute(sql`DELETE FROM vision_documents WHERE project_id IN (${projects})`);
  // Replies before what they reply to: a report replies to an answer, which replies to a question.
  await db.execute(sql`DELETE FROM client_messages WHERE direction = 'outbound' AND kind = 'report' AND project_id IN (${projects})`);
  await db.execute(sql`DELETE FROM client_messages WHERE kind = 'answer' AND project_id IN (${projects})`);
  await db.execute(sql`DELETE FROM client_messages WHERE in_reply_to IS NOT NULL AND project_id IN (${projects})`);
  await db.execute(sql`DELETE FROM client_messages WHERE project_id IN (${projects})`);
  await db.execute(sql`DELETE FROM projects WHERE name LIKE ${pattern}`);
  await db.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
  await db.$client.end();
});

describe("the client's answers", () => {
  test("an answer confirming A2 appends a vision version with A2 Stated, the answer as provenance, and is consumed once", async () => {
    const { projectId, questionIds } = await intakenProject();
    const [first, second] = questionIds;
    if (first === undefined || second === undefined) throw new Error("intake posted fewer than two questions");
    const answerId = await answer(projectId, second, "Yes, twelve seats.");
    pipelineModel({ verdict: "confirms", amends: [] });

    const outcomes = await answers().runPending();

    expect(outcomes).toEqual([
      { kind: "stated", answerId, projectId, assumptionKey: "A2", restatedKeys: [], verdict: "confirms", visionVersion: 2, replanRequested: false },
    ]);
    const [v1, v2, ...rest] = await visionsOf(projectId);
    expect(rest).toHaveLength(0);
    // Append-only: v1 still reads as intake wrote it.
    expect(v1?.inferences.find((a) => a.key === "A2")?.status).toBe("Inferred");
    expect(v2?.inferences.find((a) => a.key === "A2")).toMatchObject({
      statement: "A class has twelve seats.",
      status: "Stated",
      clientAnswer: { messageId: answerId, questionMessageId: second, answer: "Yes, twelve seats.", verdict: "confirms" },
    });
    expect(v2?.inferences.filter((a) => a.status === "Inferred").map((a) => a.key)).toEqual(["A1", "A3"]);
    expect(v2?.openQuestions.map((q) => q.messageId)).toEqual([first]);
    expect(v2?.changeReason).toContain(answerId);
    expect((await new ClientMessageRepository(db).findById(answerId))?.consumedAt).toBeInstanceOf(Date);

    const again = pipelineModel({ verdict: "confirms", amends: [] });
    expect(await answers().runPending()).toEqual([]);
    expect(again.doGenerateCalls).toHaveLength(0);
    expect(await visionsOf(projectId)).toHaveLength(2);
  });

  test("a project with an unread answer is not planned until it is read, and the plan carries the answer as a clarification", async () => {
    const { projectId, questionIds } = await intakenProject();
    const [, second] = questionIds;
    if (second === undefined) throw new Error("intake posted no second question");
    pipelineModel({ verdict: "confirms", amends: [] });
    expect((await roster().runPending()).map((o) => o.kind)).toEqual(["recorded"]);
    await answer(projectId, second, "Eight seats, not twelve.");

    expect(await planner().runPending()).toEqual([]);

    pipelineModel({ verdict: "changes", statement: "A class has eight seats.", kind: "client-visible", amends: [] });
    expect((await answers().runPending()).map((o) => o.kind)).toEqual(["stated"]);
    const mock = pipelineModel({ verdict: "confirms", amends: [] });
    expect((await planner().runPending()).map((o) => o.kind)).toEqual(["planned"]);

    const prompts = mock.doGenerateCalls.map((call) => JSON.stringify(call.prompt));
    expect(prompts.some((p) => p.includes("Client clarifications") && p.includes("How many seats does a class have? -> Eight seats, not twelve."))).toBe(true);
    expect(prompts.some((p) => p.includes("A class has twelve seats."))).toBe(false);
    // Before the first plan a changed assumption needs no replanning.
    expect(await awaitedChangesOf(projectId)).toEqual([]);
  });

  test("an answer after the first plan that changes an assumption it was built on is reported once and holds the work citing it or a guarantee resting on it", async () => {
    const { projectId, tenderId, questionIds } = await intakenProject();
    const [first] = questionIds;
    if (first === undefined) throw new Error("intake posted no question");
    pipelineModel({ verdict: "confirms", amends: [] });
    expect((await roster().runPending()).map((o) => o.kind)).toEqual(["recorded"]);
    expect((await planner().runPending()).map((o) => o.kind)).toEqual(["planned"]);
    const projectRepo = new ProjectHaltRepository(db);
    // The plan is dispatched once the client is told it.
    expect(await projectRepo.listActiveIds()).not.toContain(projectId);
    await db.execute(sql`
      INSERT INTO client_messages (project_id, direction, kind, body, reports_on)
      VALUES (${projectId}, 'outbound', 'report', 'The plan.', 'first-plan')`);
    expect(await projectRepo.listActiveIds()).toContain(projectId);

    const answerId = await answer(projectId, first, "No, the hill studio opens first.");
    pipelineModel({ verdict: "changes", statement: "The hill studio opens first.", kind: "internal-design", amends: [] });
    const outcomes = await answers().runPending();

    expect(outcomes).toEqual([
      { kind: "stated", answerId, projectId, assumptionKey: "A1", restatedKeys: [], verdict: "changes", visionVersion: 2, replanRequested: true },
    ]);
    expect((await visionsOf(projectId))[1]?.inferences.find((a) => a.key === "A1")).toMatchObject({
      statement: "The hill studio opens first.",
      status: "Stated",
      // The changed decision is classified again, never carried over from the one it replaced.
      kind: "internal-design",
      clientAnswer: { messageId: answerId, verdict: "changes" },
    });
    expect(await awaitedChangesOf(projectId)).toEqual([answerId]);
    // The work citing A1 or G1, which A1 underpinned, is held: the review, which cites every item, and
    // the task citing G1 alone are parked, and the project still dispatches.
    expect(await projectRepo.listActiveIds()).toContain(projectId);
    const tasks = await db.execute(sql`
      SELECT task_spec->>'origin' AS origin, status, blocked_reason->>'source' AS source FROM work_items
      WHERE project_id = ${projectId} AND task_spec->>'origin' IN ('review', 'decomposition') ORDER BY task_spec->>'origin'`);
    expect(tasks.rows).toEqual([
      { origin: "decomposition", status: "Blocked", source: "correction_pending" },
      { origin: "review", status: "Blocked", source: "correction_pending" },
    ]);
    // Beside intake's report of the unasked assumptions, in reply to the tender,
    // and the first-plan report, in reply to nothing.
    const reports = (await new ClientMessageRepository(db).listByProject(projectId)).filter(
      (m) => m.kind === "report" && m.inReplyTo !== tenderId && m.inReplyTo !== null,
    );
    expect(reports).toHaveLength(1);
    expect(reports[0]?.inReplyTo).toBe(answerId);
    expect(reports[0]?.body).toContain("The plan assumed: The harbour studio opens first.");
    expect(reports[0]?.body).toContain("Work now proceeds on: The hill studio opens first.");
    expect(reports[0]?.body).toContain("you will be told what changes");
    expect(await answers().runPending()).toEqual([]);
  });

  // Doubt classifies toward a check.
  test("a changed decision the model classes undecided is recorded client-visible", async () => {
    const { projectId, questionIds } = await intakenProject();
    const [, second] = questionIds;
    if (second === undefined) throw new Error("intake posted no second question");
    await answer(projectId, second, "Eight seats, not twelve.");
    pipelineModel({ verdict: "changes", statement: "A class has eight seats.", kind: "undecided", amends: [] });
    expect((await answers().runPending()).map((o) => o.kind)).toEqual(["stated"]);
    expect((await visionsOf(projectId))[1]?.inferences.find((a) => a.key === "A2")).toMatchObject({
      statement: "A class has eight seats.",
      kind: "client-visible",
    });
  });

  test("the answer prompt states the fail-safe classification rule", async () => {
    const { projectId, questionIds } = await intakenProject();
    const [first] = questionIds;
    if (first === undefined) throw new Error("intake posted no question");
    await answer(projectId, first, "Yes, harbour first.");
    const mock = pipelineModel({ verdict: "confirms", amends: [] });
    await answers().runPending();
    const prompt = mock.doGenerateCalls.map((call) => JSON.stringify(call.prompt)).find((p) => p.includes("Read their answer")) ?? "";
    expect(prompt).toContain("in its exit status, or in the data the client stores with it");
    expect(prompt).toContain("you cannot tell whether a client could observe a breach. It is recorded as");
  });

  test("an answer after the first plan that confirms its assumption is Stated without replanning", async () => {
    const { projectId, tenderId, questionIds } = await intakenProject();
    const [first] = questionIds;
    if (first === undefined) throw new Error("intake posted no question");
    pipelineModel({ verdict: "confirms", amends: [] });
    await roster().runPending();
    expect((await planner().runPending()).map((o) => o.kind)).toEqual(["planned"]);

    await answer(projectId, first, "Yes, harbour first.");
    pipelineModel({ verdict: "confirms", amends: [] });
    expect((await answers().runPending()).map((o) => o.kind === "stated" && o.replanRequested)).toEqual([false]);
    expect(await awaitedChangesOf(projectId)).toEqual([]);
    expect(
      (await new ClientMessageRepository(db).listByProject(projectId)).filter((m) => m.kind === "report" && m.inReplyTo !== tenderId),
    ).toHaveLength(0);
  });

  test("two answers of one project in one cycle: each is read against the vision as the other left it", async () => {
    const { projectId, questionIds } = await intakenProject();
    const [first, second] = questionIds;
    if (first === undefined || second === undefined) throw new Error("intake posted fewer than two questions");
    const firstAnswer = await answer(projectId, first, "Yes, harbour first.");
    const secondAnswer = await answer(projectId, second, "Yes, twelve seats.");
    const mock = pipelineModel({ verdict: "confirms", amends: [] });

    const outcomes = await answers().runPending();

    expect(outcomes).toEqual([
      { kind: "stated", answerId: firstAnswer, projectId, assumptionKey: "A1", restatedKeys: [], verdict: "confirms", visionVersion: 2, replanRequested: false },
      { kind: "stated", answerId: secondAnswer, projectId, assumptionKey: "A2", restatedKeys: [], verdict: "confirms", visionVersion: 3, replanRequested: false },
    ]);
    // One paid reading per answer: none was discarded.
    expect(mock.doGenerateCalls).toHaveLength(2);
    const v3 = (await visionsOf(projectId))[2];
    expect(v3?.inferences.filter((a) => a.status === "Stated").map((a) => a.key)).toEqual(["A1", "A2"]);
    expect(v3?.openQuestions).toEqual([]);
  });

  test("a vision version written between the reading and its write: composed again on it, the reading not paid for twice", async () => {
    const { projectId, questionIds } = await intakenProject();
    const [, second] = questionIds;
    if (second === undefined) throw new Error("intake posted no second question");
    const answerId = await answer(projectId, second, "Yes, twelve seats.");
    const mock = pipelineModel({ verdict: "confirms", amends: [] });
    const store = createAnswerStore(db);
    let raced = false;
    const racing: AnswerStore = {
      ...store,
      openAnswers: ours(() => store.openAnswers()),
      recordAnswer: async (write) => {
        if (!raced) {
          raced = true;
          // Another writer appends a version that leaves this question and its assumption as they were.
          await db.execute(sql`
            INSERT INTO vision_documents (project_id, version, vision_text, summary, inferences, scope_boundaries,
                                          confirmed_directions, open_questions, change_reason,
                                          contract_form, "interface", guarantees, exclusions)
            SELECT project_id, version + 1, vision_text, summary, inferences, scope_boundaries, confirmed_directions,
                   open_questions, 'a concurrent writer', contract_form, "interface", guarantees, exclusions
              FROM vision_documents WHERE project_id = ${projectId} ORDER BY version DESC LIMIT 1`);
        }
        return store.recordAnswer(write);
      },
    };

    const outcomes = await new ClientAnswers({ shutdownSignal: new AbortController().signal, containment: containment(), llm: gateway, store: racing }).runPending();

    expect(outcomes).toEqual([
      { kind: "stated", answerId, projectId, assumptionKey: "A2", restatedKeys: [], verdict: "confirms", visionVersion: 3, replanRequested: false },
    ]);
    expect(mock.doGenerateCalls).toHaveLength(1);
    expect((await visionsOf(projectId)).map((v) => v.version)).toEqual([1, 2, 3]);
    expect((await visionsOf(projectId))[1]?.changeReason).toBe("a concurrent writer");
  });

  test("an answer that cannot be read three times leaves it unconsumed and blocks the project", async () => {
    const { projectId, questionIds } = await intakenProject();
    const [first] = questionIds;
    if (first === undefined) throw new Error("intake posted no question");
    const answerId = await answer(projectId, first, "Harbour.");
    pipelineModel({ verdict: "maybe" });

    const kinds: string[] = [];
    for (let i = 0; i < 3; i++) for (const outcome of await answers().runPending()) kinds.push(outcome.kind);

    expect(kinds).toEqual(["failed", "failed", "project-blocked"]);
    expect((await new ProjectHaltRepository(db).get(projectId))?.status).toBe("blocked");
    // Blamed by the one classifier: the model never answered in the schema, so the halt is the model's, not Ashara's.
    expect(await haltKindOf(projectId)).toBe("model_failed");
    expect((await new ClientMessageRepository(db).findById(answerId))?.consumedAt).toBeNull();
    expect(await visionsOf(projectId)).toHaveLength(1);
  });

  test("an answer whose readings ran out on a project at work is read afresh after the operator unblocks, not halted again", async () => {
    const { projectId, questionIds } = await intakenProject();
    const [first] = questionIds;
    if (first === undefined) throw new Error("intake posted no question");
    const answerId = await answer(projectId, first, "Harbour.");
    const mock = pipelineModel({ verdict: "maybe" });
    for (let i = 0; i < 3; i++) await answers().runPending();
    expect(await haltKindOf(projectId)).toBe("model_failed");
    // The count stands while the halt lasts.
    expect(await attemptsOf(answerId)).toEqual({ attempts: 3, kept: true });
    const calls = mock.doGenerateCalls.length;
    // Not read under the model's halt: no reading paid for, no attempt charged.
    for (let i = 0; i < 3; i++) expect(await answers().runPending()).toEqual([]);
    expect(mock.doGenerateCalls).toHaveLength(calls);

    await new ProjectHaltRepository(db).unblock(projectId, "operator-a", "looked at the answer");
    // The unblock set the count back to none, the last error kept on record.
    expect(await attemptsOf(answerId)).toEqual({ attempts: 0, kept: true });
    pipelineModel({ verdict: "confirms", amends: [] });
    expect((await answers().runPending()).map((outcome) => outcome.kind)).toEqual(["stated"]);
    expect(await haltKindOf(projectId)).toBeNull();
  });

  test.each(["plan_repair", "check_dispute", "suite_review", "fault", "infrastructure"] as const)(
    "an answer whose readings ran out under a %s halt keeps its count while that halt lasts, unread; the halt's end sets it back to none, and the next cycle reads it with the model before any halt of its own",
    async (category) => {
      const { projectId, questionIds } = await intakenProject();
      const [first] = questionIds;
      if (first === undefined) throw new Error("intake posted no question");
      const projects = new ProjectHaltRepository(db);
      expect(await projects.block(projectId, { category, errorClass: "ScriptedHalt", reason: `halted on ${category} by the test` })).toBe("blocked");
      const answerId = await answer(projectId, first, "Harbour.");
      const mock = pipelineModel({ verdict: "maybe" });
      const kinds: string[] = [];
      for (let i = 0; i < 3; i++) for (const outcome of await answers().runPending()) kinds.push(outcome.kind);
      expect(kinds).toEqual(["failed", "failed", "project-blocked"]);
      expect(await haltKindOf(projectId)).toBe(category);
      expect(await attemptsOf(answerId)).toEqual({ attempts: 3, kept: true });
      const calls = mock.doGenerateCalls.length;
      for (let i = 0; i < 3; i++) expect(await answers().runPending()).toEqual([]);
      expect(mock.doGenerateCalls).toHaveLength(calls);

      if (category === "infrastructure") {
        // The probe ends only a halt whose report the client has been told.
        const report = await new ClientMessageRepository(db).insertOutbound({ projectId, kind: "report", body: "Work on this project is paused.", inReplyTo: null });
        await db.execute(sql`INSERT INTO told_reports (subject_kind, subject_id, project_id, report_id)
          SELECT 'project-blocked', b.id, b.project_id, ${report.id} FROM project_blocks b WHERE b.project_id = ${projectId} AND b.ended_at IS NULL`);
        expect(await projects.resumeFromInfrastructureHalt(projectId, "the substrate answered")).toBe("resumed");
      } else {
        await projects.unblock(projectId, "operator-a", "repaired the cause");
      }
      expect(await attemptsOf(answerId)).toEqual({ attempts: 0, kept: true });
      const outcomes = await answers().runPending();
      expect(outcomes.map((outcome) => [outcome.kind, "attempt" in outcome ? outcome.attempt : null])).toEqual([["failed", 1]]);
      expect(mock.doGenerateCalls.length).toBeGreaterThan(calls);
      expect(await haltKindOf(projectId)).toBeNull();
    },
  );

  test("an answer no record can take, under a halt already open, writes no block and warns nothing each cycle, and halts the project under its own cause once the halt ends", async () => {
    const { projectId, questionIds } = await intakenProject();
    const [first] = questionIds;
    if (first === undefined) throw new Error("intake posted no question");
    // A vision whose open question names an assumption it does not hold: no reading of the answer can be recorded against it.
    await db.execute(sql`UPDATE vision_documents SET open_questions = jsonb_build_array(jsonb_build_object('messageId', ${first}::text, 'text', 'Which studio?', 'assumptionKey', 'A99')) WHERE project_id = ${projectId}`);
    expect(await new ProjectHaltRepository(db).block(projectId, { category: "plan_repair", errorClass: "PlanRepairBound", reason: "repaired its bound of times" })).toBe("blocked");
    const answerId = await answer(projectId, first, "Harbour.");
    const mock = pipelineModel({ verdict: "confirms", amends: [] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    warn.mockClear();

    for (let i = 0; i < 3; i++) expect((await answers().runPending()).map((outcome) => outcome.kind)).toEqual(["waits-for-halt"]);
    expect(warn).not.toHaveBeenCalled();
    expect(mock.doGenerateCalls).toHaveLength(0);
    expect(await haltKindOf(projectId)).toBe("plan_repair");

    await new ProjectHaltRepository(db).unblock(projectId, "operator-a", "repaired the plan");
    expect((await answers().runPending()).map((outcome) => outcome.kind)).toEqual(["project-blocked"]);
    const blocks = await db.execute(sql`SELECT kind, error_class AS "errorClass" FROM project_blocks WHERE project_id = ${projectId} AND ended_at IS NULL`);
    expect(blocks.rows).toEqual([{ kind: "fault", errorClass: "AnswerVisionUnusable" }]);
    expect(await attemptsOf(answerId)).toEqual({ attempts: 0, kept: false });
  });

  test("an answer to a question an earlier answer closed is consumed unread with a notice to the client, and blocks nothing", async () => {
    const { projectId, questionIds } = await intakenProject();
    const [first] = questionIds;
    if (first === undefined) throw new Error("intake posted no question");
    await db.execute(sql`UPDATE vision_documents SET open_questions = '[]'::jsonb WHERE project_id = ${projectId}`);
    const answerId = await answer(projectId, first, "Harbour.");
    const mock = pipelineModel({ verdict: "confirms", amends: [] });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    expect((await answers().runPending()).map((outcome) => outcome.kind)).toEqual(["question-closed"]);
    expect(mock.doGenerateCalls).toHaveLength(0);
    const consumed = await db.execute(sql`SELECT consumed_at IS NOT NULL AS consumed FROM client_messages WHERE id = ${answerId}`);
    expect(consumed.rows).toEqual([{ consumed: true }]);
    const notices = await db.execute(sql`
      SELECT in_reply_to AS "inReplyTo" FROM client_messages WHERE project_id = ${projectId} AND direction = 'outbound' AND kind = 'report'
        AND body LIKE ${`%${answerId} answers a question that is no longer open%`}`);
    expect(notices.rows).toEqual([{ inReplyTo: null }]);
    const blocks = await db.execute(sql`SELECT kind FROM project_blocks WHERE project_id = ${projectId}`);
    expect(blocks.rows).toEqual([]);
    expect(await answers().runPending()).toEqual([]);
  });

  test.each(["model_failed", "provider_failed", "replan_stopped", "replan_provider_failed", "budget_cap"] as const)(
    "an answer to a project halted on %s is not read and not charged through many cycles, its receipt says why, and after the unblock it is read once",
    async (category) => {
      const { projectId, questionIds } = await intakenProject();
      const [first] = questionIds;
      if (first === undefined) throw new Error("intake posted no question");
      const cause =
        category === "budget_cap"
          ? { category, errorClass: SPEND_CAP_ERROR_CLASS.project, reason: "the project's cap", spend: { spentUsd: 5, capUsd: 5, inFlightUsd: 0, nextCallUsd: 1 } }
          : { category, errorClass: "ScriptedHalt", reason: `halted on ${category} by the test` };
      expect(await new ProjectHaltRepository(db).block(projectId, cause)).toBe("blocked");
      const answerId = await answer(projectId, first, "Harbour.");
      const mock = pipelineModel({ verdict: "maybe" });

      for (let i = 0; i < 5; i++) expect(await answers().runPending()).toEqual([]);

      expect(mock.doGenerateCalls).toHaveLength(0);
      const stored = await db.execute(sql`SELECT intake_attempts AS "attempts", consumed_at IS NOT NULL AS consumed FROM client_messages WHERE id = ${answerId}`);
      expect(z.array(z.object({ attempts: z.number(), consumed: z.boolean() })).parse(stored.rows)).toEqual([{ attempts: 0, consumed: false }]);
      expect(await haltKindOf(projectId)).toBe(category);
      const receipts = createClientReceiptStore(db);
      await new ClientReceipts({ ...receipts, dueReceipts: ours(() => receipts.dueReceipts()) }, containment()).runPending({ kind: "running" });
      const receipt = await db.execute(sql`SELECT body FROM client_messages WHERE receipt_of = ${answerId}`);
      expect(z.array(z.object({ body: z.string() })).parse(receipt.rows)).toEqual([{ body: expect.stringContaining("so Ashara reads it once the pause ends") }]);

      await new ProjectHaltRepository(db).unblock(projectId, "operator-a", "cleared the halt");
      pipelineModel({ verdict: "confirms", amends: [] });
      expect((await answers().runPending()).map((outcome) => outcome.kind)).toEqual(["stated"]);
      expect(await haltKindOf(projectId)).toBeNull();
    },
  );

  test("an answer to a project halted on a plan repair is read all the same, the halt left open", async () => {
    const { projectId, questionIds } = await intakenProject();
    const [, second] = questionIds;
    if (second === undefined) throw new Error("intake posted no second question");
    expect(await new ProjectHaltRepository(db).block(projectId, { category: "plan_repair", errorClass: "PlanRepairBound", reason: "repaired its bound of times" })).toBe("blocked");
    const answerId = await answer(projectId, second, "Yes, twelve seats.");
    pipelineModel({ verdict: "confirms", amends: [] });

    expect(await answers().runPending()).toEqual([
      { kind: "stated", answerId, projectId, assumptionKey: "A2", restatedKeys: [], verdict: "confirms", visionVersion: 2, replanRequested: false },
    ]);
    expect((await new ClientMessageRepository(db).findById(answerId))?.consumedAt).toBeInstanceOf(Date);
    expect(await haltKindOf(projectId)).toBe("plan_repair");
  });

  test("a paused project at its own spend cap: its answer waits uncharged, and a later paused project's answer is read in the same cycle", async () => {
    const atCap = await intakenProject();
    const other = await intakenProject();
    const halts = new ProjectHaltRepository(db);
    expect(await halts.block(atCap.projectId, { category: "plan_repair", errorClass: "PlanRepairBound", reason: "repaired its bound of times" })).toBe("blocked");
    expect(await halts.block(other.projectId, { category: "check_dispute", errorClass: "CheckDisputeBound", reason: "disputed its bound of times" })).toBe("blocked");
    // A call in flight at the whole cap: the project's reading is refused before it is sent.
    await db.execute(sql`INSERT INTO llm_calls (project_id, call_site, provider, model, estimated_cost_usd, state)
      VALUES (${atCap.projectId}, 'liaison-intake', 'deepseek', 'answer-strong', 5, 'pending')`);
    const waiting = await answer(atCap.projectId, atCap.questionIds[1] ?? "", "Yes, twelve seats.");
    const read = await answer(other.projectId, other.questionIds[1] ?? "", "Yes, twelve seats.");
    pipelineModel({ verdict: "confirms", amends: [] });
    const store = createAnswerStore(db);
    const capped = new ClientAnswers({ shutdownSignal: new AbortController().signal,
      containment: containment(),
      llm: modelAccess({ deploymentUsd: 1_000_000, perProjectUsd: 5 }),
      store: { ...store, openAnswers: ours(() => store.openAnswers()) },
    });

    expect((await capped.runPending()).map((outcome) => [outcome.kind, "answerId" in outcome ? outcome.answerId : null])).toEqual([
      ["waits-for-limit", waiting],
      ["stated", read],
    ]);
    expect((await capped.runPending()).map((outcome) => outcome.kind)).toEqual(["waits-for-limit"]);
    const row = await new ClientMessageRepository(db).findById(waiting);
    expect([row?.consumedAt ?? null, row?.intakeAttempts]).toEqual([null, 0]);
    expect(await haltKindOf(atCap.projectId)).toBe("plan_repair");
  });

  test("an answer composed while at work, its project stopped before the write: nothing is written, and it is not read again", async () => {
    const { projectId, questionIds } = await intakenProject();
    const [, second] = questionIds;
    if (second === undefined) throw new Error("intake posted no second question");
    const answerId = await answer(projectId, second, "Yes, twelve seats.");
    pipelineModel({ verdict: "confirms", amends: [] });
    const store = createAnswerStore(db);
    const racing: AnswerStore = {
      ...store,
      openAnswers: ours(() => store.openAnswers()),
      recordAnswer: async (write) => {
        await db.execute(sql`UPDATE projects SET lifecycle = 'stopped' WHERE id = ${projectId}`);
        return store.recordAnswer(write);
      },
    };

    expect(await new ClientAnswers({ shutdownSignal: new AbortController().signal, containment: containment(), llm: gateway, store: racing }).runPending()).toEqual([{ kind: "not-open", answerId, projectId }]);
    expect((await new ClientMessageRepository(db).findById(answerId))?.consumedAt).toBeNull();
    expect(await visionsOf(projectId)).toHaveLength(1);
  });

  test("a store failure on one answer is that answer's fault: recorded with a backoff, never counted, and the other project's answer is read", async () => {
    const broken = await intakenProject();
    const healthy = await intakenProject();
    const brokenAnswer = await answer(broken.projectId, broken.questionIds[0] ?? "", "Harbour.");
    const healthyAnswer = await answer(healthy.projectId, healthy.questionIds[0] ?? "", "Yes.");
    pipelineModel({ verdict: "confirms", amends: [] });
    const store = createAnswerStore(db);
    const failing: AnswerStore = {
      ...store,
      openAnswers: ours(() => store.openAnswers()),
      recordAnswer: async (write) => {
        if (write.answerId === brokenAnswer) throw new Error("scripted store failure");
        return store.recordAnswer(write);
      },
    };

    const outcomes = await new ClientAnswers({ shutdownSignal: new AbortController().signal, containment: containment(), llm: gateway, store: failing }).runPending();

    expect(outcomes.map((outcome) => [outcome.kind, outcome.kind === "step-faulted" ? outcome.subjectId : outcome.answerId])).toEqual([
      ["step-faulted", brokenAnswer],
      ["stated", healthyAnswer],
    ]);
    const attempts = await db.execute(sql`SELECT intake_attempts AS "attempts" FROM client_messages WHERE id = ${brokenAnswer}`);
    expect(z.array(z.object({ attempts: z.number() })).parse(attempts.rows)).toEqual([{ attempts: 0 }]);
    const faults = await db.execute(sql`
      SELECT faults, last_error AS "lastError", (retry_at > now()) AS waiting
      FROM step_faults WHERE step = 'liaison-answers' AND subject_id = ${brokenAnswer}`);
    expect(z.array(z.object({ faults: z.number(), lastError: z.string(), waiting: z.boolean() })).parse(faults.rows)).toEqual([
      { faults: 1, lastError: expect.stringContaining("scripted store failure"), waiting: true },
    ]);
    expect((await new ProjectHaltRepository(db).get(broken.projectId))?.status).not.toBe("blocked");
    // Not read again until its backoff has passed.
    expect(await new ClientAnswers({ shutdownSignal: new AbortController().signal, containment: containment(), llm: gateway, store: failing }).runPending()).toEqual([]);
  });

  test("a roster whose provider fails every request halts its project at the fault bound as the provider's failure, never Ashara's", async () => {
    const { projectId } = await intakenProject();
    const outage = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new APICallError({ message: "stub provider unavailable", url: "https://stub.invalid/v1", requestBodyValues: {}, statusCode: 503, isRetryable: true });
      },
    });
    stub.model = outage;

    const kinds: string[] = [];
    for (let cycle = 0; cycle < 10 && (await haltKindOf(projectId)) === null; cycle++) {
      for (const outcome of await roster().runPending()) kinds.push(outcome.kind);
      await db.execute(sql`UPDATE step_faults SET retry_at = now() - interval '1 second' WHERE step = 'roster' AND subject_id = ${projectId}`);
    }

    expect(kinds.length).toBeGreaterThan(1);
    expect(new Set(kinds)).toEqual(new Set(["step-faulted"]));
    expect(await haltKindOf(projectId)).toBe("provider_failed");
    const halted = await db.execute(sql`SELECT kind AS "category" FROM project_blocks WHERE project_id = ${projectId} AND ended_at IS NULL`);
    expect(z.array(z.object({ category: z.string() })).parse(halted.rows)).toEqual([{ category: "provider_failed" }]);
    // The parked subject of the halted project is not tried again.
    expect(await roster().runPending()).toEqual([]);
  });
});
