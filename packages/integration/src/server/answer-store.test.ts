import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  ClientMessageRepository,
  ClientRepository,
  createDb,
  createProjectWithTender,
  DEFAULT_DATABASE_URL,
  LlmCallRepository,
  ProjectRepository,
} from "@ashara/db";
import { ClientAnswers, TenderIntake } from "@ashara/engagement";
import type { AnswerStore, IntakeStore } from "@ashara/engagement";
import { LlmCallLedger, SpendCap } from "@ashara/finance";
import { buildGateway, sdkLanguageModels } from "@ashara/llm-gateway";
import type { LLMGateway, ModelConfig } from "@ashara/llm-gateway";
import { RosterDerivation } from "@ashara/organization";
import type { RosterStore } from "@ashara/organization";
import { FirstPlanner } from "@ashara/planning";
import type { FirstPlanStore } from "@ashara/planning";
import type { ProjectId } from "@ashara/shared";
import { createAnswerStore } from "@ashara/server/answer-store";
import { createFirstPlanStore } from "@ashara/server/first-plan-store";
import { createIntakeStore } from "@ashara/server/intake-store";
import { createRosterStore } from "@ashara/server/roster-store";

// Every row here belongs to a project this suite creates under a unique name, and
// afterAll deletes exactly those rows. Each store is narrowed to this suite's
// projects. No real LLM call is made: the provider factory returns a MockLanguageModelV4.

const stub = vi.hoisted(() => ({ model: undefined as unknown }));
vi.mock("@ai-sdk/deepseek", () => ({ createDeepSeek: () => () => stub.model }));

const DATABASE_URL = process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL;
const TEST_SPEND_CAPS = { deploymentUsd: 1_000_000, perProjectUsd: 1_000_000 };
const NAME_PREFIX = `client-answer-test-${randomUUID().slice(0, 8)}`;

let db: ReturnType<typeof createDb>;
let gateway: LLMGateway;
let clientId: string;
const ourProjects = new Set<string>();

function model(id: string, capabilityLevel: ModelConfig["capabilityLevel"]): ModelConfig {
  return {
    id,
    apiModelId: `${id}-api`,
    provider: "deepseek",
    capabilityLevel,
    inputCostPer1M: 1,
    outputCostPer1M: 2,
    maxContextTokens: 100_000,
    cacheReadCostPer1M: null,
    cacheWriteCostPer1M: null,
    priceWindows: [], priceTiers: [],
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
  inScope: ["Class booking for both studios"],
  outOfScope: ["Payments"],
  assumptions: [{ statement: "Bookings need no account.", rationale: "The tender says walk-in customers book.", kind: "client-visible" }],
  questions: [
    {
      text: "Which studio opens first?",
      whyItMatters: "It orders the work.",
      assumption: { statement: "The harbour studio opens first.", rationale: "The tender names it first.", kind: "client-visible" },
    },
    {
      text: "How many seats does a class have?",
      whyItMatters: "It sets the booking limit.",
      assumption: { statement: "A class has twelve seats.", rationale: "The tender mentions a dozen wheels.", kind: "client-visible" },
    },
  ],
};

const ROSTER = {
  roles: [
    { name: "Liaison", responsibility: "Talks to the studio owner.", capabilities: ["client-comms"] },
    { name: "Platform", responsibility: "Defines how the page is built and tested.", capabilities: ["write-environment"] },
    { name: "Implementer", responsibility: "Builds the booking page.", capabilities: ["write-source"] },
    { name: "Check author", responsibility: "Writes the checks the page must pass.", capabilities: ["author-checks"] },
  ],
};

const KNOWLEDGE = { nodes: [{ id: "lang-x", kind: "language", label: "Stated language" }], edges: [] };
const TASKS = {
  tasks: [
    {
      ref: "t1", title: "Create the class list", description: "List classes.", dependsOn: [],
      endState: "Classes are listed", scope: "class listing", deliverables: [{ text: "class list", sources: ["S1"] }], acceptance: [{ text: "a client uses the class list", sources: ["S1"] }],
      capability: "Medium", capabilityReason: "graded for the test",
    },
  ],
};

/**
 * One model for every call of the pipeline, answering each by what its prompt asks:
 * intake, roster, the knowledge graph, the tasks, and the answer reading.
 */
function pipelineModel(reading: unknown): MockLanguageModelV4 {
  const mock = new MockLanguageModelV4({
    doGenerate: async (options) => {
      const prompt = JSON.stringify(options.prompt);
      if (prompt.includes("Read their answer and say what it does")) return jsonResult(reading);
      if (prompt.includes("prepare the first version of the project's vision")) return jsonResult(INTAKE);
      if (prompt.includes("structured knowledge graph")) return jsonResult(KNOWLEDGE);
      if (prompt.includes("client-comms")) return jsonResult(ROSTER);
      return jsonResult(TASKS);
    },
  });
  stub.model = mock;
  return mock;
}

function ours<T extends { readonly projectId: string }>(list: () => Promise<readonly T[]>): () => Promise<T[]> {
  return async () => (await list()).filter((row) => ourProjects.has(row.projectId));
}

function answers(): ClientAnswers {
  const store = createAnswerStore(db);
  const narrowed: AnswerStore = { ...store, openAnswers: ours(() => store.openAnswers()) };
  return new ClientAnswers({ llm: gateway, store: narrowed });
}

function intake(): TenderIntake {
  const store = createIntakeStore(db);
  const narrowed: IntakeStore = { ...store, openTenders: ours(() => store.openTenders()) };
  return new TenderIntake({ llm: gateway, store: narrowed });
}

function roster(): RosterDerivation {
  const store = createRosterStore(db);
  const narrowed: RosterStore = { ...store, projectsAwaitingRoster: ours(() => store.projectsAwaitingRoster()) };
  return new RosterDerivation({ llm: gateway, store: narrowed });
}

function planner(): FirstPlanner {
  const store = createFirstPlanStore(db);
  const narrowed: FirstPlanStore = { ...store, projectsAwaitingPlan: ours(() => store.projectsAwaitingPlan()) };
  return new FirstPlanner({ llm: gateway, store: narrowed });
}

/** A tender taken in: vision v1 with A1 and A2 adopted by the two questions, A3 unasked. */
async function intakenProject(): Promise<{ projectId: ProjectId; tenderId: string; questionIds: string[] }> {
  const created = await createProjectWithTender(db, clientId, `${NAME_PREFIX}-${randomUUID().slice(0, 6)}`, "Booking page for my two pottery studios.");
  ourProjects.add(created.project.id);
  pipelineModel({ verdict: "confirms" });
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

/** The answers whose plan revision the project awaits (replan_requests, migration 052), oldest first. */
async function awaitedChangesOf(projectId: ProjectId): Promise<string[]> {
  const result = await db.execute(sql`
    SELECT answer_id AS "answerId" FROM replan_requests WHERE project_id = ${projectId} AND plan_revision_id IS NULL ORDER BY created_at`);
  return z.array(z.object({ answerId: z.string() })).parse(result.rows).map((row) => row.answerId);
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  clientId = (await new ClientRepository(db).create(`${NAME_PREFIX}-client`)).id;
  gateway = buildGateway({
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
    },
    checkedSources: ["test"],
    recording: { kind: "recorded", recorder: new LlmCallLedger(
      new LlmCallRepository(db),
      new SpendCap({ ledger: new LlmCallRepository(db), projects: new ProjectRepository(db), caps: TEST_SPEND_CAPS }),
    ) },
    clock: () => new Date(),
  });
});

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  ourProjects.clear();
});

afterAll(async () => {
  const pattern = `${NAME_PREFIX}%`;
  const projects = sql`SELECT id FROM projects WHERE name LIKE ${pattern}`;
  await db.execute(sql`DELETE FROM replan_requests WHERE project_id IN (${projects})`);
  await db.execute(sql`DELETE FROM llm_calls WHERE project_id IN (${projects})`);
  await db.execute(sql`DELETE FROM work_items WHERE project_id IN (${projects})`);
  await db.execute(sql`DELETE FROM roster_roles WHERE project_id IN (${projects})`);
  await db.execute(sql`DELETE FROM project_contracts WHERE project_id IN (${projects})`);
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
    pipelineModel({ verdict: "confirms" });

    const outcomes = await answers().runPending();

    expect(outcomes).toEqual([
      { kind: "stated", answerId, projectId, assumptionKey: "A2", verdict: "confirms", visionVersion: 2, replanRequested: false },
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

    const again = pipelineModel({ verdict: "confirms" });
    expect(await answers().runPending()).toEqual([]);
    expect(again.doGenerateCalls).toHaveLength(0);
    expect(await visionsOf(projectId)).toHaveLength(2);
  });

  test("a project with an unread answer is not planned until it is read, and the plan carries the answer as a clarification", async () => {
    const { projectId, questionIds } = await intakenProject();
    const [, second] = questionIds;
    if (second === undefined) throw new Error("intake posted no second question");
    pipelineModel({ verdict: "confirms" });
    expect((await roster().runPending()).map((o) => o.kind)).toEqual(["recorded"]);
    await answer(projectId, second, "Eight seats, not twelve.");

    expect(await planner().runPending()).toEqual([]);

    pipelineModel({ verdict: "changes", statement: "A class has eight seats.", kind: "client-visible" });
    expect((await answers().runPending()).map((o) => o.kind)).toEqual(["stated"]);
    const mock = pipelineModel({ verdict: "confirms" });
    expect((await planner().runPending()).map((o) => o.kind)).toEqual(["planned"]);

    const prompts = mock.doGenerateCalls.map((call) => JSON.stringify(call.prompt));
    expect(prompts.some((p) => p.includes("Client clarifications") && p.includes("How many seats does a class have? -> Eight seats, not twelve."))).toBe(true);
    expect(prompts.some((p) => p.includes("A class has twelve seats."))).toBe(false);
    // Before the first plan a changed assumption needs no replanning.
    expect(await awaitedChangesOf(projectId)).toEqual([]);
  });

  test("an answer after the first plan that changes an assumption it was built on is reported once and stops dispatch", async () => {
    const { projectId, tenderId, questionIds } = await intakenProject();
    const [first] = questionIds;
    if (first === undefined) throw new Error("intake posted no question");
    pipelineModel({ verdict: "confirms" });
    expect((await roster().runPending()).map((o) => o.kind)).toEqual(["recorded"]);
    expect((await planner().runPending()).map((o) => o.kind)).toEqual(["planned"]);
    const projectRepo = new ProjectRepository(db);
    expect(await projectRepo.listActiveIds()).toContain(projectId);

    const answerId = await answer(projectId, first, "No, the hill studio opens first.");
    pipelineModel({ verdict: "changes", statement: "The hill studio opens first.", kind: "internal-design" });
    const outcomes = await answers().runPending();

    expect(outcomes).toEqual([
      { kind: "stated", answerId, projectId, assumptionKey: "A1", verdict: "changes", visionVersion: 2, replanRequested: true },
    ]);
    expect((await visionsOf(projectId))[1]?.inferences.find((a) => a.key === "A1")).toMatchObject({
      statement: "The hill studio opens first.",
      status: "Stated",
      // The changed decision is classified again, never carried over from the one it replaced.
      kind: "internal-design",
      clientAnswer: { messageId: answerId, verdict: "changes" },
    });
    expect(await awaitedChangesOf(projectId)).toEqual([answerId]);
    expect(await projectRepo.listActiveIds()).not.toContain(projectId);
    // Beside intake's report of the unasked assumptions, in reply to the tender (ADR-074 addendum 2 d89 C).
    const reports = (await new ClientMessageRepository(db).listByProject(projectId)).filter(
      (m) => m.kind === "report" && m.inReplyTo !== tenderId,
    );
    expect(reports).toHaveLength(1);
    expect(reports[0]?.inReplyTo).toBe(answerId);
    expect(reports[0]?.body).toContain("The plan assumed: The harbour studio opens first.");
    expect(reports[0]?.body).toContain("Work now proceeds on: The hill studio opens first.");
    expect(reports[0]?.body).toContain("you will be told what changes");
    expect(await answers().runPending()).toEqual([]);
  });

  test("an answer after the first plan that confirms its assumption is Stated without replanning", async () => {
    const { projectId, tenderId, questionIds } = await intakenProject();
    const [first] = questionIds;
    if (first === undefined) throw new Error("intake posted no question");
    pipelineModel({ verdict: "confirms" });
    await roster().runPending();
    expect((await planner().runPending()).map((o) => o.kind)).toEqual(["planned"]);

    await answer(projectId, first, "Yes, harbour first.");
    pipelineModel({ verdict: "confirms" });
    expect((await answers().runPending()).map((o) => o.kind === "stated" && o.replanRequested)).toEqual([false]);
    expect(await awaitedChangesOf(projectId)).toEqual([]);
    expect(
      (await new ClientMessageRepository(db).listByProject(projectId)).filter((m) => m.kind === "report" && m.inReplyTo !== tenderId),
    ).toHaveLength(0);
  });

  test("two answers of one project in one cycle: each is read against the vision as the other left it (third run N9)", async () => {
    const { projectId, questionIds } = await intakenProject();
    const [first, second] = questionIds;
    if (first === undefined || second === undefined) throw new Error("intake posted fewer than two questions");
    const firstAnswer = await answer(projectId, first, "Yes, harbour first.");
    const secondAnswer = await answer(projectId, second, "Yes, twelve seats.");
    const mock = pipelineModel({ verdict: "confirms" });

    const outcomes = await answers().runPending();

    expect(outcomes).toEqual([
      { kind: "stated", answerId: firstAnswer, projectId, assumptionKey: "A1", verdict: "confirms", visionVersion: 2, replanRequested: false },
      { kind: "stated", answerId: secondAnswer, projectId, assumptionKey: "A2", verdict: "confirms", visionVersion: 3, replanRequested: false },
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
    const mock = pipelineModel({ verdict: "confirms" });
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
                                          confirmed_directions, open_questions, change_reason)
            SELECT project_id, version + 1, vision_text, summary, inferences, scope_boundaries, confirmed_directions,
                   open_questions, 'a concurrent writer'
              FROM vision_documents WHERE project_id = ${projectId} ORDER BY version DESC LIMIT 1`);
        }
        return store.recordAnswer(write);
      },
    };

    const outcomes = await new ClientAnswers({ llm: gateway, store: racing }).runPending();

    expect(outcomes).toEqual([
      { kind: "stated", answerId, projectId, assumptionKey: "A2", verdict: "confirms", visionVersion: 3, replanRequested: false },
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
    expect((await new ProjectRepository(db).get(projectId))?.status).toBe("blocked");
    expect((await new ClientMessageRepository(db).findById(answerId))?.consumedAt).toBeNull();
    expect(await visionsOf(projectId)).toHaveLength(1);
  });
});
