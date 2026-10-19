import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { MockLanguageModelV4 } from "ai/test";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { ClientRepository, createDb, EventStoreRepository, LlmCallRepository, resolveTestDatabaseUrl } from "@ashara/db";
import { FailedApproachRepository } from "@ashara/knowledge";
import {
  DispatchService,
  CoreLoop,
  DEFAULT_CONFIG,
  concurrentTaskLanes,
  FailureRouter,
  adaptWorkItemRepo,
  reconcileWorkItemsOnStartup,
  WorkItemRowRepository,
  ProjectHaltRepository,
} from "@ashara/delivery";
import type { CoreLoopDeps, WorkItemRepository } from "@ashara/delivery";
import { PodmanSubstrate } from "@ashara/execution-infra";
import { GuardedModelAccess, LlmCallLedger, SpendCap } from "@ashara/finance";
import type { WorkBudgets } from "@ashara/finance";
import { buildGateway, sdkLanguageModels } from "@ashara/model-access";
import type { ModelConfig } from "@ashara/model-access";
import { createWorkItemId, memoryStepContainment, recordingLogger, systemClock } from "@ashara/shared";
import type { ProjectId, WorkItemId } from "@ashara/shared";
import { DevSessionRepository } from "@ashara/workplace";
import { CHECK_MISSING_EXIT } from "@ashara/workplace";
import { testCellInstance } from "../test-cells.js";
import { projectState } from "../simulator/project-state.js";

// The dispatch loops that have no counter of their own end through the work ledger,
// each in a typed, recorded state: a task requeued after every shutdown and a
// task whose dispatch dies with the process at every restart. The second also stops early, before its
// ledger share is spent: a task found InProgress at two startups in a row is given up as crash_loop.
// A crash here is a process whose dispatch never returns: its model request never answers, and
// the next process is a new loop over the same database. Against Postgres; no real LLM call is made.
const stub = vi.hoisted(() => ({ model: undefined as unknown }));
vi.mock("@ai-sdk/deepseek", () => ({ createDeepSeek: () => () => stub.model }));

const DATABASE_URL = resolveTestDatabaseUrl(process.env);
const NAME = `dispatch-loops-ledger-test-${randomUUID().slice(0, 8)}`;
const AMPLE_CAPS = { deploymentUsd: 1_000_000, perProjectUsd: 1_000_000 };
const AMPLE_BUDGETS: WorkBudgets = { perTaskRequests: 50, perProjectRequests: 500, verificationReservePercent: 0 };

const MODEL: ModelConfig = {
  id: "dispatch-loops-model",
  apiModelId: "dispatch-loops-model",
  provider: "deepseek",
  capabilityLevel: "Strong",
  inputCostPer1M: 1,
  outputCostPer1M: 10,
  maxContextTokens: 100_000,
  cacheReadCostPer1M: null,
  cacheWriteCostPer1M: null,
  priceWindows: [], priceTiers: [], datedPrices: [],
};

type Db = ReturnType<typeof createDb>;
let db: Db;
let root = "";
const run = promisify(execFile);

class TestShutdown extends Error {
  constructor() {
    super("the test's process shuts down");
    this.name = "TestShutdown";
  }
}

class ConditionNeverHeld extends Error {
  constructor(what: string) {
    super(`waited 20s for ${what}`);
    this.name = "ConditionNeverHeld";
  }
}

function notExercised(label: string): () => never {
  return () => {
    throw new Error(`${label}: not exercised`);
  };
}

function toolCallTurn() {
  return {
    content: [{ type: "tool-call" as const, toolCallId: `tc-${randomUUID()}`, toolName: "run_command", input: JSON.stringify({ command: "true" }) }],
    usage: {
      inputTokens: { total: 100, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 10, text: 10, reasoning: undefined },
    },
    finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
    warnings: [],
  };
}

/** A model whose request never answers: the dispatch never returns, as when the process dies under it. */
function crashingAgent(): MockLanguageModelV4 {
  const mock = new MockLanguageModelV4({ doGenerate: () => new Promise<never>(() => {}) });
  stub.model = mock;
  return mock;
}

/** A model that asks for another command on every turn: only a bound ends its attempt. */
function endlessAgent(): MockLanguageModelV4 {
  const mock = new MockLanguageModelV4({ doGenerate: async () => toolCallTurn() });
  stub.model = mock;
  return mock;
}

/** A model whose every turn the process's shutdown interrupts: one request drawn, then the attempt is cancelled. */
function interruptedAgent(shutdown: () => AbortController): MockLanguageModelV4 {
  const mock = new MockLanguageModelV4({
    doGenerate: async () => {
      shutdown().abort(new TestShutdown());
      return toolCallTurn();
    },
  });
  stub.model = mock;
  return mock;
}

/** A substrate whose podman answers from a script: every cell starts, every exec reports the work missing. */
function scriptedSubstrate(mountRoot: string): PodmanSubstrate {
  const ok = (stdout = "") => ({
    exitCode: 0, signal: null, stdout, stdoutCut: null, stderr: "", stderrCut: null, killedByHost: false, stdinError: null,
    statusReport: null,
  });
  return new PodmanSubstrate({ trace: () => "test-trace", 
    podmanPath: "podman",
    mountRoot,
    runner: async ({ args }) => {
      switch (args[0]) {
        case "info":
          return ok(JSON.stringify({ version: { Version: "5.0.0" }, host: { security: { rootless: true } } }));
        case "run":
          return ok(`${"a".repeat(64)}\n`);
        case "exec":
          return { ...ok(), exitCode: CHECK_MISSING_EXIT, statusReport: `${CHECK_MISSING_EXIT}\n` };
        case "rm":
          return ok();
        default:
          throw new Error(`unexpected podman ${args.join(" ")}`);
      }
    },
  });
}

interface Fixture {
  readonly projectId: ProjectId;
  readonly itemId: WorkItemId;
  readonly workdirBase: string;
  readonly baselineCommit: string;
}

/** A project with a git target and one Sprint 0 task, which runs on the BaseCell. */
async function fixture(label: string): Promise<Fixture> {
  const projects = new ProjectHaltRepository(db);
  const client = await new ClientRepository(db).create(`${NAME}-${label}`);
  const projectId = (await projects.create(NAME, client.id)).id;
  const workdirBase = join(root, label);
  const target = join(workdirBase, "projects", projectId);
  await mkdir(target, { recursive: true });
  await run("git", ["init", "-q", "-b", "main"], { cwd: target });
  await writeFile(join(target, "README"), "a greeting project\n");
  await run("git", ["add", "README"], { cwd: target });
  await run("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "init"], { cwd: target });
  const baselineCommit = (await run("git", ["rev-parse", "main"], { cwd: target })).stdout.trim();
  const itemId = createWorkItemId();
  await new WorkItemRowRepository(db).create({
    id: itemId,
    level: "Task",
    status: "Pending",
    title: "Write greet.txt",
    taskSpec: { goal: "write greet.txt", endState: "greet.txt exists", scope: "greet.txt", deliverables: ["greet.txt"], origin: "sprint0" },
    projectId,
  });
  return { projectId, itemId, workdirBase, baselineCommit };
}

/** The work items of the fixture's project only, so a startup here reconciles nothing of another suite. */
function ourItems(at: Fixture): WorkItemRepository {
  const repo = adaptWorkItemRepo(new WorkItemRowRepository(db));
  return { ...repo, projectIdsWithStatus: async (status) => (await repo.projectIdsWithStatus(status)).filter((id) => id === at.projectId) };
}

/**
 * One server process over the fixture: its own SpendCap with `budgets`, its own shutdown signal,
 * and the loop with its real dispatch, attempt and routing. The model is the one stubbed when it is built.
 */
function serverProcess(at: Fixture, budgets: WorkBudgets, shutdown: AbortController = new AbortController()): CoreLoop {
  const calls = new LlmCallRepository(db);
  const projects = new ProjectHaltRepository(db);
  const spendCap = new SpendCap({ ledger: calls, caps: AMPLE_CAPS, workBudgets: budgets });
  const gateway = new GuardedModelAccess(buildGateway({
    models: sdkLanguageModels,
    config: {
      providers: [{ name: "deepseek", providerType: "deepseek", apiKey: "k", baseUrl: "https://stub.invalid/v1", models: [MODEL], enabled: true }],
      defaultProvider: "deepseek",
      contextOverflow: { statuses: [400], codes: ["context_length_exceeded"], phrases: [] },
    },
    checkedSources: ["test"],
    clock: () => new Date(),
  }), new LlmCallLedger(calls, spendCap), recordingLogger());
  const dispatchService = new DispatchService({
    logger: recordingLogger(),
    config: { workdirBase: at.workdirBase },
    sessionStore: { insert: async () => {}, complete: async () => {}, fail: async () => {} },
    knowledgeSink: { storeFinding: async () => {} },
    intentSource: { loadIntent: async () => ({ version: 1, visionText: "A greeting file", assumptions: [] }) },
    cells: {
      substrate: scriptedSubstrate(root),
      baseCell: { image: `docker.io/library/debian:12-slim@sha256:${"a".repeat(64)}`, digest: `sha256:${"a".repeat(64)}` },
      instance: testCellInstance(),
    },
    llm: gateway,
    staffing: { widerModel: () => null, staff: async () => ({ kind: "staffed", staff: { role: { id: "developer", name: "Developer" }, model: gateway.resolveModel("Strong", "agent-runner") } }) },
    attemptPolicy: { maxTurns: 5, perCommandTimeoutSeconds: 30, toolTimeoutSeconds: 30 },
    environment: {
      images: { build: notExercised("build"), prune: notExercised("prune") },
      statements: { record: notExercised("record"), forVersion: notExercised("forVersion") },
    },
    checks: {
      foundationOf: notExercised("foundationOf"),
      checkFilesOf: notExercised("checkFilesOf"),
      completedOf: async () => ({ checked: [], unchecked: [] }),
      checkedTasksOf: notExercised("checkedTasksOf"),
      storedOfProject: notExercised("storedOfProject"),
      append: notExercised("append"),
      latest: async () => ({ checkTaskId: createWorkItemId(), revision: 1, environmentVersion: "e".repeat(64), baselineCommit: at.baselineCommit, checks: [{ name: "noop", command: "true", decides: ["S1"] }], files: [] }),
    },
    suiteReview: { review: async () => { throw new Error("no suite review runs in this test"); } },
    shutdownSignal: shutdown.signal,
    clock: systemClock,
  });
  const deps: CoreLoopDeps = {
    config: { ...DEFAULT_CONFIG, workdirBase: at.workdirBase },
    cycleLog: { emit: () => {} },
    logger: recordingLogger(),
    containment: memoryStepContainment((error) => spendCap.refusalOf(error) !== null),
    workItemRepo: adaptWorkItemRepo(new WorkItemRowRepository(db)),
    eventStore: new EventStoreRepository(db),
    failedApproachRepo: new FailedApproachRepository(db),
    // The gate sees this fixture's project only, and only while the project is at work.
    projectRepo: {
      get: (id) => projects.get(id),
      recordWorkspacePath: (id, path) => projects.recordWorkspacePath(id, path),
      listActiveIds: async () => (await projects.listActiveIds()).filter((id) => id === at.projectId),
      listWithWorkspace: async () => (await projects.listWithWorkspace()).filter((p) => p.id === at.projectId),
      block: (id, cause) => projects.block(id, cause),
      listInfrastructureHalted: async () => [],
      resumeFromInfrastructureHalt: notExercised("resumeFromInfrastructureHalt"),
      blockAllActive: async () => [],
    },
    dispatchService,
    failureRouter: new FailureRouter(),
    clientStops: { runPending: async () => [] },
    clientChanges: { runPending: async () => [] },
    stackChoices: { runPending: async () => [] },
    liaisonIntake: { runPending: async () => [] },
    liaisonAnswers: { runPending: async () => [] },
    rosterDerivation: { runPending: async () => [] },
    firstPlanning: { runPending: async () => [] },
    replanning: { runPending: async () => [] },
    planReports: { runPending: async () => [] },
    checkDisputes: { record: notExercised("checkDisputes") },
    suiteReviewFindings: { record: notExercised("suiteReviewFindings") },
    checkSetFreeze: { freezeFor: async () => [] },
    burnWarnings: { runPending: async () => [] },
    blockReports: { runPending: async () => [] },
    infrastructureProbe: { probe: notExercised("infrastructureProbe") },
    heldCells: { release: async () => {} },
    environmentOwner: notExercised("environmentOwner"),
    taskLanes: concurrentTaskLanes,
    acceptanceSweeper: { sweepForAcceptance: notExercised("sweepForAcceptance") },
    acceptance: { readyForAcceptance: async () => [], recordAccepted: notExercised("recordAccepted"), recordSweepFault: notExercised("recordSweepFault"), recordDefect: notExercised("recordDefect") },
    deliveredReports: { runPending: async () => [] },
    spendCap,
  };
  return new CoreLoop(deps);
}

/** A startup of a new process over the fixture: Delivery's reconcile of the work items a dead process left. */
async function startup(at: Fixture) {
  return reconcileWorkItemsOnStartup({
    logger: recordingLogger(),
    workItemRepo: ourItems(at),
    projects: new ProjectHaltRepository(db),
    eventStore: new EventStoreRepository(db),
    failureRouter: new FailureRouter(3),
    devSessionStore: new DevSessionRepository(db),
    workdirBase: at.workdirBase,
  });
}

async function requestsOf(projectId: ProjectId): Promise<number> {
  const result = await db.execute(sql`SELECT count(*)::int AS n FROM llm_calls WHERE project_id = ${projectId}`);
  return z.object({ n: z.number() }).parse(result.rows[0]).n;
}

const ItemRow = z.object({ status: z.string(), source: z.string().nullable(), crashOrphans: z.number(), repairs: z.number() });

async function itemOf(itemId: WorkItemId): Promise<z.infer<typeof ItemRow>> {
  const result = await db.execute(sql`
    SELECT status, blocked_reason->>'source' AS source, crash_orphans AS "crashOrphans",
           (SELECT count(*)::int FROM plan_repairs r WHERE r.work_item_id = w.id) AS repairs
    FROM work_items w WHERE id = ${itemId}`);
  return ItemRow.parse(result.rows[0]);
}

async function projectStatusOf(projectId: ProjectId): Promise<string> {
  const result = await db.execute(sql`SELECT ${projectState} AS status FROM projects WHERE id = ${projectId}`);
  return z.object({ status: z.string() }).parse(result.rows[0]).status;
}

/**
 * Starts one cycle of `loop` whose dispatch never returns, and resolves once the dispatch is
 * InProgress with `requests` drawn: the state a process that dies there leaves. The cycle is never
 * awaited; the process is taken as dead from here on.
 */
async function crashMidDispatch(loop: CoreLoop, at: Fixture, requests: number): Promise<void> {
  void loop.runCycle();
  for (let waited = 0; waited < 20_000; waited += 50) {
    if ((await itemOf(at.itemId)).status === "InProgress" && (await requestsOf(at.projectId)) === requests) return;
    await delay(50);
  }
  throw new ConditionNeverHeld(`${at.itemId} InProgress with ${requests} request(s) drawn`);
}

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  db = createDb(DATABASE_URL);
  root = await realpath(await mkdtemp(join(tmpdir(), "ashara-dispatch-loops-ledger-")));
});

afterAll(async () => {
  const projectIds = sql`(SELECT id FROM projects WHERE name = ${NAME})`;
  await db.execute(sql`DELETE FROM llm_calls WHERE project_id IN ${projectIds}`);
  await db.execute(sql`DELETE FROM domain_events WHERE payload->>'work_item_id' IN (SELECT id::text FROM work_items WHERE project_id IN ${projectIds})`);
  await db.execute(sql`DELETE FROM failed_approaches WHERE task_id IN (SELECT id FROM work_items WHERE project_id IN ${projectIds})`);
  await db.execute(sql`DELETE FROM plan_repairs WHERE project_id IN ${projectIds}`);
  await db.execute(sql`DELETE FROM project_blocks WHERE project_id IN ${projectIds}`);
  await db.execute(sql`DELETE FROM work_items WHERE project_id IN ${projectIds}`);
  await db.execute(sql`DELETE FROM client_messages WHERE project_id IN ${projectIds}`);
  await db.execute(sql`DELETE FROM projects WHERE name = ${NAME}`);
  await db.execute(sql`DELETE FROM clients WHERE name LIKE ${`${NAME}%`}`);
  await db.$client.end();
  await rm(root, { recursive: true, force: true });
});

// The startup reconciler requeues a crash orphan; CRASH_LOOP_BOUND stops it early, the work ledger in any case.
describe("a task whose dispatch dies with the process at every restart", () => {
  test("is given up as crash_loop at the second startup in a row that finds it InProgress, and never dispatched again", async () => {
    const at = await fixture("crash-loop");

    crashingAgent();
    await crashMidDispatch(serverProcess(at, AMPLE_BUDGETS), at, 1);
    expect(await startup(at)).toMatchObject({ orphansRequeued: 1, orphansGivenUp: 0 });
    expect(await itemOf(at.itemId)).toEqual({ status: "Pending", source: null, crashOrphans: 1, repairs: 0 });

    crashingAgent();
    await crashMidDispatch(serverProcess(at, AMPLE_BUDGETS), at, 2);
    expect(await startup(at)).toMatchObject({ orphansRequeued: 0, orphansGivenUp: 1 });
    // Given up with its typed cause, and its plan repaired: two requests drawn of the task's fifty.
    expect(await itemOf(at.itemId)).toEqual({ status: "Abandoned", source: "crash_loop", crashOrphans: 2, repairs: 1 });
    expect(await projectStatusOf(at.projectId)).toBe("active");

    const mock = endlessAgent();
    expect((await serverProcess(at, AMPLE_BUDGETS).runCycle()).tasksProcessed).toBe(0);
    expect(mock.doGenerateCalls).toHaveLength(0);
    expect(await requestsOf(at.projectId)).toBe(2);
  });

  test("is requeued, not given up, when a dispatch of it ended in its process between the two crashes", async () => {
    const at = await fixture("crash-apart");

    crashingAgent();
    await crashMidDispatch(serverProcess(at, AMPLE_BUDGETS), at, 1);
    await startup(at);
    expect(await itemOf(at.itemId)).toMatchObject({ status: "Pending", crashOrphans: 1 });

    // A dispatch that a shutdown interrupts, routed back to Pending by the process that started it.
    const shutdown = new AbortController();
    interruptedAgent(() => shutdown);
    await serverProcess(at, AMPLE_BUDGETS, shutdown).runCycle();
    expect(await itemOf(at.itemId)).toMatchObject({ status: "Pending", crashOrphans: 0 });

    crashingAgent();
    await crashMidDispatch(serverProcess(at, AMPLE_BUDGETS), at, 3);
    expect(await startup(at)).toMatchObject({ orphansRequeued: 1, orphansGivenUp: 0 });
    expect(await itemOf(at.itemId)).toMatchObject({ status: "Pending", crashOrphans: 1 });
  });

  test("is given up as work_budget_spent when its crashed dispatches drew its whole work budget first", async () => {
    const at = await fixture("crash-ledger");
    // The crashed request still counts: a restart returns no request the dead process drew.
    const budgets = { perTaskRequests: 1, perProjectRequests: 100, verificationReservePercent: 0 };

    crashingAgent();
    await crashMidDispatch(serverProcess(at, budgets), at, 1);
    expect(await startup(at)).toMatchObject({ orphansRequeued: 1 });

    const mock = endlessAgent();
    const cycle = await serverProcess(at, budgets).runCycle();
    expect(cycle.results).toEqual([expect.objectContaining({ taskId: at.itemId, status: "blocked" })]);
    expect(mock.doGenerateCalls).toHaveLength(0);
    expect(await requestsOf(at.projectId)).toBe(1);
    expect(await itemOf(at.itemId)).toMatchObject({ status: "Abandoned", source: "work_budget_spent", repairs: 1 });
  });
});

// An interrupted dispatch is requeued with its dispatch refunded and no counter of its own; the work ledger ends it.
describe("a task whose every dispatch a shutdown interrupts", () => {
  test("is requeued refunded until its work budget is drawn, then given up as work_budget_spent, never requeued again", async () => {
    const at = await fixture("shutdowns");
    const budgets = { perTaskRequests: 3, perProjectRequests: 100, verificationReservePercent: 0 };

    for (let restart = 1; restart <= 3; restart++) {
      const shutdown = new AbortController();
      interruptedAgent(() => shutdown);
      const cycle = await serverProcess(at, budgets, shutdown).runCycle();
      expect(cycle.results).toEqual([expect.objectContaining({ taskId: at.itemId, status: "interrupted" })]);
      expect(await itemOf(at.itemId)).toMatchObject({ status: "Pending", source: null });
      expect(await requestsOf(at.projectId)).toBe(restart);
    }

    const shutdown = new AbortController();
    const mock = interruptedAgent(() => shutdown);
    const cycle = await serverProcess(at, budgets, shutdown).runCycle();
    expect(mock.doGenerateCalls).toHaveLength(0);
    expect(cycle.results).toEqual([expect.objectContaining({ taskId: at.itemId, status: "blocked" })]);
    expect(await itemOf(at.itemId)).toMatchObject({ status: "Abandoned", source: "work_budget_spent", repairs: 1 });
    expect(await requestsOf(at.projectId)).toBe(3);
    expect((await serverProcess(at, budgets).runCycle()).tasksProcessed).toBe(0);
  });
});
