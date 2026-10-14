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
  TaskCheckRepository,
  WorkItemRepository,
} from "@ashara/db";
import { BlockReports, ClientAnswers, PlanReports, TenderIntake } from "@ashara/engagement";
import type { AnswerStore, BlockReportStore, IntakeStore, PlanReportStore } from "@ashara/engagement";
import { LlmCallLedger, SpendCap } from "@ashara/finance";
import { buildGateway } from "@ashara/llm-gateway";
import type { LLMGateway, ModelConfig } from "@ashara/llm-gateway";
import { RosterDerivation } from "@ashara/organization";
import type { RosterStore } from "@ashara/organization";
import { FirstPlanner, PlanningService, Replanner, startWorkItem } from "@ashara/planning";
import type { FirstPlanStore, ReplanStore } from "@ashara/planning";
import { parseWorkItemId, type ProjectId } from "@ashara/shared";
import { createAnswerStore } from "./answer-store.js";
import { createBlockReportStore } from "./block-report-store.js";
import { createFirstPlanStore, createPlanReportStore } from "./first-plan-store.js";
import { createIntakeStore } from "./intake-store.js";
import { createReplanStore } from "./replan-store.js";
import { createRosterStore } from "./roster-store.js";
import { adaptWorkItemRepo } from "./work-item-adapter.js";

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
    priceWindows: [],
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
    },
  ],
};
const REVISED_TASKS = {
  tasks: [
    {
      ref: "t1", title: "Open hill studio bookings", description: "Hill bookings.", dependsOn: [],
      endState: "Hill classes can be booked", scope: "hill bookings", deliverables: ["hill booking"], visionItems: ["S1"],
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
      if (prompt.includes("needs the project environment changed")) {
        return jsonResult({ environmentChange: options.environmentChange ?? false, reason: "Only what is booked changes." });
      }
      if (prompt.includes("changed what is built after work began")) return jsonResult(REVISED_TASKS);
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

    expect(outcomes).toEqual([{ kind: "revised", projectId, revision: 2, tasks: 3, superseded: 2, newEnvironment: false }]);
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
      ["Task", "review", "Review the plan's checks together against the vision"],
    ]);
    // No new environment task: the new work builds on the Sprint 0 already done.
    for (const task of added.filter((i) => i.level === "Task")) expect(await dependenciesOf(task.id)).toContain(sprint0.id);
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
