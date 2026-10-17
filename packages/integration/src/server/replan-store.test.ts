import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { ClientRepository, createDb, DEFAULT_DATABASE_URL, latestRosterRevision, latestRosterRoles, LlmCallRepository } from "@ashara/db";
import { TaskCheckRepository } from "@ashara/quality";
import {
  BlockReports,
  ClientAnswers,
  PlanReports,
  TenderIntake,
  ClientMessageRepository,
  createProjectWithTender,
} from "@ashara/engagement";
import type { AnswerStore, BlockReportStore, IntakeStore, PlanReportStore } from "@ashara/engagement";
import { GuardedModelAccess, LlmCallLedger, SpendCap } from "@ashara/finance";
import { buildGateway, sdkLanguageModels } from "@ashara/model-access";
import type { ModelConfig } from "@ashara/model-access";
import { releaseClearedBlocks, FirstPlanner, PlanningService, Replanner, failWorkItem, giveUpWorkItem, recoverFailedItem, startWorkItem, createReplanStore, createAgentStaffing, adaptWorkItemRepo, createFirstPlanStore, WorkItemRowRepository, ProjectHaltRepository } from "@ashara/delivery";
import { RosterDerivation } from "@ashara/organization";
import type { RosterStore } from "@ashara/organization";
import type { FirstPlanStore, ReplanStore } from "@ashara/delivery";
import { memoryStepContainment, parseWorkItemId, type DomainEvent, type ProjectId, type StepContainment } from "@ashara/shared";
import { createAnswerStore } from "@ashara/server/answer-store";
import { createBlockReportStore } from "@ashara/server/block-report-store";
import { createIntakeStore } from "@ashara/server/intake-store";
import { createRosterStore } from "@ashara/server/roster-store";
import { createPlanReportStore } from "@ashara/server/plan-report-store";
import { projectState } from "../simulator/project-state.js";
import { citingItemsToCheck } from "../simulator/scripted-models.js";

// A late client change is planned (t-replan-on-change). Every row here belongs to a project
// this suite creates under a unique name, and afterAll deletes exactly those rows. Each store
// is narrowed to this suite's projects. No real LLM call is made: the provider factory returns
// a MockLanguageModelV4 that answers each call by what its prompt asks.

const stub = vi.hoisted(() => ({ model: undefined as unknown }));
vi.mock("@ai-sdk/deepseek", () => ({ createDeepSeek: () => () => stub.model }));

const DATABASE_URL = process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL;
const TEST_SPEND_CAPS = { deploymentUsd: 1_000_000, perProjectUsd: 1_000_000 };
const NAME_PREFIX = `replan-test-${randomUUID().slice(0, 8)}`;
const MERGE_COMMIT = "a".repeat(40);

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

const FIRST_TASKS = {
  tasks: [
    {
      ref: "t1", title: "Open harbour studio bookings", description: "Harbour bookings.", dependsOn: [], goal: "",
      endState: "Harbour classes can be booked", scope: "harbour bookings", deliverables: [{ text: "harbour booking", sources: ["S1"] }], acceptance: [{ text: "a client uses the harbour booking", sources: ["S1"] }],
      capability: "Medium", capabilityReason: "graded for the test",
    },
  ],
};
const REVISED_TASKS = {
  tasks: [
    {
      ref: "t1", title: "Open hill studio bookings", description: "Hill bookings.", dependsOn: [], goal: "",
      endState: "Hill classes can be booked", scope: "hill bookings", deliverables: [{ text: "hill booking", sources: ["S1"] }], acceptance: [{ text: "a client uses the hill booking", sources: ["S1"] }],
      capability: "Light", capabilityReason: "graded for the test",
    },
  ],
};

const REPAIRED_TASKS = {
  tasks: [
    {
      ref: "t1", title: "Book a harbour class by its date", description: "Harbour bookings, smaller.", dependsOn: [], goal: "",
      endState: "A harbour class can be booked by its date", scope: "harbour bookings by date", deliverables: [{ text: "harbour booking", sources: ["S1"] }], acceptance: [{ text: "a client uses the harbour booking", sources: ["S1"] }],
      capability: "Medium", capabilityReason: "graded for the test",
    },
  ],
};

/** The intake of INTAKE with a second question, whose assumption a second answer can change. */
const TWO_QUESTION_INTAKE = {
  ...INTAKE,
  questions: [
    ...INTAKE.questions,
    {
      text: "Do classes need a teacher named?",
      whyItMatters: "It decides what a booking shows.",
      assumption: { statement: "A class shows no teacher.", rationale: "The tender names none.", kind: "client-visible" },
    },
  ],
};

/** One model for every call, answering each by what its prompt asks. */
function pipelineModel(
  options: { readonly reading?: unknown; readonly environmentChange?: boolean; readonly intake?: unknown; readonly revision?: unknown } = {},
): MockLanguageModelV4 {
  const mock = new MockLanguageModelV4({
    doGenerate: async (call) => {
      const prompt = JSON.stringify(call.prompt);
      if (prompt.includes("Read their answer and say what it does")) return jsonResult({ reading: options.reading ?? { verdict: "confirms" } });
      if (prompt.includes("prepare the first version of the project's vision")) return jsonResult(options.intake ?? INTAKE);
      if (prompt.includes("client-comms")) return jsonResult(ROSTER);
      if (prompt.includes("needs the project environment changed") || prompt.includes("Work on a project stopped")) {
        return jsonResult({ environmentChange: options.environmentChange ?? false, reason: "Only what is booked changes." });
      }
      if (prompt.includes("changed what is built after work began")) return jsonResult(options.revision ?? citingItemsToCheck(REVISED_TASKS, prompt));
      if (prompt.includes("Plan the work still to do again")) return jsonResult(citingItemsToCheck(REPAIRED_TASKS, prompt));
      return jsonResult(citingItemsToCheck(FIRST_TASKS, prompt));
    },
  });
  stub.model = mock;
  return mock;
}

function ours<T extends { readonly projectId: string }>(list: () => Promise<readonly T[]>): () => Promise<T[]> {
  return async () => (await list()).filter((row) => ourProjects.has(row.projectId));
}

function replanner(containment: StepContainment = memoryStepContainment(() => true)): Replanner {
  const store = createReplanStore(db);
  const narrowed: ReplanStore = { ...store, projectsAwaitingReplan: ours(() => store.projectsAwaitingReplan()) };
  return new Replanner({ containment, llm: gateway, store: narrowed });
}

function planReports(): PlanReports {
  const store = createPlanReportStore(db);
  const narrowed: PlanReportStore = {
    ...store,
    dueReports: ours(() => store.dueReports()),
    dueRevisionReports: ours(() => store.dueRevisionReports()),
  };
  return new PlanReports(narrowed, memoryStepContainment(() => true));
}

function blockReports(): BlockReports {
  const store = createBlockReportStore(db);
  const narrowed: BlockReportStore = { ...store, dueReports: ours(() => store.dueReports()) };
  return new BlockReports(narrowed, memoryStepContainment(() => true));
}

/** A tender taken in, its roster derived and its first plan written: Sprint 0, a check task and one task. */
async function plannedProject(
  options: { readonly reported: boolean; readonly intake?: unknown } = { reported: true },
): Promise<{ projectId: ProjectId; questionId: string; questionIds: string[] }> {
  const created = await createProjectWithTender(db, clientId, `${NAME_PREFIX}-${randomUUID().slice(0, 6)}`, "Booking page for my two pottery studios.");
  const projectId = created.project.id;
  ourProjects.add(projectId);
  pipelineModel({ intake: options.intake });
  const intakeStore = createIntakeStore(db);
  const intake: IntakeStore = { ...intakeStore, openTenders: ours(() => intakeStore.openTenders()) };
  expect((await new TenderIntake({ containment: memoryStepContainment(() => true), llm: gateway, store: intake }).runPending()).map((o) => o.kind)).toEqual(["recorded"]);
  const rosterStore = createRosterStore(db);
  const roster: RosterStore = { ...rosterStore, projectsAwaitingRoster: ours(() => rosterStore.projectsAwaitingRoster()) };
  expect((await new RosterDerivation({ containment: memoryStepContainment(() => true), llm: gateway, store: roster }).runPending()).map((o) => o.kind)).toEqual(["recorded"]);
  const planStore = createFirstPlanStore(db);
  const plan: FirstPlanStore = { ...planStore, projectsAwaitingPlan: ours(() => planStore.projectsAwaitingPlan()) };
  expect((await new FirstPlanner({ containment: memoryStepContainment(() => true), llm: gateway, store: plan }).runPending()).map((o) => o.kind)).toEqual(["planned"]);
  if (options.reported) expect((await planReports().runPending()).map((o) => o.kind)).toEqual(["posted"]);
  const questions = (await new ClientMessageRepository(db).listByProject(projectId)).filter((m) => m.kind === "question");
  const [question] = questions;
  if (question === undefined) throw new Error("intake posted no question");
  return { projectId, questionId: question.id, questionIds: questions.map((q) => q.id) };
}

const HILL_FIRST = { body: "No, the hill studio opens first.", statement: "The hill studio opens first." };

/** The client's answer changing the plan's assumption, read by the Liaison: the project awaits a revision for it. */
async function contradict(projectId: ProjectId, questionId: string, change: { readonly body: string; readonly statement: string } = HILL_FIRST): Promise<string> {
  const row = await new ClientMessageRepository(db).insertInbound({
    projectId,
    kind: "answer",
    body: change.body,
    inReplyTo: questionId,
  });
  pipelineModel({ reading: { verdict: "changes", statement: change.statement, kind: "client-visible" } });
  const answerStore = createAnswerStore(db);
  const narrowed: AnswerStore = { ...answerStore, openAnswers: ours(() => answerStore.openAnswers()) };
  const outcomes = await new ClientAnswers({ containment: memoryStepContainment(() => true), llm: gateway, store: narrowed }).runPending();
  expect(outcomes.map((o) => o.kind === "stated" && o.replanRequested)).toEqual([true]);
  return row.id;
}

const ItemRowSchema = z.object({
  id: z.string(),
  title: z.string(),
  level: z.string(),
  status: z.string(),
  origin: z.string().nullable(),
  reason: z.unknown(),
});

async function itemsOf(projectId: ProjectId) {
  const result = await db.execute(sql`
    SELECT id, title, level, status, task_spec->>'origin' AS origin, blocked_reason AS reason
    FROM work_items WHERE project_id = ${projectId} ORDER BY created_at, id`);
  return z.array(ItemRowSchema).parse(result.rows);
}

/** Starts a task as dispatch does: the task and every Pending ancestor, its Epic, go InProgress. */
async function startTask(id: string): Promise<void> {
  const repo = adaptWorkItemRepo(new WorkItemRowRepository(db));
  const task = await PlanningService.findWorkItem(repo, parseWorkItemId(id, "test"));
  if (task === null) throw new Error(`task ${id} not found`);
  startWorkItem(task);
  await PlanningService.saveWorkItem(repo, task, "Pending");
  await PlanningService.activateAncestors(repo, task.parentId);
}

/** Completes a started task as its routed success does, settling its Epic when every child is done. */
async function completeTask(id: string): Promise<void> {
  await PlanningService.route(adaptWorkItemRepo(new WorkItemRowRepository(db)), parseWorkItemId(id, "test"), "passed");
}

async function dependenciesOf(id: string): Promise<string[]> {
  const result = await db.execute(sql`SELECT to_id AS "to" FROM dependencies WHERE from_id = ${id}`);
  return z.array(z.object({ to: z.string() })).parse(result.rows).map((row) => row.to);
}

/** The project's status and category, and the answers whose revision it awaits (replan_requests), oldest first. */
async function projectRow(projectId: ProjectId) {
  const result = await db.execute(sql`
    SELECT ${projectState} AS status, blocked_category AS "category",
      COALESCE((SELECT json_agg(rr.answer_id ORDER BY rr.created_at) FROM replan_requests rr
        WHERE rr.project_id = projects.id AND rr.plan_revision_id IS NULL), '[]'::json) AS "awaiting"
    FROM projects WHERE id = ${projectId}`);
  const [row] = z
    .array(z.object({ status: z.string(), awaiting: z.array(z.string()), category: z.string().nullable() }))
    .parse(result.rows);
  if (row === undefined) throw new Error(`project ${projectId} not found`);
  return row;
}

async function reportsOf(projectId: ProjectId) {
  return (await new ClientMessageRepository(db).listByProject(projectId)).filter((m) => m.kind === "report");
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  clientId = (await new ClientRepository(db).create(`${NAME_PREFIX}-client`)).id;
  gateway = new GuardedModelAccess(buildGateway({
    models: sdkLanguageModels,
    config: {
      providers: [
        {
          name: "deepseek",
          providerType: "deepseek",
          apiKey: "test-key",
          baseUrl: "https://stub.invalid/v1",
          models: [model("replan-strong", "Strong"), model("replan-frontier", "Frontier")],
          enabled: true,
        },
      ],
      defaultProvider: "deepseek",
    },
    checkedSources: ["test"],
    clock: () => new Date(),
  }), new LlmCallLedger(
    new LlmCallRepository(db),
    new SpendCap({ ledger: new LlmCallRepository(db), caps: TEST_SPEND_CAPS }),
  ));
});

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  ourProjects.clear();
});

afterAll(async () => {
  const pattern = `${NAME_PREFIX}%`;
  const projects = sql`SELECT id FROM projects WHERE name LIKE ${pattern}`;
  await db.execute(sql`DELETE FROM replan_requests WHERE project_id IN (${projects})`);
  await db.execute(sql`DELETE FROM plan_revisions WHERE project_id IN (${projects})`);
  await db.execute(sql`DELETE FROM project_blocks WHERE project_id IN (${projects})`);
  await db.execute(sql`DELETE FROM llm_calls WHERE project_id IN (${projects})`);
  await db.execute(sql`DELETE FROM task_checks WHERE project_id IN (${projects})`);
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

// Answers read after the first plan was written and before it was reported.
describe("the client is told one plan, and never what the team will now do on a halted project", () => {
  test("a change read between the first plan and its report gives one founded report of the revised plan, and no halt", async () => {
    const { projectId, questionId } = await plannedProject({ reported: false });
    const answerId = await contradict(projectId, questionId);

    // The plan the client was just told must change is not reported meanwhile.
    expect(await planReports().runPending()).toEqual([]);
    pipelineModel({ environmentChange: false });
    expect((await replanner().runPending()).map((o) => o.kind)).toEqual(["revised"]);

    // Before the fix: every item counted, two Sprint 0 tasks, two scaffolds, two reviews: PlanReportUnfounded.
    expect(await planReports().runPending()).toEqual([{ kind: "posted", projectId, subject: "first-plan" }]);
    expect(await planReports().runPending()).toEqual([]);
    expect(await projectRow(projectId)).toEqual({ status: "active", awaiting: [], category: null });

    const reports = await reportsOf(projectId);
    const plans = reports.filter((m) => m.body.startsWith("Ashara has made the first plan"));
    expect(plans).toHaveLength(1);
    const plan = plans[0];
    if (plan === undefined) throw new Error("no first-plan report");
    expect(plan.body).toContain("1 epic (");
    expect(plan.body).toContain("split into 1 task for what you asked for.");
    expect(plan.body).toContain("(1 check task)");
    expect(plan.body).toContain(`Because you said "No, the hill studio opens first.", work proceeds on: The hill studio opens first.`);
    expect(reports.some((m) => m.body.includes("The team will now do") || m.body.includes("set aside"))).toBe(false);
    // The revision is recorded as told by that one report, so it is never told again on its own.
    const revisions = await db.execute(sql`SELECT requested_by AS "requestedBy", report_id AS "reportId" FROM plan_revisions WHERE project_id = ${projectId}`);
    expect(revisions.rows).toEqual([{ requestedBy: answerId, reportId: plan.id }]);
  });

  // Changing answers folded into one revision are each named in the first-plan report.
  test("two changing answers read before the first plan's report are one revision, and the report names both", async () => {
    const { projectId, questionIds } = await plannedProject({ reported: false, intake: TWO_QUESTION_INTAKE });
    const [studioQuestion, teacherQuestion] = questionIds;
    if (studioQuestion === undefined || teacherQuestion === undefined) throw new Error("intake posted fewer than two questions");
    const first = await contradict(projectId, studioQuestion);
    const second = await contradict(projectId, teacherQuestion, { body: "Yes, name the teacher.", statement: "Each class shows its teacher." });
    expect((await projectRow(projectId)).awaiting).toEqual([first, second]);

    const mock = pipelineModel({ environmentChange: false });
    expect((await replanner().runPending()).map((o) => o.kind)).toEqual(["revised"]);
    const prompts = mock.doGenerateCalls.map((call) => JSON.stringify(call.prompt));
    expect(prompts.some((p) => p.includes("in 2 answers") && p.includes("Each class shows its teacher.") && p.includes("The hill studio opens first."))).toBe(true);
    expect((await projectRow(projectId)).awaiting).toEqual([]);
    const taken = await db.execute(sql`
      SELECT rr.answer_id AS "answerId" FROM replan_requests rr JOIN plan_revisions r ON r.id = rr.plan_revision_id
      WHERE r.project_id = ${projectId} AND r.revision = 2 ORDER BY rr.created_at`);
    expect(taken.rows).toEqual([{ answerId: first }, { answerId: second }]);

    expect(await planReports().runPending()).toEqual([{ kind: "posted", projectId, subject: "first-plan" }]);
    const plan = (await reportsOf(projectId)).find((m) => m.body.startsWith("Ashara has made the first plan"));
    expect(plan?.body).toContain("This plan already takes in your 2 answers that changed it.");
    expect(plan?.body).toContain(`- Because you said "No, the hill studio opens first.", work proceeds on: The hill studio opens first.`);
    expect(plan?.body).toContain(`- Because you said "Yes, name the teacher.", work proceeds on: Each class shows its teacher.`);
  });

  test("a revision recorded as taking in an answer its summary does not name is not reported, and blocks the project", async () => {
    const { projectId, questionIds } = await plannedProject({ reported: false, intake: TWO_QUESTION_INTAKE });
    const [studioQuestion, teacherQuestion] = questionIds;
    if (studioQuestion === undefined || teacherQuestion === undefined) throw new Error("intake posted fewer than two questions");
    await contradict(projectId, studioQuestion);
    await contradict(projectId, teacherQuestion, { body: "Yes, name the teacher.", statement: "Each class shows its teacher." });
    pipelineModel({ environmentChange: false });
    expect((await replanner().runPending()).map((o) => o.kind)).toEqual(["revised"]);
    // The record as COALESCE left it before migration 052: the summary names one change of the two taken in.
    await db.execute(sql`
      UPDATE plan_revisions SET summary = jsonb_set(summary, '{changes}', (summary->'changes') - 1) WHERE project_id = ${projectId}`);

    const outcomes = await planReports().runPending();

    expect(outcomes).toMatchObject([{ kind: "project-blocked", projectId, cause: { errorClass: "RevisionChangesUnrecorded" } }]);
    expect((await reportsOf(projectId)).some((m) => m.body.startsWith("Ashara has made the first plan"))).toBe(false);
  });

  test("a revision of a halted project is told only after it resumes, after the pause and the resumption", async () => {
    const { projectId, questionId } = await plannedProject();
    await contradict(projectId, questionId);
    pipelineModel({ environmentChange: false });
    expect((await replanner().runPending()).map((o) => o.kind)).toEqual(["revised"]);
    const projects = new ProjectHaltRepository(db);
    await projects.block(projectId, { category: "fault", errorClass: "TestFault", reason: "TestFault: a halt written by the test" });

    expect(await planReports().runPending()).toEqual([]);
    expect((await blockReports().runPending()).map((o) => o.kind)).toEqual(["posted"]);
    expect((await reportsOf(projectId)).some((m) => m.body.includes("The team will now do"))).toBe(false);

    await projects.unblock(projectId, "operator-a", "checked the halt");
    expect((await blockReports().runPending()).map((o) => o.kind)).toEqual(["posted"]);
    expect(await planReports().runPending()).toEqual([{ kind: "posted", projectId, subject: "plan-revision" }]);

    const bodies = (await reportsOf(projectId)).map((m) => m.body);
    const paused = bodies.findIndex((b) => b.startsWith("Work on this project is paused."));
    const resumed = bodies.findIndex((b) => b.startsWith("Work on this project has resumed"));
    const willDo = bodies.findIndex((b) => b.includes("The team will now do"));
    expect(paused).toBeGreaterThan(-1);
    expect(paused).toBeLessThan(resumed);
    expect(resumed).toBeLessThan(willDo);
    expect(bodies[paused]).not.toContain("TestFault");
  });
});

describe("a late client change is planned", () => {
  test("after in-flight work ends, a new revision supersedes open work, keeps completed work, clears the flag and is reported once", async () => {
    const { projectId, questionId } = await plannedProject();
    const first = await itemsOf(projectId);
    const sprint0 = first.find((i) => i.origin === "sprint0");
    const check = first.find((i) => i.origin === "check");
    const harbour = first.find((i) => i.origin === "decomposition");
    if (sprint0 === undefined || check === undefined || harbour === undefined) throw new Error("the first plan is not Sprint 0, a check task and a task");
    const epic = first.find((i) => i.level === "Epic");
    if (epic === undefined) throw new Error("the first plan has no Epic");
    await startTask(sprint0.id);
    await completeTask(sprint0.id);
    await db.execute(sql`UPDATE work_items SET merge_commit = ${MERGE_COMMIT} WHERE id = ${sprint0.id}`);
    // The check task is in flight when the client's change arrives; its Epic is InProgress
    // from the first started task and stays so while any child is open.
    await startTask(check.id);

    const answerId = await contradict(projectId, questionId);
    expect((await projectRow(projectId)).awaiting).toEqual([answerId]);

    pipelineModel();
    expect(await replanner().runPending()).toEqual([]);
    const inFlight = (i: (typeof first)[number]) => i.id === check.id || i.id === epic.id;
    expect(await itemsOf(projectId)).toEqual(first.map((i) => ({ ...i, status: i.id === sprint0.id ? "Completed" : inFlight(i) ? "InProgress" : i.status })));

    await completeTask(check.id);
    expect((await itemsOf(projectId)).find((i) => i.id === epic.id)?.status).toBe("InProgress");
    const mock = pipelineModel({ environmentChange: false });
    const outcomes = await replanner().runPending();

    expect(outcomes).toEqual([{ kind: "revised", projectId, revision: 2, cause: "client-change", tasks: 4, superseded: 3, newEnvironment: false }]);
    const prompts = mock.doGenerateCalls.map((call) => JSON.stringify(call.prompt));
    expect(prompts.some((p) => p.includes("Already done, and kept") && p.includes(`merged as ${MERGE_COMMIT}`))).toBe(true);

    const after = await itemsOf(projectId);
    expect(after.find((i) => i.id === sprint0.id)?.status).toBe("Completed");
    expect(after.find((i) => i.id === check.id)?.status).toBe("Completed");
    expect(after.find((i) => i.id === harbour.id)).toMatchObject({
      status: "Abandoned",
      reason: { source: "superseded", planRevision: 2, requestedBy: answerId },
    });
    // The old Epic can no longer settle: it is closed with the work it held.
    expect(after.find((i) => i.id === epic.id)).toMatchObject({
      status: "Abandoned",
      reason: { source: "superseded", planRevision: 2, requestedBy: answerId },
    });
    const added = after.filter((i) => !first.some((f) => f.id === i.id));
    // Written in one transaction, so their created_at ties: compared in a fixed order.
    const shapes = added.map((i) => [i.level, i.origin, i.title]).sort((a, b) => `${a[0]}${a[1]}`.localeCompare(`${b[0]}${b[1]}`));
    expect(shapes).toEqual([
      ["Epic", null, expect.any(String)],
      ["Task", "check", `Write the checks for "Open hill studio bookings"`],
      ["Task", "decomposition", "Open hill studio bookings"],
      ["Task", "product-scaffold", "Set up the product's layout"],
      ["Task", "review", "Review the plan's checks together against the vision"],
    ]);
    // No new environment task: the new work builds on the Sprint 0 already done. The first plan's
    // scaffold was still open, so it is superseded and the revision sets up the layout again on that
    // Sprint 0 (ADR-074 addendum 2 d72 B2); the check and review tasks wait on it.
    const scaffold = added.find((i) => i.origin === "product-scaffold");
    if (scaffold === undefined) throw new Error("the revision planned no product scaffold");
    expect(await dependenciesOf(scaffold.id)).toEqual([sprint0.id]);
    for (const task of added.filter((i) => i.level === "Task" && i.id !== scaffold.id)) {
      expect(await dependenciesOf(task.id)).toContain(task.origin === "decomposition" ? sprint0.id : scaffold.id);
    }
    // The revision's check task names the task it decides by its stored id, and that task waits on it.
    const newCheck = added.find((i) => i.origin === "check");
    const newTask = added.find((i) => i.origin === "decomposition");
    if (newCheck === undefined || newTask === undefined) throw new Error("the revision planned no check task or no task");
    const checksFor = await db.execute(sql`SELECT task_spec->>'checksFor' AS "checksFor" FROM work_items WHERE id = ${newCheck.id}`);
    expect(checksFor.rows).toEqual([{ checksFor: newTask.id }]);
    expect(await dependenciesOf(newTask.id)).toContain(newCheck.id);
    expect(await new TaskCheckRepository(db).checkedTasksOf(newCheck.id)).toEqual([newTask.id]);

    const revisions = await db.execute(sql`SELECT revision, requested_by AS "requestedBy" FROM plan_revisions WHERE project_id = ${projectId}`);
    expect(revisions.rows).toEqual([{ revision: 2, requestedBy: answerId }]);
    expect((await projectRow(projectId)).awaiting).toEqual([]);
    expect(await new ProjectHaltRepository(db).listActiveIds()).toContain(projectId);

    const reportsBefore = (await reportsOf(projectId)).length;
    expect(await planReports().runPending()).toEqual([{ kind: "posted", projectId, subject: "plan-revision" }]);
    expect(await planReports().runPending()).toEqual([]);
    const reports = await reportsOf(projectId);
    expect(reports).toHaveLength(reportsBefore + 1);
    const report = reports[reports.length - 1];
    expect(report?.inReplyTo).toBe(answerId);
    expect(report?.body).toContain(`Because you said "No, the hill studio opens first.", work proceeds on: The hill studio opens first.`);
    expect(report?.body).toContain("- Open hill studio bookings");
    expect(report?.body).toContain("- Open harbour studio bookings");

    // Nothing is flagged any more: no second revision.
    expect(await replanner().runPending()).toEqual([]);
  });

  // A revision's checks are never red-run on Sprint 0's commit, which holds no product to build.
  test("a revision after the scaffold red-runs its checks on the layout's latest merge, never on the environment task merged before it", async () => {
    const { projectId, questionId } = await plannedProject();
    const first = await itemsOf(projectId);
    const sprint0 = first.find((i) => i.origin === "sprint0");
    const scaffold = first.find((i) => i.origin === "product-scaffold");
    const harbour = first.find((i) => i.origin === "decomposition");
    if (sprint0 === undefined || scaffold === undefined || harbour === undefined) throw new Error("the first plan has no Sprint 0, scaffold or task");
    const merged = [
      { id: sprint0.id, commit: "1".repeat(40), minutesAgo: 30 },
      { id: scaffold.id, commit: "2".repeat(40), minutesAgo: 20 },
      { id: harbour.id, commit: "3".repeat(40), minutesAgo: 10 },
    ];
    for (const { id, commit, minutesAgo } of merged) {
      await startTask(id);
      await completeTask(id);
      // Completion times fixed apart: the order the merges landed on main.
      await db.execute(sql`
        UPDATE work_items SET merge_commit = ${commit}, updated_at = now() - make_interval(mins => ${minutesAgo}) WHERE id = ${id}`);
    }
    await contradict(projectId, questionId);
    pipelineModel({ environmentChange: false });
    expect(await replanner().runPending()).toMatchObject([{ kind: "revised", revision: 2, newEnvironment: false }]);

    const added = (await itemsOf(projectId)).filter((i) => !first.some((f) => f.id === i.id));
    expect(added.filter((i) => i.origin === "product-scaffold" || i.origin === "sprint0")).toEqual([]);
    const newCheck = added.find((i) => i.origin === "check");
    const review = added.find((i) => i.origin === "review");
    if (newCheck === undefined || review === undefined) throw new Error("the revision planned no check or review task");
    expect(await dependenciesOf(newCheck.id)).toEqual([harbour.id]);
    expect(await dependenciesOf(review.id)).toContain(harbour.id);
    const checks = new TaskCheckRepository(db);
    expect(await checks.foundationOf(newCheck.id)).toEqual({ kind: "found", taskId: harbour.id, commit: "3".repeat(40) });

    // A check task whose only foundation merged before the product scaffold has no foundation: fail closed.
    await db.execute(sql`UPDATE dependencies SET to_id = ${sprint0.id} WHERE from_id = ${newCheck.id}`);
    const before = await checks.foundationOf(newCheck.id);
    expect(before.kind).toBe("none");
    if (before.kind === "none") expect(before.reason).toContain("not after the project's product scaffold");
  });

  // ADR-083: what a revision need not plan again is what a completed task's stored checks decide, never what it cites.
  test.each([
    { stored: "no checks", decides: undefined },
    { stored: "a check that records no items it decides", decides: null },
    { stored: "a check deciding every item it cites", decides: "cited" },
  ] as const)("a completed task with $stored is exempt only for the items its stored checks decide", async ({ decides }) => {
    const { projectId, questionId } = await plannedProject();
    const first = await itemsOf(projectId);
    const check = first.find((i) => i.origin === "check");
    const harbour = first.find((i) => i.origin === "decomposition");
    if (check === undefined || harbour === undefined) throw new Error("the first plan has no check task or task");
    const spec = await db.execute(sql`SELECT task_spec->'sources' AS sources FROM work_items WHERE id = ${check.id}`);
    const cited = z.array(z.object({ sources: z.array(z.object({ id: z.string(), text: z.string() })) })).parse(spec.rows)[0]?.sources ?? [];
    expect(cited.length).toBeGreaterThan(0);
    await startTask(harbour.id);
    await completeTask(harbour.id);
    if (decides !== undefined) {
      const recorded = decides === null ? null : JSON.stringify(cited.map((item) => item.id));
      await db.execute(sql`
        INSERT INTO task_checks (project_id, task_id, check_task_id, revision, name, command, files, environment_version, decides)
        VALUES (${projectId}, ${harbour.id}, ${check.id}, 1, 'holds', 'true', '[]'::jsonb, ${"e".repeat(64)}, ${recorded}::jsonb)`);
    }
    await contradict(projectId, questionId);
    const mock = pipelineModel({ environmentChange: false });
    expect(await replanner().runPending()).toMatchObject([{ kind: "revised", revision: 2 }]);

    const revision = mock.doGenerateCalls.map((call) => JSON.stringify(call.prompt)).find((p) => p.includes("changed what is built after work began"));
    if (revision === undefined) throw new Error("no revision prompt was sent");
    const listed = /a plan that leaves one uncited is rejected: ([A-Za-z0-9_-]+(?:, [A-Za-z0-9_-]+)*)\./.exec(revision)?.[1]?.split(", ") ?? [];
    // S1, the scope line the answer leaves as it was: a revision plans it again unless a stored check decides it.
    expect(cited.map((item) => item.id)).toContain("S1");
    expect(listed.includes("S1")).toBe(decides !== "cited");
  });

  test("an environment change plans a new environment task, and the old one stays Completed", async () => {
    const { projectId, questionId } = await plannedProject();
    const sprint0 = (await itemsOf(projectId)).find((i) => i.origin === "sprint0");
    if (sprint0 === undefined) throw new Error("the first plan has no Sprint 0");
    await startTask(sprint0.id);
    await completeTask(sprint0.id);
    await contradict(projectId, questionId);

    pipelineModel({ environmentChange: true });
    const outcomes = await replanner().runPending();

    expect(outcomes).toMatchObject([{ kind: "revised", revision: 2, newEnvironment: true }]);
    const items = await itemsOf(projectId);
    const environments = items.filter((i) => i.origin === "sprint0");
    expect(environments.map((i) => i.status)).toEqual(["Completed", "Pending"]);
    const added = items.find((i) => i.title === "Open hill studio bookings");
    if (added === undefined) throw new Error("the revision planned no task");
    expect(await dependenciesOf(added.id)).not.toContain(sprint0.id);
  });

  test("one project whose work items do not read is that project's fault alone: every other project is still revised", async () => {
    const unreadable = await plannedProject();
    const healthy = await plannedProject();
    await contradict(unreadable.projectId, unreadable.questionId);
    await contradict(healthy.projectId, healthy.questionId);
    await db.execute(sql`UPDATE work_items SET success_criteria = '{"not": "criteria"}'::jsonb WHERE project_id = ${unreadable.projectId} AND level = 'Task'`);
    pipelineModel();

    const containment = memoryStepContainment(() => false);
    const outcomes = await replanner(containment).runPending();

    expect(outcomes).toEqual([
      expect.objectContaining({ kind: "step-faulted", step: "replan", subjectId: unreadable.projectId, error: expect.stringContaining("WorkItemRowCorrupt") }),
      expect.objectContaining({ kind: "revised", projectId: healthy.projectId }),
    ]);
    expect(containment.recorded.get(`replan/${unreadable.projectId}`)).toMatchObject({ faults: 1 });
  });

  test("past the bound of revisions the project is blocked, not revised, and the client is told once", async () => {
    const { projectId, questionId } = await plannedProject();
    const answerId = await contradict(projectId, questionId);
    // Three earlier revisions, each already reported: only the block is due.
    for (const revision of [2, 3, 4]) {
      const report = await db.execute(sql`INSERT INTO client_messages (project_id, direction, kind, body)
        VALUES (${projectId}, 'outbound', 'report', 'earlier revision') RETURNING id`);
      const [row] = z.array(z.object({ id: z.string() })).parse(report.rows);
      await db.execute(sql`INSERT INTO plan_revisions (project_id, revision, vision_version, requested_by, summary, report_id)
        VALUES (${projectId}, ${revision}, 1, ${answerId}, '{}'::jsonb, ${row?.id ?? null})`);
    }
    const mock = pipelineModel();

    const outcomes = await replanner().runPending();

    expect(outcomes).toMatchObject([{ kind: "project-blocked", projectId, cause: { category: "replan_bound", errorClass: "ReplanBoundReached" } }]);
    expect(mock.doGenerateCalls).toHaveLength(0);
    expect(await projectRow(projectId)).toEqual({ status: "blocked", awaiting: [answerId], category: "replan_bound" });
    const before = (await reportsOf(projectId)).length;
    expect((await blockReports().runPending()).map((o) => o.kind)).toEqual(["posted"]);
    expect(await blockReports().runPending()).toEqual([]);
    const reports = await reportsOf(projectId);
    expect(reports).toHaveLength(before + 1);
    // The recorded kind in the client's words; the replanner's ReplanBoundReached chain stays in the record.
    expect(reports[reports.length - 1]?.body).toContain("Ashara recorded the cause as this: the plan has been revised for your changes");
    expect(reports[reports.length - 1]?.body).not.toContain("ReplanBoundReached");
  });

  // A revision whose every attempt got no usable answer from the planning model is the model's
  // failure, not Ashara's machinery: the halt says so, never "a step of Ashara's own work failed".
  test("a revision the planning model never answers usably halts as replan_stopped, and the client is told what failed", async () => {
    const { projectId, questionId } = await plannedProject();
    await contradict(projectId, questionId);
    pipelineModel({ revision: { notTasks: "the model's answer does not hold together" } });

    const kinds: string[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) kinds.push(...(await replanner().runPending()).map((outcome) => outcome.kind));

    expect(kinds).toEqual(["failed", "failed", "project-blocked"]);
    expect(await projectRow(projectId)).toMatchObject({ status: "blocked", category: "replan_stopped" });
    expect((await blockReports().runPending()).map((o) => o.kind)).toEqual(["posted"]);
    const reports = await reportsOf(projectId);
    const body = reports[reports.length - 1]?.body ?? "";
    expect(body).toContain(
      "Ashara recorded the cause as this: every attempt to revise the plan failed, the last because the model planning it gave no usable answer.",
    );
    expect(body).not.toContain("a step of Ashara's own work");
    expect(body).not.toContain("ReplanAttemptsExhausted");
  });

  // A cycle that counted the last attempt and stopped before its halt was written (a restart) leaves
  // the exhaustion on record: the next cycle halts from it, blamed as the counting cycle blamed it.
  test("a revision whose attempts ran out before its halt was written halts from its record, blamed by the failure it recorded", async () => {
    const counted = await plannedProject();
    await contradict(counted.projectId, counted.questionId);
    const legacy = await plannedProject();
    await contradict(legacy.projectId, legacy.questionId);
    const store = createReplanStore(db);
    for (let attempt = 0; attempt < 3; attempt += 1) await store.recordFailedAttempt(counted.projectId, "stub provider unavailable", "provider");
    // A row counted before its failure was recorded (migration 066) names no party.
    await db.execute(sql`UPDATE projects SET replan_attempts = 3, replan_last_error = 'an earlier attempt failed' WHERE id = ${legacy.projectId}`);
    const mock = pipelineModel({ revision: { notTasks: "never asked" } });

    const outcomes = await replanner().runPending();

    expect(outcomes.map((outcome) => outcome.kind)).toEqual(["project-blocked", "project-blocked"]);
    expect(mock.doGenerateCalls).toHaveLength(0);
    expect(await projectRow(counted.projectId)).toMatchObject({ status: "blocked", category: "replan_provider_failed" });
    expect(await projectRow(legacy.projectId)).toMatchObject({ status: "blocked", category: "fault" });
  });

  // The gateway wraps every failure with no fallback left in ProviderError: one the provider's HTTP
  // error or silence caused is not the model's, and one Ashara's own code threw is Ashara's, never
  // counted toward the revision's bound.
  test("a revision whose provider fails every request halts as replan_provider_failed; a fault in Ashara's code is contained, never counted", async () => {
    const failingWith = async (thrown: Error): Promise<ProjectId> => {
      const { projectId, questionId } = await plannedProject();
      await contradict(projectId, questionId);
      stub.model = new MockLanguageModelV4({
        doGenerate: async () => {
          throw thrown;
        },
      });
      return projectId;
    };

    const unanswered = await failingWith(
      new APICallError({ message: "Service Unavailable", url: "https://stub.invalid/v1", requestBodyValues: {}, statusCode: 503, isRetryable: true }),
    );
    const kinds: string[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) kinds.push(...(await replanner().runPending()).map((outcome) => outcome.kind));
    expect(kinds).toEqual(["failed", "failed", "project-blocked"]);
    expect(await projectRow(unanswered)).toMatchObject({ status: "blocked", category: "replan_provider_failed" });

    const broken = await failingWith(new TypeError("Cannot read properties of undefined"));
    const containment = memoryStepContainment(() => false);
    expect(await replanner(containment).runPending()).toEqual([
      expect.objectContaining({ kind: "step-faulted", step: "replan", subjectId: broken, error: expect.stringContaining("Cannot read properties") }),
    ]);
    // Waiting out its backoff, the project is not replanned again, and nothing was counted against it.
    expect(await replanner(containment).runPending()).toEqual([]);
    expect(await projectRow(broken)).toMatchObject({ category: null });
    const attempts = await db.execute(sql`SELECT replan_attempts AS "attempts" FROM projects WHERE id = ${broken}`);
    expect(z.array(z.object({ attempts: z.number() })).parse(attempts.rows)).toEqual([{ attempts: 0 }]);

    expect((await blockReports().runPending()).map((o) => o.kind)).toEqual(["posted"]);
    const body = (await reportsOf(unanswered)).at(-1)?.body ?? "";
    expect(body).toContain(
      "Ashara recorded the cause as this: every attempt to revise the plan failed, the last because the service that runs the model planning it returned an error or did not answer, so no answer was read.",
    );
    expect(body).not.toContain("gave no usable answer");
  });
});

/** Starts, fails and gives up a task as a dispatch's failure and the failure router's abandonment do. */
async function giveUp(id: string, attempts: number): Promise<void> {
  await startTask(id);
  const repo = adaptWorkItemRepo(new WorkItemRowRepository(db));
  const task = await PlanningService.findWorkItem(repo, parseWorkItemId(id, "test"));
  if (task === null) throw new Error(`task ${id} not found`);
  failWorkItem(task, { source: "task_failed", reason: "the check author's red run kept failing" }, { kind: "retryable", ground: "work" });
  await PlanningService.saveWorkItem(repo, task, "InProgress");
  const failure = { detail: "red run on the foundation: REJECTED, the set: no check of the set fails on the foundation", raw: {} };
  const decision = await recoverFailedItem(
    {
      workItemRepo: repo,
      eventPublisher: { publish: async () => {} },
      failureRouter: { route: () => ({ action: "abandon", reason: `the task failed ${attempts} time(s)`, attempts, failure }) },
    },
    task,
    failure,
    { kind: "retryable", ground: "work" },
  );
  expect(decision).toBe("abandon");
}

/** Pending tasks of our projects only, gated as the core loop gates them. */
async function gateOurs(): Promise<void> {
  const projects = new ProjectHaltRepository(db);
  await PlanningService.gate(
    adaptWorkItemRepo(new WorkItemRowRepository(db)),
    { listActiveIds: async () => (await projects.listActiveIds()).filter((id) => ourProjects.has(id)), block: (id, cause) => projects.block(id, cause) },
    { publish: async () => {} },
    memoryStepContainment(() => true),
  );
}

// ADR-074 addendum 2 d74 D: a task the failure router gave up parked every task depending on it as
// dependency_unsatisfiable, each for the operator. The project is held and its plan repaired instead.
describe("a task the team gives up is planned around", () => {
  test("the project is held, no dependent is parked, and a repair supersedes the open work around the given-up task and is reported once", async () => {
    const { projectId } = await plannedProject();
    const first = await itemsOf(projectId);
    const sprint0 = first.find((i) => i.origin === "sprint0");
    const check = first.find((i) => i.origin === "check");
    const harbour = first.find((i) => i.origin === "decomposition");
    if (sprint0 === undefined || check === undefined || harbour === undefined) throw new Error("the first plan is not Sprint 0, a check task and a task");
    await startTask(sprint0.id);
    await completeTask(sprint0.id);
    await db.execute(sql`UPDATE work_items SET merge_commit = ${MERGE_COMMIT} WHERE id = ${sprint0.id}`);

    await giveUp(check.id, 3);

    expect(await new ProjectHaltRepository(db).listActiveIds()).not.toContain(projectId);
    await gateOurs();
    const held = await itemsOf(projectId);
    expect(held.find((i) => i.id === harbour.id)?.status).toBe("Pending");
    expect(held.filter((i) => z.object({ source: z.literal("dependency_unsatisfiable") }).safeParse(i.reason).success)).toEqual([]);

    const mock = pipelineModel();
    const outcomes = await replanner().runPending();

    expect(outcomes).toMatchObject([{ kind: "revised", projectId, revision: 2, cause: "repair", newEnvironment: false }]);
    const prompts = mock.doGenerateCalls.map((call) => JSON.stringify(call.prompt));
    expect(prompts.some((p) => p.includes(`after 3 attempt(s)`) && p.includes("no check of the set fails on the foundation"))).toBe(true);
    const after = await itemsOf(projectId);
    expect(after.find((i) => i.id === check.id)).toMatchObject({ status: "Abandoned", reason: { source: "failure_given_up" } });
    expect(after.find((i) => i.id === harbour.id)).toMatchObject({
      status: "Abandoned",
      reason: { source: "superseded", planRevision: 2, requestedBy: null, repairOf: [check.id] },
    });
    expect(after.some((i) => i.title === "Book a harbour class by its date" && i.status === "Pending")).toBe(true);
    const revisions = await db.execute(sql`SELECT revision, kind, requested_by AS "requestedBy" FROM plan_revisions WHERE project_id = ${projectId}`);
    expect(revisions.rows).toEqual([{ revision: 2, kind: "repair", requestedBy: null }]);
    const repairs = await db.execute(sql`SELECT work_item_id AS "id", plan_revision_id IS NOT NULL AS "answered" FROM plan_repairs WHERE project_id = ${projectId}`);
    expect(repairs.rows).toEqual([{ id: check.id, answered: true }]);
    expect(await new ProjectHaltRepository(db).listActiveIds()).toContain(projectId);

    expect(await planReports().runPending()).toEqual([{ kind: "posted", projectId, subject: "plan-revision" }]);
    expect(await planReports().runPending()).toEqual([]);
    const reports = await reportsOf(projectId);
    const report = reports[reports.length - 1];
    expect(report?.inReplyTo).toBeNull();
    expect(report?.body).toContain(`- ${check.title}`);
    expect(report?.body).toContain("what you asked for has not changed");
    expect(await replanner().runPending()).toEqual([]);
  });

  // Story s-loop-never-stop-m1 W6: a check task given up for a cause the
  // failure router never saw (here a dispute past its bound) is repaired, never left for a person.
  test("a check task given up past its dispute bound is repaired like any give-up, with the dispute as its evidence", async () => {
    const { projectId } = await plannedProject();
    const first = await itemsOf(projectId);
    const sprint0 = first.find((i) => i.origin === "sprint0");
    const check = first.find((i) => i.origin === "check");
    if (sprint0 === undefined || check === undefined) throw new Error("the first plan is not Sprint 0 and a check task");
    await startTask(sprint0.id);
    await completeTask(sprint0.id);
    await db.execute(sql`UPDATE work_items SET merge_commit = ${MERGE_COMMIT} WHERE id = ${sprint0.id}`);

    await startTask(check.id);
    const repo = adaptWorkItemRepo(new WorkItemRowRepository(db));
    const task = await PlanningService.findWorkItem(repo, parseWorkItemId(check.id, "test"));
    if (task === null) throw new Error(`task ${check.id} not found`);
    giveUpWorkItem(task, { source: "check_disputed", checkTaskId: check.id, checkName: "books", reason: "disputed 3 time(s), past the bound of 2: the check reads a file no task writes" });
    await PlanningService.saveWorkItem(repo, task, "InProgress");

    expect(await new ProjectHaltRepository(db).listActiveIds()).not.toContain(projectId);
    const mock = pipelineModel();
    expect(await replanner().runPending()).toMatchObject([{ kind: "revised", projectId, revision: 2, cause: "repair" }]);
    const prompts = mock.doGenerateCalls.map((call) => JSON.stringify(call.prompt));
    expect(prompts.some((p) => p.includes("the check reads a file no task writes"))).toBe(true);
    expect(await new ProjectHaltRepository(db).listActiveIds()).toContain(projectId);
  });

  test("past the bound of repairs the next abandonment blocks the project with one report naming the task given up", async () => {
    const { projectId } = await plannedProject();
    const sprint0 = (await itemsOf(projectId)).find((i) => i.origin === "sprint0");
    if (sprint0 === undefined) throw new Error("the first plan has no Sprint 0");
    await startTask(sprint0.id);
    await completeTask(sprint0.id);

    const givenUp: string[] = [];
    for (const round of [1, 2, 3]) {
      const open = (await itemsOf(projectId)).find((i) => i.origin === "check" && i.status === "Pending");
      if (open === undefined) throw new Error(`round ${round}: no open check task to give up`);
      givenUp.push(open.title);
      await giveUp(open.id, 3);
      pipelineModel();
      const outcomes = await replanner().runPending();
      if (round < 3) {
        expect(outcomes, `round ${round}`).toMatchObject([{ kind: "revised", cause: "repair", revision: round + 1 }]);
        expect(await planReports().runPending()).toMatchObject([{ kind: "posted" }]);
      } else {
        expect(outcomes).toMatchObject([{ kind: "project-blocked", projectId, cause: { category: "plan_repair", errorClass: "PlanRepairBoundReached" } }]);
      }
    }

    expect(await projectRow(projectId)).toMatchObject({ status: "blocked", category: "plan_repair" });
    await gateOurs();
    const items = await itemsOf(projectId);
    expect(items.filter((i) => z.object({ source: z.literal("dependency_unsatisfiable") }).safeParse(i.reason).success)).toEqual([]);
    const before = (await reportsOf(projectId)).length;
    expect((await blockReports().runPending()).map((o) => o.kind)).toEqual(["posted"]);
    expect(await blockReports().runPending()).toEqual([]);
    const reports = await reportsOf(projectId);
    expect(reports).toHaveLength(before + 1);
    const body = reports[reports.length - 1]?.body ?? "";
    expect(body).toContain(`"${givenUp[2] ?? ""}", after`);
    expect(body).toContain("Ashara recorded why it was given up as this: ");
    expect(body).not.toContain(givenUp[0] ?? "");
  });
});

// Story s-loop-never-stop-m1 W6: a task no roster role can work is never parked at Blocked until a
// newer roster revision, which no production path writes (recordFirstRoster refuses any revision
// but 1). It is given up instead, and the repair staffs its new tasks.
describe("a task no roster role can work is planned around, never left waiting", () => {
  test("staffing finds no owner; the sweep gives the Blocked task up; the repair re-plans it with an owner the staffing resolves", async () => {
    const { projectId } = await plannedProject();
    const first = await itemsOf(projectId);
    const sprint0 = first.find((i) => i.origin === "sprint0");
    const harbour = first.find((i) => i.origin === "decomposition");
    if (sprint0 === undefined || harbour === undefined) throw new Error("the first plan is not Sprint 0 and a task");
    await startTask(sprint0.id);
    await completeTask(sprint0.id);
    await db.execute(sql`UPDATE work_items SET merge_commit = ${MERGE_COMMIT} WHERE id = ${sprint0.id}`);
    // A task planned before owners were assigned (migration 031): no work kind and no owner.
    await db.execute(sql`UPDATE work_items SET owner_role_id = NULL, work_kind = NULL WHERE id = ${harbour.id}`);

    const workItems = new WorkItemRowRepository(db);
    const staffing = createAgentStaffing({
      async ownerOf(taskId) {
        const row = await workItems.findById(taskId);
        return row === null ? { kind: "absent" } : { kind: "found", ownerRoleId: row.ownerRoleId };
      },
      latestRosterRows: (id) => latestRosterRoles(db, id),
      latestRosterRevision: (id) => latestRosterRevision(db, id),
      resolveModel: () => gateway.resolveModel("Strong", "agent-runner"),
    });
    const staffOf = (id: string) =>
      staffing.staff({ id: parseWorkItemId(id, "test"), projectId, title: "t", epicId: null, dispatchCount: 1, attempt: 1, workKind: "implementation", successCriteria: [] });
    const unresolved = await staffOf(harbour.id);
    if (unresolved.kind !== "owner-unresolved") throw new Error(`expected owner-unresolved, got ${unresolved.kind}`);

    // A Blocked owner_unresolved row, as a stored row from an earlier dispatch holds it.
    await startTask(harbour.id);
    const reason = { source: "owner_unresolved", ownerRoleId: unresolved.ownerRoleId, rosterRevision: unresolved.rosterRevision, reason: unresolved.reason };
    await db.execute(sql`UPDATE work_items SET status = 'Blocked', blocked_reason = ${JSON.stringify(reason)}::jsonb WHERE id = ${harbour.id}`);
    expect(await latestRosterRevision(db, projectId)).toBe(1);

    const published: DomainEvent[] = [];
    const left = await releaseClearedBlocks({
      workItemRepo: adaptWorkItemRepo(workItems),
      eventStore: { publish: async (event: DomainEvent) => void published.push(event) },
      projects: { listActiveIds: async () => [projectId], get: (id) => new ProjectHaltRepository(db).get(id) },
      workdirBase: tmpdir(),
      containment: memoryStepContainment(() => true),
    });

    expect(left).toBe(1);
    expect(published.map((e) => e.eventType)).toEqual(["work_item.given_up"]);
    const givenUp = await PlanningService.findWorkItem(adaptWorkItemRepo(workItems), parseWorkItemId(harbour.id, "test"));
    expect(givenUp).toMatchObject({ status: "Abandoned", blockedReason: reason });

    const mock = pipelineModel();
    expect(await replanner().runPending()).toMatchObject([{ kind: "revised", projectId, revision: 2, cause: "repair" }]);
    const prompts = mock.doGenerateCalls.map((call) => JSON.stringify(call.prompt));
    expect(prompts.some((p) => p.includes("No role of the team's roster could be assigned it"))).toBe(true);
    const repaired = (await itemsOf(projectId)).find((i) => i.title === "Book a harbour class by its date" && i.status === "Pending");
    if (repaired === undefined) throw new Error("the repair planned no new task");
    expect((await staffOf(repaired.id)).kind).toBe("staffed");
    expect(await new ProjectHaltRepository(db).listActiveIds()).toContain(projectId);
  });
});
