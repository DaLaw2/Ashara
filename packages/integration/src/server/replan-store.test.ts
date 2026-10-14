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
  latestRosterRevision,
  latestRosterRoles,
  LlmCallRepository,
  ProjectRepository,
  TaskCheckRepository,
  WorkItemRepository,
} from "@ashara/db";
import { BlockReports, ClientAnswers, PlanReports, TenderIntake } from "@ashara/engagement";
import type { AnswerStore, BlockReportStore, IntakeStore, PlanReportStore } from "@ashara/engagement";
import { LlmCallLedger, SpendCap } from "@ashara/finance";
import { buildGateway, sdkLanguageModels } from "@ashara/llm-gateway";
import type { LLMGateway, ModelConfig } from "@ashara/llm-gateway";
import { releaseClearedBlocks } from "@ashara/orchestrator";
import { RosterDerivation } from "@ashara/organization";
import type { RosterStore } from "@ashara/organization";
import { FirstPlanner, PlanningService, Replanner, failWorkItem, giveUpWorkItem, recoverFailedItem, startWorkItem } from "@ashara/planning";
import type { FirstPlanStore, ReplanStore } from "@ashara/planning";
import { parseWorkItemId, type DomainEvent, type ProjectId } from "@ashara/shared";
import { createAnswerStore } from "@ashara/server/answer-store";
import { createBlockReportStore } from "@ashara/server/block-report-store";
import { createFirstPlanStore, createPlanReportStore } from "@ashara/server/first-plan-store";
import { createIntakeStore } from "@ashara/server/intake-store";
import { createReplanStore } from "@ashara/server/replan-store";
import { createRosterStore } from "@ashara/server/roster-store";
import { createAgentStaffing } from "@ashara/server/staffing";
import { adaptWorkItemRepo } from "@ashara/server/work-item-adapter";

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
  scopeBoundaries: ["In: class booking for both studios", "Out: payments"],
  assumptions: [{ statement: "Bookings need no account.", rationale: "The tender says walk-in customers book." }],
  questions: [
    {
      text: "Which studio opens first?",
      whyItMatters: "It orders the work.",
      assumption: { statement: "The harbour studio opens first.", rationale: "The tender names it first." },
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
const FIRST_TASKS = {
  tasks: [
    {
      ref: "t1", title: "Open harbour studio bookings", description: "Harbour bookings.", dependsOn: [],
      endState: "Harbour classes can be booked", scope: "harbour bookings", deliverables: ["harbour booking"], visionItems: ["S1"],
      capability: "Medium", capabilityReason: "graded for the test",
    },
  ],
};
const REVISED_TASKS = {
  tasks: [
    {
      ref: "t1", title: "Open hill studio bookings", description: "Hill bookings.", dependsOn: [],
      endState: "Hill classes can be booked", scope: "hill bookings", deliverables: ["hill booking"], visionItems: ["S1"],
      capability: "Light", capabilityReason: "graded for the test",
    },
  ],
};

const REPAIRED_TASKS = {
  tasks: [
    {
      ref: "t1", title: "Book a harbour class by its date", description: "Harbour bookings, smaller.", dependsOn: [],
      endState: "A harbour class can be booked by its date", scope: "harbour bookings by date", deliverables: ["harbour booking"], visionItems: ["S1"],
      capability: "Medium", capabilityReason: "graded for the test",
    },
  ],
};

/** One model for every call, answering each by what its prompt asks. */
function pipelineModel(options: { readonly reading?: unknown; readonly environmentChange?: boolean } = {}): MockLanguageModelV4 {
  const mock = new MockLanguageModelV4({
    doGenerate: async (call) => {
      const prompt = JSON.stringify(call.prompt);
      if (prompt.includes("Read their answer and say what it does")) return jsonResult(options.reading ?? { verdict: "confirms" });
      if (prompt.includes("prepare the first version of the project's vision")) return jsonResult(INTAKE);
      if (prompt.includes("structured knowledge graph")) return jsonResult(KNOWLEDGE);
      if (prompt.includes("client-comms")) return jsonResult(ROSTER);
      if (prompt.includes("needs the project environment changed") || prompt.includes("Work on a project stopped")) {
        return jsonResult({ environmentChange: options.environmentChange ?? false, reason: "Only what is booked changes." });
      }
      if (prompt.includes("changed what is built after work began")) return jsonResult(REVISED_TASKS);
      if (prompt.includes("Plan the work still to do again")) return jsonResult(REPAIRED_TASKS);
      return jsonResult(FIRST_TASKS);
    },
  });
  stub.model = mock;
  return mock;
}

function ours<T extends { readonly projectId: string }>(list: () => Promise<readonly T[]>): () => Promise<T[]> {
  return async () => (await list()).filter((row) => ourProjects.has(row.projectId));
}

function replanner(): Replanner {
  const store = createReplanStore(db);
  const narrowed: ReplanStore = { ...store, projectsAwaitingReplan: ours(() => store.projectsAwaitingReplan()) };
  return new Replanner({ llm: gateway, store: narrowed });
}

function planReports(): PlanReports {
  const store = createPlanReportStore(db);
  const narrowed: PlanReportStore = {
    ...store,
    dueReports: ours(() => store.dueReports()),
    dueRevisionReports: ours(() => store.dueRevisionReports()),
  };
  return new PlanReports(narrowed);
}

function blockReports(): BlockReports {
  const store = createBlockReportStore(db);
  const narrowed: BlockReportStore = { ...store, dueReports: ours(() => store.dueReports()) };
  return new BlockReports(narrowed);
}

/** A tender taken in, its roster derived and its first plan written: Sprint 0, a check task and one task. */
async function plannedProject(): Promise<{ projectId: ProjectId; questionId: string }> {
  const created = await createProjectWithTender(db, clientId, `${NAME_PREFIX}-${randomUUID().slice(0, 6)}`, "Booking page for my two pottery studios.");
  const projectId = created.project.id;
  ourProjects.add(projectId);
  pipelineModel();
  const intakeStore = createIntakeStore(db);
  const intake: IntakeStore = { ...intakeStore, openTenders: ours(() => intakeStore.openTenders()) };
  expect((await new TenderIntake({ llm: gateway, store: intake }).runPending()).map((o) => o.kind)).toEqual(["recorded"]);
  const rosterStore = createRosterStore(db);
  const roster: RosterStore = { ...rosterStore, projectsAwaitingRoster: ours(() => rosterStore.projectsAwaitingRoster()) };
  expect((await new RosterDerivation({ llm: gateway, store: roster }).runPending()).map((o) => o.kind)).toEqual(["recorded"]);
  const planStore = createFirstPlanStore(db);
  const plan: FirstPlanStore = { ...planStore, projectsAwaitingPlan: ours(() => planStore.projectsAwaitingPlan()) };
  expect((await new FirstPlanner({ llm: gateway, store: plan }).runPending()).map((o) => o.kind)).toEqual(["planned"]);
  expect((await planReports().runPending()).map((o) => o.kind)).toEqual(["posted"]);
  const question = (await new ClientMessageRepository(db).listByProject(projectId)).find((m) => m.kind === "question");
  if (question === undefined) throw new Error("intake posted no question");
  return { projectId, questionId: question.id };
}

/** The client's answer changing the plan's assumption, read by the Liaison: the project is flagged. */
async function contradict(projectId: ProjectId, questionId: string): Promise<string> {
  const row = await new ClientMessageRepository(db).insertInbound({
    projectId,
    kind: "answer",
    body: "No, the hill studio opens first.",
    inReplyTo: questionId,
  });
  pipelineModel({ reading: { verdict: "changes", statement: "The hill studio opens first." } });
  const answerStore = createAnswerStore(db);
  const narrowed: AnswerStore = { ...answerStore, openAnswers: ours(() => answerStore.openAnswers()) };
  const outcomes = await new ClientAnswers({ llm: gateway, store: narrowed }).runPending();
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
  const repo = adaptWorkItemRepo(new WorkItemRepository(db));
  const task = await PlanningService.findWorkItem(repo, parseWorkItemId(id, "test"));
  if (task === null) throw new Error(`task ${id} not found`);
  startWorkItem(task);
  await PlanningService.saveWorkItem(repo, task, "Pending");
  await PlanningService.activateAncestors(repo, task.parentId);
}

/** Completes a started task as its routed success does, settling its Epic when every child is done. */
async function completeTask(id: string): Promise<void> {
  await PlanningService.route(adaptWorkItemRepo(new WorkItemRepository(db)), parseWorkItemId(id, "test"), true);
}

async function dependenciesOf(id: string): Promise<string[]> {
  const result = await db.execute(sql`SELECT to_id AS "to" FROM dependencies WHERE from_id = ${id}`);
  return z.array(z.object({ to: z.string() })).parse(result.rows).map((row) => row.to);
}

async function projectRow(projectId: ProjectId) {
  const result = await db.execute(sql`
    SELECT status, replan_requested_by AS "flag", blocked_category AS "category" FROM projects WHERE id = ${projectId}`);
  const [row] = z.array(z.object({ status: z.string(), flag: z.string().nullable(), category: z.string().nullable() })).parse(result.rows);
  if (row === undefined) throw new Error(`project ${projectId} not found`);
  return row;
}

async function reportsOf(projectId: ProjectId) {
  return (await new ClientMessageRepository(db).listByProject(projectId)).filter((m) => m.kind === "report");
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
          models: [model("replan-strong", "Strong"), model("replan-frontier", "Frontier")],
          enabled: true,
        },
      ],
      defaultProvider: "deepseek",
    },
    checkedSources: ["test"],
    recording: {
      kind: "recorded",
      recorder: new LlmCallLedger(
        new LlmCallRepository(db),
        new SpendCap({ ledger: new LlmCallRepository(db), projects: new ProjectRepository(db), caps: TEST_SPEND_CAPS }),
      ),
    },
    clock: () => new Date(),
  });
});

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  ourProjects.clear();
});

afterAll(async () => {
  const pattern = `${NAME_PREFIX}%`;
  const projects = sql`SELECT id FROM projects WHERE name LIKE ${pattern}`;
  await db.execute(sql`UPDATE projects SET replan_requested_by = NULL WHERE name LIKE ${pattern}`);
  await db.execute(sql`DELETE FROM plan_revisions WHERE project_id IN (${projects})`);
  await db.execute(sql`DELETE FROM project_blocks WHERE project_id IN (${projects})`);
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
    expect((await projectRow(projectId)).flag).toBe(answerId);

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
    expect((await projectRow(projectId)).flag).toBeNull();
    expect(await new ProjectRepository(db).listActiveIds()).toContain(projectId);

    const reportsBefore = (await reportsOf(projectId)).length;
    expect(await planReports().runPending()).toEqual([{ kind: "posted", projectId, subject: "plan-revision" }]);
    expect(await planReports().runPending()).toEqual([]);
    const reports = await reportsOf(projectId);
    expect(reports).toHaveLength(reportsBefore + 1);
    const report = reports[reports.length - 1];
    expect(report?.inReplyTo).toBe(answerId);
    expect(report?.body).toContain(`Because you said "No, the hill studio opens first."`);
    expect(report?.body).toContain("- Open hill studio bookings");
    expect(report?.body).toContain("- Open harbour studio bookings");

    // Nothing is flagged any more: no second revision.
    expect(await replanner().runPending()).toEqual([]);
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
    expect(await projectRow(projectId)).toEqual({ status: "blocked", flag: answerId, category: "replan_bound" });
    const before = (await reportsOf(projectId)).length;
    expect((await blockReports().runPending()).map((o) => o.kind)).toEqual(["posted"]);
    expect(await blockReports().runPending()).toEqual([]);
    const reports = await reportsOf(projectId);
    expect(reports).toHaveLength(before + 1);
    expect(reports[reports.length - 1]?.body).toContain("the plan has already been revised for your changes");
  });
});

/** Starts, fails and gives up a task as a dispatch's failure and the failure router's abandonment do. */
async function giveUp(id: string, attempts: number): Promise<void> {
  await startTask(id);
  const repo = adaptWorkItemRepo(new WorkItemRepository(db));
  const task = await PlanningService.findWorkItem(repo, parseWorkItemId(id, "test"));
  if (task === null) throw new Error(`task ${id} not found`);
  failWorkItem(task, { source: "task_failed", reason: "the check author's red run kept failing" });
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
  );
  expect(decision).toBe("abandon");
}

/** Pending tasks of our projects only, gated as the core loop gates them. */
async function gateOurs(): Promise<void> {
  const projects = new ProjectRepository(db);
  await PlanningService.gate(
    adaptWorkItemRepo(new WorkItemRepository(db)),
    { listActiveIds: async () => (await projects.listActiveIds()).filter((id) => ourProjects.has(id)), block: (id, cause) => projects.block(id, cause) },
    { publish: async () => {} },
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

    expect(await new ProjectRepository(db).listActiveIds()).not.toContain(projectId);
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
    expect(after.find((i) => i.id === check.id)).toMatchObject({ status: "Abandoned", reason: { source: "failure_router" } });
    expect(after.find((i) => i.id === harbour.id)).toMatchObject({
      status: "Abandoned",
      reason: { source: "superseded", planRevision: 2, requestedBy: null, repairOf: [check.id] },
    });
    expect(after.some((i) => i.title === "Book a harbour class by its date" && i.status === "Pending")).toBe(true);
    const revisions = await db.execute(sql`SELECT revision, kind, requested_by AS "requestedBy" FROM plan_revisions WHERE project_id = ${projectId}`);
    expect(revisions.rows).toEqual([{ revision: 2, kind: "repair", requestedBy: null }]);
    const repairs = await db.execute(sql`SELECT work_item_id AS "id", plan_revision_id IS NOT NULL AS "answered" FROM plan_repairs WHERE project_id = ${projectId}`);
    expect(repairs.rows).toEqual([{ id: check.id, answered: true }]);
    expect(await new ProjectRepository(db).listActiveIds()).toContain(projectId);

    expect(await planReports().runPending()).toEqual([{ kind: "posted", projectId, subject: "plan-revision" }]);
    expect(await planReports().runPending()).toEqual([]);
    const reports = await reportsOf(projectId);
    const report = reports[reports.length - 1];
    expect(report?.inReplyTo).toBeNull();
    expect(report?.body).toContain(`- ${check.title}`);
    expect(report?.body).toContain("what you asked for has not changed");
    expect(await replanner().runPending()).toEqual([]);
  });

  // Story s-loop-never-stop-m1 W6, the second run's M2 shape: a check task given up for a cause the
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
    const repo = adaptWorkItemRepo(new WorkItemRepository(db));
    const task = await PlanningService.findWorkItem(repo, parseWorkItemId(check.id, "test"));
    if (task === null) throw new Error(`task ${check.id} not found`);
    giveUpWorkItem(task, { source: "check_disputed", checkTaskId: check.id, checkName: "books", reason: "disputed 3 time(s), past the bound of 2: the check reads a file no task writes" });
    await PlanningService.saveWorkItem(repo, task, "InProgress");

    expect(await new ProjectRepository(db).listActiveIds()).not.toContain(projectId);
    const mock = pipelineModel();
    expect(await replanner().runPending()).toMatchObject([{ kind: "revised", projectId, revision: 2, cause: "repair" }]);
    const prompts = mock.doGenerateCalls.map((call) => JSON.stringify(call.prompt));
    expect(prompts.some((p) => p.includes("the check reads a file no task writes"))).toBe(true);
    expect(await new ProjectRepository(db).listActiveIds()).toContain(projectId);
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
    expect(body).toContain(`"${givenUp[2] ?? ""}" (after`);
    expect(body).not.toContain(givenUp[0] ?? "");
  });
});

// Story s-loop-never-stop-m1 W6, the verifier's finding: a task no roster role can work was parked
// at Blocked until a newer roster revision, which no production path writes (recordFirstRoster
// refuses any revision but 1). It is given up instead, and the repair staffs its new tasks.
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

    const workItems = new WorkItemRepository(db);
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
      staffing.staff({ id: parseWorkItemId(id, "test"), projectId, title: "t", dispatchCount: 1, attempt: 1, workKind: "implementation", successCriteria: [] });
    const unresolved = await staffOf(harbour.id);
    if (unresolved.kind !== "owner-unresolved") throw new Error(`expected owner-unresolved, got ${unresolved.kind}`);

    // A Blocked owner_unresolved row as the dispatch wrote it before this change.
    await startTask(harbour.id);
    const reason = { source: "owner_unresolved", ownerRoleId: unresolved.ownerRoleId, rosterRevision: unresolved.rosterRevision, reason: unresolved.reason };
    await db.execute(sql`UPDATE work_items SET status = 'Blocked', blocked_reason = ${JSON.stringify(reason)}::jsonb WHERE id = ${harbour.id}`);
    expect(await latestRosterRevision(db, projectId)).toBe(1);

    const published: DomainEvent[] = [];
    const left = await releaseClearedBlocks({
      workItemRepo: adaptWorkItemRepo(workItems),
      eventStore: { publish: async (event: DomainEvent) => void published.push(event) },
      projects: { listActiveIds: async () => [projectId] },
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
    expect(await new ProjectRepository(db).listActiveIds()).toContain(projectId);
  });
});
