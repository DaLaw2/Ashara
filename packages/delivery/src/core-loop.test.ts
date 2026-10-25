import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi, afterEach, beforeEach } from "vitest";
import type { WorkItemId } from "@ashara/shared";
import { createWorkItemId, parseProjectId } from "@ashara/shared";
import { memoryStepContainment, recordingLogger } from "@ashara/shared/testing";
import { TERMINAL_KINDS } from "./acl/engagement-acl.js";
import type { LiaisonClientStops, LiaisonIntake, LiaisonPlanReports, LiaisonStackChoices, TerminalKind } from "./acl/engagement-acl.js";
import type { RosterDerivationStep } from "./acl/organization-acl.js";
import type { FirstPlanning } from "./first-plan.js";
import type { WorkItem } from "./domain/index.js";
import { DEFAULT_CONFIG, withOverrides } from "./types.js";
import type { CoreLoopDeps, LoopStop } from "./types.js";
import type { TaskResult } from "./execution/dispatch-run-deps.js";
import { CORE_LOOP_STEPS, CoreLoop, HALTED_CYCLE_CLASSIFICATION } from "./core-loop.js";
import { inertCoreLoopDeps, inertWorkItemRepo } from "./testing.js";

type SpendCapPort = CoreLoopDeps["loop"]["spendCap"];

// ---------------------------------------------------------------------------
// Mock heavy orchestrator modules that CoreLoop.runCycle exercises. We replace
// them with stubs so the test drives only the batch-dispatch parallelism, not
// reconciliation or the planning gate.
// ---------------------------------------------------------------------------

const mockProcessTask = vi.fn<(
  deps: CoreLoopDeps,
  task: WorkItem,
) => Promise<TaskResult>>();

vi.mock("./execution/dispatch-run.js", () => ({
  processTask: (deps: CoreLoopDeps, task: WorkItem) =>
    mockProcessTask(deps, task),
  handleProcessingError: async (_deps: CoreLoopDeps, task: WorkItem) => ({
    taskId: task.id,
    status: "failed" as const,
    detail: "mock error",
  }),
}));

vi.mock("./domain/index.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./domain/index.js")>();
  return {
    ...original,
    PlanningService: {
      gate: async () => {
        gateObserver.observe();
        return { available: twoTasks(), unlockWeights: new Map<string, number>() };
      },
      next: original.PlanningService.next,
    },
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Told each time the mocked gate runs; a step-order test records it, every other test ignores it. */
const gateObserver: { observe: () => void } = { observe: () => {} };

const TEST_PROJECT_ID = parseProjectId("00000000-0000-4000-8000-000000000001", "test");
const TASK_IDS: [WorkItemId, WorkItemId] = [createWorkItemId(), createWorkItemId()];

function pendingTask(id: WorkItemId, title: string): WorkItem {
  const now = new Date();
  return {
    id,
    level: "Task",
    status: "Pending",
    title,
    projectId: TEST_PROJECT_ID,
    overflowedWindowTokens: null,
    failureVerdict: { kind: "none" },
    dispatchCount: 0,
    workKind: "implementation",
    repairsTaskId: null,
    createdAt: now,
    updatedAt: now,
    events: [],
  };
}

function twoTasks(): WorkItem[] {
  return [pendingTask(TASK_IDS[0], "task-alpha"), pendingTask(TASK_IDS[1], "task-beta")];
}

function buildDeps(
  liaisonIntake: LiaisonIntake = { runPending: async () => [] },
  firstPlanning: FirstPlanning = { runPending: async () => [] },
  planReports: LiaisonPlanReports = { runPending: async () => [] },
  clientStops: LiaisonClientStops = { runPending: async () => [] },
  rosterDerivation: RosterDerivationStep = { runPending: async () => [] },
  stackChoices: LiaisonStackChoices = { runPending: async () => [] },
  spendCap: SpendCapPort = { deploymentStop: async () => null, refusalOf: () => null },
): CoreLoopDeps {
  return inertCoreLoopDeps({
    loop: {
      config: { ...DEFAULT_CONFIG, workdirBase: "/tmp/test-parallel", laneCount: 4 },
      cycleLog: { emit: (tally) => cycleTallies.push(tally) },
      containment: memoryStepContainment(() => true),
      workItemRepo: inertWorkItemRepo({
        findById: async () => null,
        save: async () => {},
        listIdsByStatus: async () => [],
        incrementDispatchCount: async () => 1,
        saveRefundedOverflow: async () => 0,
        recordCrashOrphan: async () => 1,
        getDependencies: async () => [],
        findChildren: async () => [],
      }),
      eventStore: { publish: async () => {} },
      projectRepo: { ...inertCoreLoopDeps().loop.projectRepo, get: async () => null },
      spendCap,
    },
    client: { clientStops, liaisonIntake },
    planning: { rosterDerivation, firstPlanning },
    reporting: { planReports, stackChoices },
    dispatch: { failedApproachRepo: { record: async () => {} } },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/** How long a task waits for the other of its batch to start: elapsed only when dispatch is serial. */
const SERIAL_DISPATCH_BOUND_MS = 5_000;

const cycleTallies: Array<Parameters<CoreLoopDeps["loop"]["cycleLog"]["emit"]>[0]> = [];

beforeEach(() => {
  cycleTallies.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  mockProcessTask.mockReset();
  gateObserver.observe = () => {};
});

describe("CoreLoop batch dispatch parallelism", () => {
  test("two tasks in a batch produce overlapping execution windows", async () => {
    // Track when each task's processTask starts and finishes to prove
    // concurrent dispatch. A serial loop would show task-B starting AFTER
    // task-A finishes; parallel dispatch shows them overlapping.
    const timeline: Array<{ taskId: string; event: "start" | "end"; ts: number }> = [];
    let started = 0;
    let bothStarted: () => void = () => {};
    const overlap = new Promise<void>((resolve) => {
      bothStarted = resolve;
    });

    mockProcessTask.mockImplementation(async (_deps: CoreLoopDeps, task: WorkItem) => {
      const taskId = task.id;
      timeline.push({ taskId, event: "start", ts: Date.now() });
      if (++started === 2) bothStarted();
      // Each task stays open until the other has started. A serial loop never starts the second
      // while the first is open, so the first ends at the bound and the overlap check below fails.
      let bound: NodeJS.Timeout | undefined;
      await Promise.race([overlap, new Promise((resolve) => (bound = setTimeout(resolve, SERIAL_DISPATCH_BOUND_MS)))]).finally(() => clearTimeout(bound));
      timeline.push({ taskId, event: "end", ts: Date.now() });
      return { taskId, status: "completed" as const, detail: "ok" };
    });

    const deps = buildDeps();
    const loop = new CoreLoop(deps);
    const cycleResult = await loop.runCycle();

    // Both tasks must have been dispatched
    expect(cycleResult.tasksProcessed).toBe(2);
    expect(cycleResult.results).toHaveLength(2);

    // Extract start/end for each task
    const taskAStart = timeline.find((e) => e.taskId === TASK_IDS[0] && e.event === "start");
    const taskAEnd = timeline.find((e) => e.taskId === TASK_IDS[0] && e.event === "end");
    const taskBStart = timeline.find((e) => e.taskId === TASK_IDS[1] && e.event === "start");
    const taskBEnd = timeline.find((e) => e.taskId === TASK_IDS[1] && e.event === "end");

    expect(taskAStart).toBeDefined();
    expect(taskAEnd).toBeDefined();
    expect(taskBStart).toBeDefined();
    expect(taskBEnd).toBeDefined();

    // Parallel proof: task B must START before task A ENDs (overlapping windows).
    // In a serial loop task B would start only after task A ends.
    expect(taskBStart!.ts).toBeLessThanOrEqual(taskAEnd!.ts);
  });

  test("rejected task in batch does not prevent other results from accumulating", async () => {
    let callCount = 0;
    mockProcessTask.mockImplementation(async (_deps: CoreLoopDeps, task: WorkItem) => {
      callCount++;
      if (callCount === 1) {
        throw new Error("simulated agent crash");
      }
      return { taskId: task.id, status: "completed" as const, detail: "ok" };
    });

    const deps = buildDeps();
    const loop = new CoreLoop(deps);
    const cycleResult = await loop.runCycle();

    // Both tasks dispatched, one failed, one completed
    expect(cycleResult.tasksProcessed).toBe(2);
    expect(cycleResult.results).toHaveLength(2);
    const statuses = cycleResult.results.map((r) => r.status).sort();
    expect(statuses).toEqual(["completed", "failed"]);
    expect(cycleTallies).toEqual([
      { event: "cycle_complete", eligible: 2, dispatched: 2, lanes: 4, tasksProcessed: 2, completed: 1, failed: 1, refused: 0, interrupted: 0 },
    ]);
  });
});

describe("CoreLoop settled branches", () => {
  test("a cycle releases every Abandoned task's branch before it dispatches, whichever path abandoned it", async () => {
    const base = mkdtempSync(join(tmpdir(), "ashara-loop-settled-"));
    const target = join(base, "projects", "p");
    mkdirSync(target, { recursive: true });
    const git = (...args: string[]): string =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: target, encoding: "utf8" }).trim();
    try {
      git("init", "-q", "-b", "main");
      git("commit", "-q", "--allow-empty", "-m", "init");
      const abandoned = createWorkItemId();
      git("branch", `task/${abandoned}`);
      const branchAtDispatch: string[] = [];
      mockProcessTask.mockImplementation(async (_deps: CoreLoopDeps, task: WorkItem) => {
        branchAtDispatch.push(git("branch", "--list", `task/${abandoned}`));
        return { taskId: task.id, status: "completed" as const, detail: "ok" };
      });
      const deps = buildDeps();

      await new CoreLoop(withOverrides(deps, { loop: { config: { ...deps.loop.config, workdirBase: base }, workItemRepo: { ...deps.loop.workItemRepo, listIdsByStatus: async (statuses) => (statuses.includes("Abandoned") ? [abandoned] : []) }, projectRepo: { ...deps.loop.projectRepo, listWithWorkspace: async () => [{ id: TEST_PROJECT_ID, workspacePath: target }] } } })).runCycle();

      expect(branchAtDispatch).toEqual(["", ""]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("a cycle at the deployment cap still releases the cells a failed teardown left and a settled task's branch", async () => {
    const base = mkdtempSync(join(tmpdir(), "ashara-loop-settled-cap-"));
    const target = join(base, "projects", "p");
    mkdirSync(target, { recursive: true });
    const git = (...args: string[]): string =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: target, encoding: "utf8" }).trim();
    try {
      git("init", "-q", "-b", "main");
      git("commit", "-q", "--allow-empty", "-m", "init");
      const completed = createWorkItemId();
      git("branch", `check/${completed}`);
      const deps = buildDeps(undefined, undefined, undefined, undefined, undefined, undefined, stubSpendCap(() => true));
      const release = vi.fn(async () => {});

      const result = await new CoreLoop(withOverrides(deps, { dispatch: { heldCells: { release } }, loop: { config: { ...deps.loop.config, workdirBase: base }, workItemRepo: { ...deps.loop.workItemRepo, listIdsByStatus: async (statuses) => (statuses.includes("Completed") ? [completed] : []) }, projectRepo: { ...deps.loop.projectRepo, listWithWorkspace: async () => [{ id: TEST_PROJECT_ID, workspacePath: target }] } } })).runCycle();

      expect(result.stop).not.toBeNull();
      expect(release).toHaveBeenCalledTimes(1);
      expect(git("branch", "--list", `check/${completed}`)).toBe("");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("a halted cycle releases the cells a failed teardown left and a settled task's branch", async () => {
    const base = mkdtempSync(join(tmpdir(), "ashara-loop-settled-halted-"));
    const target = join(base, "projects", "p");
    mkdirSync(target, { recursive: true });
    const git = (...args: string[]): string =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: target, encoding: "utf8" }).trim();
    try {
      git("init", "-q", "-b", "main");
      git("commit", "-q", "--allow-empty", "-m", "init");
      const abandoned = createWorkItemId();
      git("branch", `task/${abandoned}`);
      const deps = buildDeps();
      const release = vi.fn(async () => {});

      await new CoreLoop(withOverrides(deps, { dispatch: { heldCells: { release } }, loop: { config: { ...deps.loop.config, workdirBase: base }, workItemRepo: { ...deps.loop.workItemRepo, listIdsByStatus: async (statuses) => (statuses.includes("Abandoned") ? [abandoned] : []) }, projectRepo: { ...deps.loop.projectRepo, listWithWorkspace: async () => [{ id: TEST_PROJECT_ID, workspacePath: target }] } } })).runHaltedCycle();

      expect(release).toHaveBeenCalledTimes(1);
      expect(git("branch", "--list", `task/${abandoned}`)).toBe("");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("CoreLoop tender intake", () => {
  test("a cycle runs the Liaison's intake before dispatching work", async () => {
    const order: string[] = [];
    mockProcessTask.mockImplementation(async (_deps: CoreLoopDeps, task: WorkItem) => {
      order.push("dispatch");
      return { taskId: task.id, status: "completed" as const, detail: "ok" };
    });
    const runPending = vi.fn(async () => {
      order.push("intake");
      return [];
    });

    await new CoreLoop(buildDeps({ runPending })).runCycle();

    expect(runPending).toHaveBeenCalledTimes(1);
    expect(order[0]).toBe("intake");
    expect(order.filter((e) => e === "dispatch")).toHaveLength(2);
  });

  test("a shutdown during a step ends the cycle at the next step boundary: no later step runs and nothing is dispatched", async () => {
    const shutdown = new AbortController();
    const intake = vi.fn(async () => []);
    const built = buildDeps({ runPending: intake }, undefined, undefined, {
      runPending: async () => {
        shutdown.abort(new Error("SIGTERM"));
        return [];
      },
    });
    const deps = withOverrides(built, { loop: { shutdownSignal: shutdown.signal } });

    await expect(new CoreLoop(deps).runCycle()).rejects.toThrow(/the cycle ended before step client-receipt: the process is shutting down/);
    expect(intake).not.toHaveBeenCalled();
    expect(mockProcessTask).not.toHaveBeenCalled();
  });

  test("an intake store failure fails the cycle instead of being skipped", async () => {
    const deps = buildDeps({
      runPending: async () => {
        throw new Error("client_messages unreachable");
      },
    });
    await expect(new CoreLoop(deps).runCycle()).rejects.toThrow(/client_messages unreachable/);
    expect(mockProcessTask).not.toHaveBeenCalled();
  });
});

/**
 * A loop whose every step records itself in `order` when it runs, as `<step>#<n>` for its n-th run in
 * the order's life; a terminal-report run is named by the kinds it is asked for. Parked exits are
 * recorded by their read of the active projects (`active-projects#1`, the cycle's first such read),
 * the spend cap's check as `spend-cap`, the release of held cells as `held-cells` and the cap's halt
 * of every active project as `cap-halt`. `capAt` is the read of the spend cap, by number, that finds the
 * deployment at its cap; none does when it is omitted.
 */
function stepRecordingDeps(order: string[], capAt?: number): CoreLoopDeps {
  const runs = new Map<string, number>();
  const record = (name: string): void => {
    const run = (runs.get(name) ?? 0) + 1;
    runs.set(name, run);
    order.push(`${name}#${run}`);
  };
  const step = (name: string) =>
    vi.fn(async () => {
      record(name);
      return [];
    });
  gateObserver.observe = () => record("gate");
  mockProcessTask.mockImplementation(async (_deps: CoreLoopDeps, task: WorkItem) => {
    record("dispatch");
    return { taskId: task.id, status: "completed" as const, detail: "ok" };
  });
  let checks = 0;
  const spendCap: SpendCapPort = {
    deploymentStop: async () => {
      record("spend-cap");
      checks++;
      return checks === capAt ? { reason: "deployment cap reached", spend: { capUsd: 5, spentUsd: 5, inFlightUsd: 0, nextCallUsd: 0.5 } } : null;
    },
    refusalOf: () => null,
  };
  const base = buildDeps(
    { runPending: step("liaison-intake") },
    { runPending: step("first-plan") },
    { runPending: step("plan-report") },
    { runPending: step("client-stop") },
    { runPending: step("roster") },
    { runPending: step("stack-choice") },
    spendCap,
  );
  return withOverrides(base, {
    loop: {
      projectRepo: {
        ...base.loop.projectRepo,
        listInfrastructureHalted: async () => (record("infrastructure-resume"), []),
        listClientWaitHalted: async () => (record("client-wait-resume"), []),
        listWithWorkspace: async () => (record("settled-branches"), []),
        listActiveIds: async () => (record("active-projects"), []),
        blockAllActive: async () => (record("cap-halt"), []),
      },
    },
    client: {
      clientReceipts: { runPending: step("client-receipt"), dueMessages: async () => new Set<string>() },
      liaisonAnswers: { runPending: step("liaison-answers") },
      clientChanges: { runPending: step("client-change") },
    },
    planning: { replanning: { runPending: step("replan") } },
    dispatch: { heldCells: { release: async () => record("held-cells") } },
    sweeps: {
      terminalSweeps: { ...base.sweeps.terminalSweeps, dueTerminalSweeps: async () => (record("terminal-sweep"), []) },
      acceptance: { ...base.sweeps.acceptance, readyForAcceptance: async () => (record("acceptance"), []) },
    },
    reporting: {
      terminalReports: { runPending: async (kinds: readonly TerminalKind[]) => (record(`terminal-report[${kinds.join(",")}]`), []) },
      blockReports: { runPending: step("block-report") },
      burnWarnings: { runPending: step("burn-warning") },
    },
  });
}

/** Each pair names a step run that must come before another, with the reason core-loop.ts or the step groups in types.ts state for it. */
type StepOrder = readonly [before: string, after: string, why: string];

function expectStepOrder(order: readonly string[], pairs: readonly StepOrder[]): void {
  for (const [before, after, why] of pairs) {
    expect(order, `${before} ran (${why})`).toContain(before);
    expect(order, `${after} ran (${why})`).toContain(after);
    expect(order.indexOf(before), `${before} before ${after}: ${why}`).toBeLessThan(order.indexOf(after));
  }
}

// The receipts read the cap first (spend-cap#1) to word themselves; the cycle's check before its
// steps of LLM calls is its second read.
const CAP_CHECK = "spend-cap#2";
const CARRIED = "terminal-report[stopped,halted]#1";
const PLANNED = "terminal-report[planning-stopped,declined]#1";
const ACCEPTED = "terminal-report[delivered]#1";
const EVERY_KIND = `terminal-report[${TERMINAL_KINDS.join(",")}]#1`;

describe("CoreLoop step order", () => {
  test("a full cycle runs every step after each step its documented order puts first", async () => {
    const order: string[] = [];
    await new CoreLoop(stepRecordingDeps(order)).runCycle();

    expectStepOrder(order, [
      ["client-stop#1", "client-receipt#1", "each message's receipt states its project's state as the stops just left it"],
      ["client-stop#1", CAP_CHECK, "the client's stops run first, before the spend-cap check"],
      ["client-stop#1", "liaison-intake#1", "a project stopped is never intaken"],
      ["client-stop#1", "first-plan#1", "a project stopped is never planned"],
      ["client-stop#1", "gate#1", "a project stopped is never gated"],
      ["client-stop#1", "stack-choice#1", "the client's stops run first: no step below takes in a stopped project"],
      ["client-stop#1", "infrastructure-resume#1", "the client's stops run first: no step below takes in a stopped project"],
      ["client-stop#1", "client-wait-resume#1", "the client's stops run first: no step below takes in a stopped project"],
      ["client-stop#1", "terminal-sweep#1", "a stop taken this cycle is told after its terminal sweep"],
      ["client-stop#1", CARRIED, "a stop taken this cycle is told with the carried stop and halt messages"],
      ["client-stop#1", "block-report#1", "a project stopped is never reported on as returning to work"],
      ["client-stop#1", "burn-warning#1", "a project stopped is never warned of its burn"],
      ["stack-choice#1", CAP_CHECK, "a stack choice makes no LLM call, so it runs before the spend-cap check"],
      ["stack-choice#1", CARRIED, "a merged stack choice brings the project's state up to date before any report on it"],
      ["stack-choice#1", "block-report#1", "a merged stack choice brings the project's state up to date before any report on it"],
      ["stack-choice#1", "burn-warning#1", "a merged stack choice brings the project's state up to date before any report on it"],
      ["infrastructure-resume#1", "burn-warning#1", "a resumed halt brings the project's state up to date before any report on it"],
      ["client-wait-resume#1", "burn-warning#1", "a resumed halt brings the project's state up to date before any report on it"],
      ["infrastructure-resume#1", CARRIED, "only a halt already told resumes; one written late is reported first"],
      ["infrastructure-resume#1", "block-report#1", "an infrastructure resumption is told in the cycle it happens"],
      ["client-wait-resume#1", CARRIED, "a client_wait halt resumes only once told, like an infrastructure halt"],
      ["client-wait-resume#1", "block-report#1", "a client_wait resumption is told in the cycle it happens"],
      ["terminal-sweep#1", CARRIED, "each stop and halt is swept on main before its terminal message"],
      [CARRIED, CAP_CHECK, "the stop and halt messages make no LLM call, so they run before the spend-cap check"],
      [CARRIED, "block-report#1", "a return to work is reported once its halt is told"],
      ["block-report#1", "burn-warning#1", "the burn warnings run after the block reports"],
      ["burn-warning#1", CAP_CHECK, "the burn warnings run before the spend-cap check"],
      [CAP_CHECK, "held-cells#1", "a cycle at the cap releases what attempts held inside its halt"],
      [CAP_CHECK, "liaison-intake#1", "every step after the spend-cap check makes LLM calls"],
      ["held-cells#1", "settled-branches#1", "the cells a failed teardown left are released, then every settled task's branches"],
      ["settled-branches#1", "dispatch#1", "what attempts held is released before a full cycle's dispatch"],
      ["liaison-intake#1", "liaison-answers#1", "tenders first: a project's intake comes before any work on it"],
      ["liaison-answers#1", "client-change#1", "the client's changes of direction are read after the answers"],
      ["liaison-intake#1", "roster#1", "the roster runs after intake"],
      ["roster#1", "liaison-answers#2", "answers posted while the roster was derived are read before the first plan"],
      ["liaison-answers#2", "first-plan#1", "the first plan is made from the vision the answers state"],
      ["roster#1", "first-plan#1", "first planning requires a roster"],
      ["first-plan#1", "liaison-answers#3", "answers posted while the first plan was written are read before its tasks are dispatched"],
      ["liaison-answers#3", "replan#1", "a correction an answer made is replaced by the revision in this cycle"],
      ["first-plan#1", "replan#1", "the revisions run after the first plans"],
      ["replan#1", "plan-report#1", "the revisions run before the planning reports"],
      ["first-plan#1", "plan-report#1", "each recorded planning outcome is reported after planning"],
      ["plan-report#1", "gate#1", "a plan is reported before gating, so it can be dispatched this cycle"],
      ["liaison-intake#1", "gate#1", "intake runs before work-item gating"],
      ["client-change#1", PLANNED, "a declined contract version is told after the steps that write it"],
      ["first-plan#1", PLANNED, "a first planning that stopped is told after the step that writes it"],
      ["plan-report#1", PLANNED, "a planning that stopped is told with the other planning reports"],
      ["active-projects#1", "gate#1", "every Blocked task takes its parked exit before the gate reads them"],
      ["active-projects#1", "acceptance#1", "the exits of Blocked tasks run before the acceptance sweeps on main"],
      ["acceptance#1", ACCEPTED, "a delivered report is due only after its acceptance sweep"],
      ["gate#1", "dispatch#1", "the gate selects the tasks the lanes dispatch"],
      ["dispatch#1", "client-receipt#2", "the cycle is closed by the receipts of the messages that arrived while it ran"],
    ]);
  });

  test("a cycle that reaches the deployment's cap halts every active project and tells it after sweeping, then posts the receipts", async () => {
    const order: string[] = [];
    const result = await new CoreLoop(stepRecordingDeps(order, 2)).runCycle();

    expect(result.stop).not.toBeNull();
    expectStepOrder(order, [
      [CAP_CHECK, "cap-halt#1", "the deployment's cap halts every active project"],
      ["held-cells#1", "settled-branches#1", "the cells a failed teardown left are released, then every settled task's branches"],
      ["cap-halt#1", "terminal-sweep#2", "a halt recorded at the cap is owed its terminal sweep"],
      ["terminal-sweep#2", EVERY_KIND, "each stop and halt is swept on main before its terminal message"],
      ["cap-halt#1", EVERY_KIND, "each project halted at the cap has its report posted before the loop stops"],
      [EVERY_KIND, "block-report#2", "a return to work is reported once its halt is told"],
      [EVERY_KIND, "client-receipt#2", "the receipts posted at the cap tell the client all work has stopped"],
    ]);
    expect(order).not.toContain("liaison-intake#1");
    expect(mockProcessTask).not.toHaveBeenCalled();
  });

  test("a halted cycle takes the stops, posts the receipts, releases what attempts held, then sweeps before the reports", async () => {
    const order: string[] = [];
    await new CoreLoop(stepRecordingDeps(order)).runHaltedCycle();

    expectStepOrder(order, [
      ["client-stop#1", "client-receipt#1", "each message's receipt states its project's state as the stops just left it"],
      ["held-cells#1", "settled-branches#1", "the cells a failed teardown left are released, then every settled task's branches"],
      ["client-stop#1", "terminal-sweep#1", "a stop taken in a halted cycle is owed its terminal sweep"],
      ["terminal-sweep#1", EVERY_KIND, "each stop and halt is swept on main before its terminal message"],
      [EVERY_KIND, "block-report#1", "a return to work is reported once its halt is told"],
      [EVERY_KIND, "plan-report#1", "a plan written in the cycle that reached the cap is reported after its halt's message"],
    ]);
  });
});

describe("CoreLoop first plan", () => {
  test("a cycle runs client stops and changes, then intake, the roster, first planning, the Liaison's reports, then dispatch", async () => {
    const order: string[] = [];
    mockProcessTask.mockImplementation(async (_deps: CoreLoopDeps, task: WorkItem) => {
      order.push("dispatch");
      return { taskId: task.id, status: "completed" as const, detail: "ok" };
    });
    const step = (name: string) =>
      vi.fn(async () => {
        order.push(name);
        return [];
      });

    const deps = buildDeps(
      { runPending: step("intake") },
      { runPending: step("plan") },
      { runPending: step("report") },
      { runPending: step("stop") },
      { runPending: step("roster") },
    );
    await new CoreLoop(withOverrides(deps, { client: { clientChanges: { runPending: step("change") } }, reporting: { terminalReports: { runPending: step("terminal") } } })).runCycle();

    // The terminal messages are posted after the terminal sweeps, after the planning reports (a first
    // planning that stopped) and after the acceptance sweeps.
    expect(order).toEqual(["stop", "terminal", "intake", "change", "roster", "plan", "report", "terminal", "terminal", "dispatch", "dispatch"]);
  });

  test("a full cycle asks for each kind of terminal message once, where it can become due; a halted cycle asks for every kind", async () => {
    mockProcessTask.mockImplementation(async (_deps: CoreLoopDeps, task: WorkItem) => ({ taskId: task.id, status: "completed" as const, detail: "ok" }));
    const asked: Array<readonly string[]> = [];
    const terminal = vi.fn(async (kinds: readonly TerminalKind[]) => {
      asked.push([...kinds]);
      return [];
    });
    const loop = new CoreLoop(withOverrides(buildDeps(), { reporting: { terminalReports: { runPending: terminal } } }));

    await loop.runCycle();
    // The stops and halts carried into the cycle, then the plannings that stopped and the contracts
    // declined after the steps that write them, then the delivered reports after the acceptance sweeps.
    expect(asked).toEqual([["stopped", "halted"], ["planning-stopped", "declined"], ["delivered"]]);
    const perKind = new Map<string, number>();
    for (const kind of asked.flat()) perKind.set(kind, (perKind.get(kind) ?? 0) + 1);
    expect([...perKind.values()]).toEqual([1, 1, 1, 1, 1]);
    expect([...perKind.keys()].sort()).toEqual([...TERMINAL_KINDS].sort());

    asked.length = 0;
    await loop.runHaltedCycle();
    expect(asked).toEqual([[...TERMINAL_KINDS]]);
  });

  test("a cycle halted at the spend cap takes the client's stops and posts the terminal, resumption and plan reports still due, and nothing else: a change is read by a model, so it waits", async () => {
    const order: string[] = [];
    const step = (name: string) =>
      vi.fn(async () => {
        order.push(name);
        return [];
      });
    const deps = buildDeps({ runPending: step("intake") }, { runPending: step("plan") }, { runPending: step("report") }, { runPending: step("stop") });

    await new CoreLoop(withOverrides(deps, { client: { clientChanges: { runPending: step("change") } }, reporting: { blockReports: { runPending: step("block-report") }, terminalReports: { runPending: step("terminal") } } })).runHaltedCycle();

    expect(order).toEqual(["stop", "terminal", "block-report", "report"]);
    expect(mockProcessTask).not.toHaveBeenCalled();
  });

  // A message sent between cycles is answered right after the stops, one sent while the cycle ran at
  // its end, and one sent while the loop is halted at the cap by the halted cycle.
  test("the client's messages get their receipts right after the stops, at the end of a full cycle, and in a halted cycle", async () => {
    const order: string[] = [];
    mockProcessTask.mockImplementation(async (_deps: CoreLoopDeps, task: WorkItem) => {
      order.push("dispatch");
      return { taskId: task.id, status: "completed" as const, detail: "ok" };
    });
    const step = (name: string) =>
      vi.fn(async () => {
        order.push(name);
        return [];
      });
    const deps = buildDeps({ runPending: step("intake") }, undefined, undefined, { runPending: step("stop") });
    const loop = new CoreLoop(
      withOverrides(deps, {
        client: { clientReceipts: { runPending: step("receipt"), dueMessages: async () => new Set() }, clientChanges: { runPending: step("change") } },
        reporting: { terminalReports: { runPending: step("terminal") } },
      }),
    );

    await loop.runCycle();
    expect(order).toEqual(["stop", "receipt", "terminal", "intake", "change", "terminal", "terminal", "dispatch", "dispatch", "receipt"]);

    order.length = 0;
    await loop.runHaltedCycle();
    expect(order).toEqual(["stop", "receipt", "terminal"]);
  });

  // A halted cycle runs no round of work again in this process, so its receipts never promise one; a
  // full cycle whose recorded spend is at the cap stops before any reading, so its receipts say so too.
  test("the receipts are told all work is stopped in a halted cycle and when recorded spend is at the deployment's cap, and that it runs otherwise", async () => {
    mockProcessTask.mockImplementation(async (_deps: CoreLoopDeps, task: WorkItem) => ({ taskId: task.id, status: "completed" as const, detail: "ok" }));
    const asked: unknown[] = [];
    const receipts = { runPending: vi.fn(async (work: unknown) => (asked.push(work), [])), dueMessages: async () => new Set<string>() };
    let atCap = false;
    const deps = buildDeps(undefined, undefined, undefined, undefined, undefined, undefined, stubSpendCap(() => atCap));
    const loop = new CoreLoop(withOverrides(deps, { client: { clientReceipts: receipts } }));

    await loop.runCycle();
    expect(asked).toEqual([{ kind: "running" }, { kind: "running" }]);

    asked.length = 0;
    atCap = true;
    await loop.runCycle();
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((work) => JSON.stringify(work) === JSON.stringify({ kind: "stopped-at-cap" }))).toBe(true);

    asked.length = 0;
    atCap = false;
    await loop.runHaltedCycle();
    expect(asked).toEqual([{ kind: "stopped-at-cap" }]);
  });

  test("the halted-cycle classification names exactly the steps CoreLoop runs", () => {
    expect(new Set(Object.keys(HALTED_CYCLE_CLASSIFICATION))).toEqual(new Set(CORE_LOOP_STEPS));
  });

  // Every step runs through CoreLoop's private step (stepThenCap included), so wrapping it on the
  // prototype sees every name a cycle passes, whichever wrapper ran it.
  test("every step a full cycle and a halted cycle run is in the step list, and a halted cycle runs only the steps classified halted", async () => {
    mockProcessTask.mockImplementation(async (_deps: CoreLoopDeps, task: WorkItem) => ({ taskId: task.id, status: "completed" as const, detail: "ok" }));
    const original: unknown = Reflect.get(CoreLoop.prototype, "step");
    if (typeof original !== "function") throw new TypeError("CoreLoop has no step method to observe");
    const ran: unknown[] = [];
    Reflect.set(CoreLoop.prototype, "step", function (this: CoreLoop, ...args: unknown[]) {
      ran.push(args[0]);
      return Reflect.apply(original, this, args);
    });
    try {
      const loop = new CoreLoop(buildDeps());
      await loop.runCycle();
      expect(new Set(ran)).toEqual(new Set(CORE_LOOP_STEPS));

      ran.length = 0;
      await loop.runHaltedCycle();
      const halted = Object.entries(HALTED_CYCLE_CLASSIFICATION).filter(([, kind]) => kind === "halted").map(([name]) => name);
      expect(new Set(ran)).toEqual(new Set(halted));
    } finally {
      Reflect.set(CoreLoop.prototype, "step", original);
    }
  });

  test("answers posted during the roster or the first plan are read in the same cycle, before the plan is revised or dispatched", async () => {
    const order: string[] = [];
    mockProcessTask.mockImplementation(async (_deps: CoreLoopDeps, task: WorkItem) => {
      order.push("dispatch");
      return { taskId: task.id, status: "completed" as const, detail: "ok" };
    });
    const step = (name: string) =>
      vi.fn(async () => {
        order.push(name);
        return [];
      });
    const deps = buildDeps({ runPending: step("intake") }, { runPending: step("plan") }, undefined, undefined, { runPending: step("roster") });

    await new CoreLoop(withOverrides(deps, { client: { liaisonAnswers: { runPending: step("answers") } }, planning: { replanning: { runPending: step("replan") } } })).runCycle();

    expect(order).toEqual(["intake", "answers", "roster", "answers", "plan", "answers", "replan", "dispatch", "dispatch"]);
  });

  test("a planning store failure fails the cycle instead of being skipped", async () => {
    const deps = buildDeps(undefined, {
      runPending: async () => {
        throw new Error("projects unreachable");
      },
    });
    await expect(new CoreLoop(deps).runCycle()).rejects.toThrow(/projects unreachable/);
    expect(mockProcessTask).not.toHaveBeenCalled();
  });
});

class StubRefusal extends Error {
  constructor(readonly refusal: "project" | "deployment") {
    super(`budget_cap: stub ${refusal} cap refusal`);
  }
}

/** A roster refusal whose cause chain names no model or provider failure: Ashara's own, as an unreadable vision is. */
class StubVisionUnreadable extends Error {
  constructor() {
    super("no valid roster");
    this.name = "VisionUnreadable";
  }
}

/** The amounts a stub cap refuses at. */
const STUB_SPEND = { capUsd: 5, spentUsd: 4.5, inFlightUsd: 0.25, nextCallUsd: 0.5 };

/** A spend cap whose deployment stop is `stop` once `stopped()` returns true. */
function stubSpendCap(stopped: () => boolean): SpendCapPort {
  const stop: LoopStop = { reason: "budget_cap: stub deployment cap", spend: STUB_SPEND };
  return {
    deploymentStop: async () => (stopped() ? stop : null),
    refusalOf: (error) =>
      error instanceof StubRefusal
        ? error.refusal === "project"
          ? { kind: "project", projectId: TEST_PROJECT_ID, reason: error.message, spend: STUB_SPEND }
          : { kind: "deployment", reason: error.message, spend: STUB_SPEND }
        : null,
  };
}

describe("CoreLoop spend cap", () => {
  test("recorded spend at the deployment cap stops the loop before any LLM step, after the client's stops", async () => {
    const order: string[] = [];
    const step = (name: string) =>
      vi.fn(async () => {
        order.push(name);
        return [];
      });

    const result = await new CoreLoop(
      withOverrides(
        buildDeps(
          { runPending: step("intake") },
          { runPending: step("plan") },
          { runPending: step("report") },
          { runPending: step("stop") },
          { runPending: step("roster") },
          undefined,
          stubSpendCap(() => true),
        ),
        { reporting: { terminalReports: { runPending: step("terminal") } } },
      ),
    ).runCycle();

    // The terminal messages run in the cycle's own steps and again as the cap halts it, both with no LLM call.
    expect(order).toEqual(["stop", "terminal", "terminal"]);
    expect(result.stop?.reason).toMatch(/budget_cap/);
    expect(mockProcessTask).not.toHaveBeenCalled();
  });

  // The cap halts every active project with one report each.
  test("at the deployment cap every active project halts at the cap and its report is posted before the loop stops", async () => {
    const order: string[] = [];
    const halted: unknown[] = [];
    const deps = buildDeps(undefined, undefined, undefined, undefined, undefined, undefined, stubSpendCap(() => true));
    const result = await new CoreLoop(withOverrides(deps, { loop: { projectRepo: {
        ...deps.loop.projectRepo,
        blockAllActive: async (cause) => {
          order.push("halt");
          halted.push(cause);
          return [TEST_PROJECT_ID];
        },
      } }, reporting: { blockReports: {
        runPending: async () => {
          order.push("reports");
          return [];
        },
      } } })).runCycle();

    expect(order).toEqual(["reports", "halt", "reports"]);
    expect(halted).toEqual([{ category: "budget_cap", errorClass: "DeploymentSpendCapReached", reason: "budget_cap: stub deployment cap", spend: STUB_SPEND }]);
    expect(result.stop?.reason).toBe("budget_cap: stub deployment cap");
  });

  test("a project refusal out of a step halts that project at its cap and ends that step only; the cycle goes on to dispatch", async () => {
    mockProcessTask.mockImplementation(async (_deps: CoreLoopDeps, task: WorkItem) => ({
      taskId: task.id,
      status: "completed" as const,
      detail: "ok",
    }));
    const roster = vi.fn(async () => []);
    const halted: Array<{ projectId: string; cause: unknown }> = [];
    const deps = buildDeps(
      {
        runPending: async () => {
          throw new StubRefusal("project");
        },
      },
      undefined,
      undefined,
      undefined,
      { runPending: roster },
      undefined,
      stubSpendCap(() => false),
    );

    const result = await new CoreLoop(withOverrides(deps, { loop: { projectRepo: {
        ...deps.loop.projectRepo,
        block: async (projectId, cause) => {
          halted.push({ projectId, cause });
          return "blocked";
        },
      } } })).runCycle();

    // Finance refuses; the halt is Delivery's.
    expect(halted).toEqual([
      { projectId: TEST_PROJECT_ID, cause: { category: "budget_cap", errorClass: "BudgetExceeded", reason: "budget_cap: stub project cap refusal", spend: STUB_SPEND } },
    ]);
    expect(roster).toHaveBeenCalledTimes(1);
    expect(result.stop).toBeNull();
    expect(result.tasksProcessed).toBe(2);
  });

  test("a project's halt logs in a trace of its own carrying the project, a child of the trace that reached it", async () => {
    mockProcessTask.mockImplementation(async (_deps: CoreLoopDeps, task: WorkItem) => ({ taskId: task.id, status: "completed" as const, detail: "ok" }));
    const logger = recordingLogger();
    const deps = buildDeps(
      {
        runPending: async () => {
          throw new StubRefusal("project");
        },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      stubSpendCap(() => false),
    );
    let blockTrace: string | null = null;
    await new CoreLoop(withOverrides(deps, { loop: { logger, projectRepo: {
        ...deps.loop.projectRepo,
        block: async () => {
          blockTrace = logger.trace();
          return "blocked";
        },
      } } })).runCycle();

    const blocked = logger.records.filter((r) => r.event === "delivery.project-blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({ projectId: TEST_PROJECT_ID, parentTraceId: logger.trace() });
    expect(blocked[0]?.traceId).not.toBe(logger.trace());
    expect(blockTrace).toBe(blocked[0]?.traceId);
  });

  test("a roster Organization refuses halts its project, blamed by the refusal's cause chain; Organization halts nothing itself", async () => {
    mockProcessTask.mockImplementation(async (_deps: CoreLoopDeps, task: WorkItem) => ({
      taskId: task.id,
      status: "completed" as const,
      detail: "ok",
    }));
    const halted: Array<{ projectId: string; cause: unknown }> = [];
    const deps = buildDeps(undefined, undefined, undefined, undefined, {
      runPending: async () => [
        { kind: "refused", projectId: TEST_PROJECT_ID, refusal: { errorClass: "VisionUnreadable", reason: "no valid roster", error: new StubVisionUnreadable() } },
      ],
    });

    await new CoreLoop(withOverrides(deps, { loop: { projectRepo: {
        ...deps.loop.projectRepo,
        block: async (projectId, cause) => {
          halted.push({ projectId, cause });
          return "blocked";
        },
      } } })).runCycle();

    expect(halted).toEqual([
      { projectId: TEST_PROJECT_ID, cause: { category: "fault", errorClass: "VisionUnreadable", reason: expect.stringContaining("no valid roster") } },
    ]);
  });

  test("a deployment refusal out of a step stops the loop with its reason, before the next step", async () => {
    let refused = false;
    const roster = vi.fn(async () => []);

    const result = await new CoreLoop(
      buildDeps(
        {
          runPending: async () => {
            refused = true;
            throw new StubRefusal("deployment");
          },
        },
        undefined,
        undefined,
        undefined,
        { runPending: roster },
        undefined,
        stubSpendCap(() => refused),
      ),
    ).runCycle();

    expect(result.stop?.reason).toMatch(/budget_cap/);
    expect(roster).not.toHaveBeenCalled();
    expect(mockProcessTask).not.toHaveBeenCalled();
  });

  test("a task refused at the deployment cap stops the loop with the refusal's reason; one refused at its project's does not", async () => {
    const reason = "budget_cap: the spend cap of the deployment (every project) is $5.000000";
    mockProcessTask.mockImplementation(async (_deps: CoreLoopDeps, task: WorkItem) =>
      task.id === TASK_IDS[0]
        ? { taskId: task.id, status: "refused" as const, detail: "refused", refusal: { kind: "project" as const, projectId: TEST_PROJECT_ID, reason: "budget_cap: project", spend: STUB_SPEND } }
        : { taskId: task.id, status: "refused" as const, detail: "refused", refusal: { kind: "deployment" as const, reason, spend: STUB_SPEND } },
    );

    const deps = buildDeps(undefined, undefined, undefined, undefined, undefined, undefined, stubSpendCap(() => false));
    const result = await new CoreLoop(deps).runCycle();

    expect(result.tasksProcessed).toBe(2);
    expect(result.stop).toEqual({ reason, spend: STUB_SPEND });
  });

  test("tasks refused only at their project's cap leave the loop running", async () => {
    mockProcessTask.mockImplementation(async (_deps: CoreLoopDeps, task: WorkItem) => ({
      taskId: task.id,
      status: "refused" as const,
      detail: "refused",
      refusal: { kind: "project" as const, projectId: TEST_PROJECT_ID, reason: "budget_cap: project", spend: STUB_SPEND },
    }));

    const result = await new CoreLoop(buildDeps(undefined, undefined, undefined, undefined, undefined, undefined, stubSpendCap(() => false))).runCycle();

    expect(result.stop).toBeNull();
  });
});
