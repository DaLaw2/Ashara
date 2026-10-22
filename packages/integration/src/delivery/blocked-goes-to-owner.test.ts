import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { ClientRepository, createDb, resolveTestDatabaseUrl } from "@ashara/db";
import { ClientAnswers, ClientMessageRepository, TenderIntake, createProjectWithTender } from "@ashara/engagement";
import type { AnswerStore, IntakeStore } from "@ashara/engagement";
import { GuardedModelAccess, LlmCallLedger, LlmCallRepository, SpendCap } from "@ashara/finance";
import { buildGateway, sdkLanguageModels } from "@ashara/model-access";
import type { ModelConfig } from "@ashara/model-access";
import { RosterDerivation } from "@ashara/organization";
import type { RosterStore } from "@ashara/organization";
import {
  CoreLoop,
  DEFAULT_CONFIG,
  FailureRouter,
  FirstPlanner,
  PlanningService,
  ProjectHaltRepository,
  WorkItemRowRepository,
  adaptWorkItemRepo,
  createFirstPlanStore,
  startWorkItem,
} from "@ashara/delivery";
import type { CoreLoopDeps, FirstPlanStore } from "@ashara/delivery";
import type { ExecutionResult } from "@ashara/quality";
import { parseWorkItemId, wrapError, type ProjectId } from "@ashara/shared";
import { memoryStepContainment, recordingLogger } from "@ashara/shared/testing";
import { createAnswerStore } from "@ashara/server/answer-store";
import { createIntakeStore } from "@ashara/server/intake-store";
import { createRosterStore } from "@ashara/server/roster-store";
import type { Outcome } from "@ashara/workplace";
import { composedLoopOverTestDb } from "../loop-over-test-db.js";
import { citingItemsToCheck } from "../simulator/stand-ins/planner.js";

// An implementer's blocked finish whose cause names an owner outside its task goes to that owner and
// spends none of the task's attempts: blocked on another task's work, it waits on that task through
// the scheduler and resumes once the task merges; blocked on a decision only the client can make, one
// question goes to the client on intake's question path and the task holds until the answer is read,
// its project halting on client_wait while nothing else of it can proceed, until the answer resumes it.
// A wait that cannot end gives the task up under its own cause for a plan repair, never as a failure.
// The loop as production composes it, over real Postgres; the dispatch returns what an attempt
// ending each way returns, and every model call is a MockLanguageModelV4.

const stub = vi.hoisted(() => ({ model: undefined as unknown }));
vi.mock("@ai-sdk/deepseek", () => ({ createDeepSeek: () => () => stub.model }));

const DATABASE_URL = resolveTestDatabaseUrl(process.env);
const NAME_PREFIX = `blocked-owner-test-${randomUUID().slice(0, 8)}`;
const TENDER = "A key store. Clients put and get keys. A deleted key is gone.";
const MERGE = "0123456789abcdef0123456789abcdef01234567";
const QUESTION = "The tender says the store starts with its fixed command, which cannot serve deletes; may the start command change?";

let db: ReturnType<typeof createDb>;
let gateway: GuardedModelAccess;
let clientId: string;
let workdirBase: string;
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

const guarantee = (id: string, statement: string, quote: string, at: string) => ({
  id,
  statement,
  observable: { interface: [at], observation: "output" },
  refutedBy: [`The product does not hold that ${statement}`],
  source: { kind: "tender", quote },
});

const INTAKE = {
  summary: "A key store.",
  interface: [
    { id: "I1", text: "kv put KEY VALUE; kv get KEY", source: { kind: "tender", quote: "Clients put and get keys." } },
    { id: "I2", text: "kv delete KEY", source: { kind: "tender", quote: "A deleted key is gone." } },
  ],
  guarantees: [
    guarantee("G1", "A get returns the value of the last put of its key.", "Clients put and get keys.", "I1"),
    guarantee("G2", "A deleted key is gone.", "A deleted key is gone.", "I2"),
  ],
  assumptions: [],
  questions: [],
  exclusions: [],
};

const ROSTER = {
  roles: [
    { name: "Liaison", responsibility: "Talks to the client.", capabilities: ["client-comms"] },
    { name: "Platform", responsibility: "Defines how the store is built and tested.", capabilities: ["write-environment"] },
    { name: "Implementer", responsibility: "Builds the store.", capabilities: ["write-source"] },
    { name: "Check author", responsibility: "Writes the checks the store must pass.", capabilities: ["author-checks"] },
  ],
};

const task = (ref: string, title: string, cites: string) => ({
  ref,
  title,
  description: title,
  dependsOn: [],
  goal: title,
  endState: `${title}, end to end`,
  scope: `the ${ref} part of the store`,
  deliverables: [{ text: title, sources: [cites] }],
  acceptance: [{ text: `a client sees: ${title}`, sources: [cites] }],
  capability: "Medium",
  capabilityReason: "graded for the test",
});

const FIRST_TASKS = { tasks: [task("t1", "Put and get keys", "G1"), task("t2", "Delete keys", "G2")] };

/** One model for every call, answering each by what its prompt asks. */
function pipelineModel(): void {
  stub.model = new MockLanguageModelV4({
    doGenerate: async (call) => {
      const prompt = JSON.stringify(call.prompt);
      if (prompt.includes("prepare the first version of the project's vision")) return jsonResult(INTAKE);
      if (prompt.includes("client-comms")) return jsonResult(ROSTER);
      if (prompt.includes("Read their answer and say what it does")) return jsonResult({ reading: { verdict: "confirms", amends: [] } });
      return jsonResult(citingItemsToCheck(FIRST_TASKS, prompt));
    },
  });
}

function ours<T extends { readonly projectId: string }>(list: () => Promise<readonly T[]>): () => Promise<T[]> {
  return async () => (await list()).filter((row) => ourProjects.has(row.projectId));
}

const ItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  level: z.string(),
  status: z.string(),
  origin: z.string().nullable(),
  checksFor: z.string().nullable(),
  dispatchCount: z.number(),
  reason: z.unknown(),
});

async function itemsOf(projectId: ProjectId) {
  const result = await db.execute(sql`
    SELECT id, title, level, status, task_spec->>'origin' AS origin, task_spec->>'checksFor' AS "checksFor",
           dispatch_count AS "dispatchCount", blocked_reason AS reason
    FROM work_items WHERE project_id = ${projectId} ORDER BY created_at, id`);
  return z.array(ItemSchema).parse(result.rows);
}

async function itemOf(projectId: ProjectId, id: string) {
  const found = (await itemsOf(projectId)).find((item) => item.id === id);
  if (found === undefined) throw new Error(`no item ${id}`);
  return found;
}

async function dependenciesOf(id: string): Promise<string[]> {
  const result = await db.execute(sql`SELECT to_id AS "to" FROM dependencies WHERE from_id = ${id}`);
  return z.array(z.object({ to: z.string() })).parse(result.rows).map((row) => row.to);
}

async function questionsOf(projectId: ProjectId) {
  const result = await db.execute(sql`
    SELECT id, body FROM client_messages WHERE project_id = ${projectId} AND direction = 'outbound' AND kind = 'question'`);
  return z.array(z.object({ id: z.string(), body: z.string() })).parse(result.rows);
}

/** The client answers the question `questionId`, and the Liaison reads the answer, as its step each cycle does. */
async function answer(projectId: ProjectId, questionId: string, body: string): Promise<void> {
  await new ClientMessageRepository(db).insertInbound({ projectId, kind: "answer", body, inReplyTo: questionId });
  pipelineModel();
  const answerStore = createAnswerStore(db);
  const answers: AnswerStore = { ...answerStore, openAnswers: ours(() => answerStore.openAnswers()) };
  expect((await new ClientAnswers({ shutdownSignal: new AbortController().signal, llm: gateway, store: answers, containment: memoryStepContainment(() => true) }).runPending()).map((o) => o.kind)).toEqual(["stated"]);
}

const HaltSchema = z.object({ kind: z.string(), errorClass: z.string().nullable(), reason: z.string().nullable(), endKind: z.string().nullable(), resumeEvidence: z.string().nullable() });

async function haltsOf(projectId: ProjectId) {
  const result = await db.execute(sql`
    SELECT kind, error_class AS "errorClass", reason, end_kind AS "endKind", resume_evidence AS "resumeEvidence", ended_at IS NULL AS open
    FROM project_blocks WHERE project_id = ${projectId} ORDER BY blocked_at, id`);
  return z.array(HaltSchema.extend({ open: z.boolean() })).parse(result.rows);
}

async function openHaltOf(projectId: ProjectId) {
  return (await haltsOf(projectId)).find((halt) => halt.open) ?? null;
}

async function lastHaltOf(projectId: ProjectId) {
  return (await haltsOf(projectId)).at(-1) ?? null;
}

/** The Liaison's block report on the open halt is on record, as its block-report step records it: what an automatic resumption waits for. */
async function toldOfHalt(projectId: ProjectId): Promise<void> {
  const report = await new ClientMessageRepository(db).insertOutbound({ projectId, kind: "report", body: "Work is paused.", inReplyTo: null });
  await db.execute(sql`
    INSERT INTO told_reports (subject_kind, subject_id, project_id, report_id)
    SELECT 'project-blocked', b.id, b.project_id, ${report.id} FROM project_blocks b WHERE b.project_id = ${projectId} AND b.ended_at IS NULL`);
}

/** Starts a task as dispatch does: the task and every Pending ancestor, its Epic, go InProgress. */
async function startTask(id: string): Promise<void> {
  const repo = adaptWorkItemRepo(new WorkItemRowRepository(db));
  const item = await PlanningService.findWorkItem(repo, parseWorkItemId(id, "test"));
  if (item === null) throw new Error(`task ${id} not found`);
  startWorkItem(item);
  await PlanningService.saveWorkItem(repo, item, "Pending");
  await PlanningService.activateAncestors(repo, item.parentId);
}

async function completeTask(id: string): Promise<void> {
  await PlanningService.route(adaptWorkItemRepo(new WorkItemRowRepository(db)), parseWorkItemId(id, "test"), "passed");
}

/**
 * A key store planned from G1 ("Put and get keys", I1) and G2 ("Delete keys", I2): Sprint 0, the
 * layout, the check tasks and the review are done, so "Delete keys" is ready to dispatch; "Put and
 * get keys" is in progress, as another lane's dispatch holds it, until the test merges it.
 */
async function readyProject(): Promise<{ readonly projectId: ProjectId; readonly put: string; readonly del: string }> {
  const created = await createProjectWithTender(db, clientId, `${NAME_PREFIX}-${randomUUID().slice(0, 6)}`, TENDER);
  const projectId = created.project.id;
  ourProjects.add(projectId);
  pipelineModel();
  const intakeStore = createIntakeStore(db);
  const intake: IntakeStore = { ...intakeStore, openTenders: ours(() => intakeStore.openTenders()) };
  expect((await new TenderIntake({ shutdownSignal: new AbortController().signal, containment: memoryStepContainment(() => true), llm: gateway, store: intake }).runPending()).map((o) => o.kind)).toEqual(["recorded"]);
  const rosterStore = createRosterStore(db);
  const roster: RosterStore = { ...rosterStore, projectsAwaitingRoster: ours(() => rosterStore.projectsAwaitingRoster()) };
  expect((await new RosterDerivation({ shutdownSignal: new AbortController().signal, containment: memoryStepContainment(() => true), llm: gateway, store: roster }).runPending()).map((o) => o.kind)).toEqual(["recorded"]);
  const planStore = createFirstPlanStore(db);
  const plan: FirstPlanStore = { ...planStore, projectsAwaitingPlan: ours(() => planStore.projectsAwaitingPlan()) };
  expect((await new FirstPlanner({ shutdownSignal: new AbortController().signal, logger: recordingLogger(), containment: memoryStepContainment(() => true), llm: gateway, store: plan }).runPending()).map((o) => o.kind)).toEqual(["planned"]);
  await db.execute(sql`
    INSERT INTO client_messages (project_id, direction, kind, body, reports_on)
    VALUES (${projectId}, 'outbound', 'report', 'The plan.', 'first-plan')`);

  const items = await itemsOf(projectId);
  const titled = (title: string) => {
    const found = items.find((i) => i.origin === "decomposition" && i.title === title);
    if (found === undefined) throw new Error(`the first plan has no task "${title}"`);
    return found.id;
  };
  for (const done of items.filter((i) => i.level === "Task" && i.origin !== "decomposition")) {
    await startTask(done.id);
    await completeTask(done.id);
  }
  const put = titled("Put and get keys");
  await startTask(put);
  return { projectId, put, del: titled("Delete keys") };
}

const OUTCOME_BASE = {
  turnsUsed: 3,
  cost: { measured: true as const, totalUsd: 0, turns: 3 },
  lastToolCall: null,
  promptDigest: "0".repeat(64),
  detail: "finished",
};

function blockedOutcome(blockedOn: Extract<Outcome, { kind: "finished" }>["blockedOn"], reason: string): Outcome {
  return { ...OUTCOME_BASE, kind: "finished", status: "blocked", summary: "Stuck.", blockedReason: reason, blockedOn, statement: null };
}

/** What a dispatch whose implementer finished blocked on work delivering `entries` returns. */
function needsWork(attempt: number, entries: readonly [string, ...string[]]): ExecutionResult {
  const reason = `the check sets up data through ${entries.join(", ")}, which another task delivers; the check is correct`;
  return {
    status: "prerequisite_needed",
    interfaceEntries: entries,
    interfaceTable: INTAKE.interface.map((entry) => ({ key: entry.id, text: entry.text })),
    reason,
    detail: `agent reported blocked: ${reason}`,
    outcome: blockedOutcome({ kind: "needs-work", interfaceEntries: entries }, reason),
    sessionId: randomUUID(),
    attempt,
    errorEnvelope: { outcome: "blocked", summary: reason, chain: wrapError("development", "agentAttempt", reason) },
  };
}

/** What a dispatch whose implementer finished blocked on the client's decision returns. */
function needsClient(attempt: number): ExecutionResult {
  const reason = "the tender's start command cannot route the delete; only the client can change it";
  const assumption = "The store starts with the tender's fixed command.";
  return {
    status: "client_decision_needed",
    question: QUESTION,
    assumption,
    reason,
    detail: `agent reported blocked: ${reason}`,
    outcome: blockedOutcome({ kind: "needs-client-decision", question: QUESTION, assumption }, reason),
    sessionId: randomUUID(),
    attempt,
    errorEnvelope: { outcome: "blocked", summary: reason, chain: wrapError("development", "agentAttempt", reason) },
  };
}

function merged(attempt: number): ExecutionResult {
  return {
    status: "completed",
    delivered: { kind: "merged", mergeCommit: MERGE },
    detail: "merged",
    outcome: { ...OUTCOME_BASE, kind: "finished", status: "done", summary: "Done.", blockedReason: null, blockedOn: null, statement: null },
    sessionId: randomUUID(),
    attempt,
  };
}

type Execute = CoreLoopDeps["dispatch"]["dispatchService"]["execute"];

/** The loop over the test database, dispatching only this suite's projects through `execute`, its failures routed by the FailureRouter. */
function loopOf(execute: Execute): CoreLoop {
  const projects = new ProjectHaltRepository(db);
  const deps = composedLoopOverTestDb(
    {
      db,
      config: { ...DEFAULT_CONFIG, workdirBase, laneCount: 1 },
      logger: recordingLogger(),
      spendCap: new SpendCap({ ledger: new LlmCallRepository(db), caps: { deploymentUsd: 1_000_000, perProjectUsd: 1_000_000 } }),
      containment: memoryStepContainment(() => true),
      failureRouter: new FailureRouter(),
      dispatchService: { execute },
    },
    {
      loop: {
        projectRepo: {
          get: (id) => projects.get(id),
          recordWorkspacePath: (id, path) => projects.recordWorkspacePath(id, path),
          listActiveIds: async () => (await projects.listActiveIds()).filter((id) => ourProjects.has(id)),
          listWithWorkspace: async () => [],
          block: (id, cause) => projects.block(id, cause),
          listInfrastructureHalted: async () => [],
          resumeFromInfrastructureHalt: async () => {
            throw new Error("no infrastructure halt in this suite");
          },
          listClientWaitHalted: async () => (await projects.listClientWaitHalted()).filter((id) => ourProjects.has(id)),
          resumeFromClientWait: (id, evidence) => projects.resumeFromClientWait(id, evidence),
          blockAllActive: async () => [],
        },
      },
    },
  );
  return new CoreLoop(deps);
}

/** Every dispatch the loop made, by task, with what each returned. */
function scriptedDispatch(answer: (taskId: string, attempt: number) => ExecutionResult): { readonly execute: Execute; readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    execute: async (descriptor) => {
      calls.push(descriptor.id);
      return answer(descriptor.id, descriptor.attempt);
    },
  };
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  clientId = (await new ClientRepository(db).create(`${NAME_PREFIX}-client`)).id;
  workdirBase = mkdtempSync(join(tmpdir(), "ashara-blocked-owner-"));
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
            models: [model("blocked-strong", "Strong"), model("blocked-frontier", "Frontier")],
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
  ourProjects.clear();
});

afterAll(async () => {
  rmSync(workdirBase, { recursive: true, force: true });
  const pattern = `${NAME_PREFIX}%`;
  const projects = sql`SELECT id FROM projects WHERE name LIKE ${pattern}`;
  await db.execute(sql`DELETE FROM correction_holds WHERE project_id IN (${projects})`);
  await db.execute(sql`DELETE FROM plan_revisions WHERE project_id IN (${projects})`);
  await db.execute(sql`DELETE FROM llm_calls WHERE project_id IN (${projects})`);
  await db.execute(sql`DELETE FROM task_checks WHERE project_id IN (${projects})`);
  await db.execute(sql`DELETE FROM work_items WHERE project_id IN (${projects})`);
  await db.execute(sql`DELETE FROM roster_roles WHERE project_id IN (${projects})`);
  await db.execute(sql`DELETE FROM vision_revisions WHERE project_id IN (${projects})`);
  await db.execute(sql`DELETE FROM vision_documents WHERE project_id IN (${projects})`);
  await db.execute(sql`DELETE FROM client_messages WHERE project_id IN (${projects}) AND in_reply_to IS NOT NULL`);
  await db.execute(sql`DELETE FROM client_messages WHERE project_id IN (${projects})`);
  await db.execute(sql`DELETE FROM projects WHERE name LIKE ${pattern}`);
  await db.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
  await db.$client.end();
});

describe("a blocked finish naming another task's work waits for it, uncounted", () => {
  test("the task waits on the task delivering the entry, spends no attempt, and resumes and completes once that task merges", async () => {
    const { projectId, put, del } = await readyProject();
    let attempts = 0;
    const dispatch = scriptedDispatch((_taskId, attempt) => (++attempts === 1 ? needsWork(attempt, ["I1"]) : merged(attempt)));
    const loop = loopOf(dispatch.execute);

    await loop.runCycle();
    expect(dispatch.calls).toEqual([del]);
    expect(await itemOf(projectId, del)).toMatchObject({
      status: "Pending",
      dispatchCount: 0,
      reason: { source: "awaiting_work", waits: 1, interfaceEntries: ["I1"], on: [put] },
    });
    expect(await dependenciesOf(del)).toContain(put);

    // Nothing is dispatched while the task delivering I1 is open: the delete task waits on it.
    await loop.runCycle();
    expect(dispatch.calls).toEqual([del]);

    await completeTask(put);
    await loop.runCycle();
    expect(dispatch.calls).toEqual([del, del]);
    expect(await itemOf(projectId, del)).toMatchObject({ status: "Completed", dispatchCount: 1 });
  });

  test("with no open task delivering the entry, the need is a gap in the plan: given up for its repair, never as a failure", async () => {
    const { projectId, put, del } = await readyProject();
    await completeTask(put);
    const dispatch = scriptedDispatch((_taskId, attempt) => needsWork(attempt, ["I1"]));

    await loopOf(dispatch.execute).runCycle();

    expect(dispatch.calls).toEqual([del]);
    expect(await itemOf(projectId, del)).toMatchObject({
      status: "Abandoned",
      dispatchCount: 0,
      reason: { source: "prerequisite_unresolved", why: "unplanned", waits: 0 },
    });
  });
});

describe("a blocked finish naming a decision only the client can make asks the client once, uncounted", () => {
  test("the task holds first, its question is posted once under the hold's id, and it resumes and completes once the answer is read", async () => {
    const { projectId, del } = await readyProject();
    let attempts = 0;
    const dispatch = scriptedDispatch((_taskId, attempt) => (++attempts === 1 ? needsClient(attempt) : merged(attempt)));
    const loop = loopOf(dispatch.execute);

    await loop.runCycle();
    expect(dispatch.calls).toEqual([del]);
    const held = await itemOf(projectId, del);
    expect(held).toMatchObject({ status: "Blocked", dispatchCount: 0, reason: { source: "awaiting_client", waits: 1, question: QUESTION } });
    const { questionId } = z.object({ questionId: z.string() }).parse(held.reason);
    // The hold is written before anything is posted: a crash here leaves no question no task waits on.
    expect(await questionsOf(projectId)).toEqual([]);

    // The next cycle's exits post it under the id the hold chose; unanswered while other work is still
    // under way, the task holds, and no second question is posted.
    await loop.runCycle();
    await loop.runCycle();
    expect(dispatch.calls).toEqual([del]);
    expect((await itemOf(projectId, del)).status).toBe("Blocked");
    const questions = await questionsOf(projectId);
    expect(questions.map((each) => each.id)).toEqual([questionId]);
    expect(questions[0]?.body).toContain(QUESTION);

    await answer(projectId, questionId, "Yes, change the start command.");
    await loop.runCycle();
    expect(dispatch.calls).toEqual([del, del]);
    expect(await itemOf(projectId, del)).toMatchObject({ status: "Completed", dispatchCount: 1 });
    expect(await questionsOf(projectId)).toHaveLength(1);
  });

  test("a task blocked again after every answer is given up past the bound of waits in a row, under its own cause, with no further question", async () => {
    const { projectId, del } = await readyProject();
    const dispatch = scriptedDispatch((_taskId, attempt) => needsClient(attempt));
    const loop = loopOf(dispatch.execute);

    await loop.runCycle();
    for (const wait of [1, 2, 3]) {
      const held = await itemOf(projectId, del);
      expect(held).toMatchObject({ status: "Blocked", dispatchCount: 0, reason: { source: "awaiting_client", waits: wait } });
      const { questionId } = z.object({ questionId: z.string() }).parse(held.reason);
      await loop.runCycle();
      await answer(projectId, questionId, "Keep the command.");
      // The answer read: back to Pending and dispatched again in the same cycle, which blocks it again.
      await loop.runCycle();
    }

    expect(dispatch.calls).toEqual([del, del, del, del]);
    expect(await itemOf(projectId, del)).toMatchObject({
      status: "Abandoned",
      dispatchCount: 0,
      reason: { source: "prerequisite_unresolved", why: "bound", waits: 3 },
    });
    expect(await questionsOf(projectId)).toHaveLength(3);
  });

  test("a question unanswered once no other work could proceed halts the project on client_wait, giving nothing up, until the answer resumes it", async () => {
    const { projectId, put, del } = await readyProject();
    let attempts = 0;
    const dispatch = scriptedDispatch((_taskId, attempt) => (++attempts === 1 ? needsClient(attempt) : merged(attempt)));
    const loop = loopOf(dispatch.execute);

    await loop.runCycle();
    const { questionId } = z.object({ questionId: z.string() }).parse((await itemOf(projectId, del)).reason);
    await completeTask(put);
    await loop.runCycle();

    expect(dispatch.calls).toEqual([del]);
    expect(await itemOf(projectId, del)).toMatchObject({ status: "Blocked", dispatchCount: 0, reason: { source: "awaiting_client", questionId } });
    expect((await itemsOf(projectId)).filter((item) => item.status === "Abandoned")).toEqual([]);
    expect(await openHaltOf(projectId)).toMatchObject({ kind: "client_wait", errorClass: "ClientDecisionAwaited", reason: expect.stringContaining(QUESTION) });
    expect((await questionsOf(projectId)).map((each) => each.id)).toEqual([questionId]);

    // Halted and told: unanswered, it stays halted; nothing is dispatched.
    await toldOfHalt(projectId);
    await loop.runCycle();
    expect(await openHaltOf(projectId)).toMatchObject({ kind: "client_wait" });
    expect(dispatch.calls).toEqual([del]);

    // The answer is read during the halt, and the next cycle ends the halt and resumes the task.
    await answer(projectId, questionId, "Yes, change the start command.");
    await loop.runCycle();
    expect(await openHaltOf(projectId)).toBeNull();
    expect(await lastHaltOf(projectId)).toMatchObject({ kind: "client_wait", endKind: "answered", resumeEvidence: expect.stringContaining(questionId) });
    expect(dispatch.calls).toEqual([del, del]);
    expect(await itemOf(projectId, del)).toMatchObject({ status: "Completed", dispatchCount: 1 });
  });
});
