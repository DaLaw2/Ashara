import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi, afterEach, beforeEach } from "vitest";
import type { WorkItemId } from "@ashara/shared";
import { createWorkItemId, parseProjectId } from "@ashara/shared";
import { memoryStepContainment, recordingLogger } from "@ashara/shared/testing";
import type { LiaisonClientStops, LiaisonIntake, LiaisonPlanReports, LiaisonStackChoices } from "./acl/engagement-acl.js";
import type { RosterDerivationStep } from "./acl/organization-acl.js";
import type { FirstPlanning } from "./first-plan.js";
import type { WorkItem } from "./domain/index.js";
import { DEFAULT_CONFIG, withOverrides } from "./types.js";
import type { CoreLoopDeps, LoopStop, TaskResult } from "./types.js";
import { CoreLoop } from "./core-loop.js";
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
      gate: async () => ({ available: twoTasks(), unlockWeights: new Map<string, number>() }),
      next: original.PlanningService.next,
    },
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  clientStops: LiaisonClientStops = { runPending: async () => [], reportPending: async () => [] },
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

const cycleTallies: Array<Parameters<CoreLoopDeps["loop"]["cycleLog"]["emit"]>[0]> = [];

beforeEach(() => {
  cycleTallies.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  mockProcessTask.mockReset();
});

describe("CoreLoop batch dispatch parallelism", () => {
  test("two tasks in a batch produce overlapping execution windows", async () => {
    // Track when each task's processTask starts and finishes to prove
    // concurrent dispatch. A serial loop would show task-B starting AFTER
    // task-A finishes; parallel dispatch shows them overlapping.
    const timeline: Array<{ taskId: string; event: "start" | "end"; ts: number }> = [];

    mockProcessTask.mockImplementation(async (_deps: CoreLoopDeps, task: WorkItem) => {
      const taskId = task.id;
      timeline.push({ taskId, event: "start", ts: Date.now() });
      // Simulate meaningful async work so the overlap window is observable
      await new Promise((resolve) => setTimeout(resolve, 50));
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
      { runPending: step("stop"), reportPending: step("stop-report") },
      { runPending: step("roster") },
    );
    await new CoreLoop(withOverrides(deps, { client: { clientChanges: { runPending: step("change") } } })).runCycle();

    expect(order).toEqual(["stop", "stop-report", "intake", "change", "roster", "plan", "report", "dispatch", "dispatch"]);
  });

  test("a cycle halted at the spend cap takes the client's stops and posts the block, delivered and plan reports still due, and nothing else: a change is read by a model, so it waits", async () => {
    const order: string[] = [];
    const step = (name: string) =>
      vi.fn(async () => {
        order.push(name);
        return [];
      });
    const deps = buildDeps({ runPending: step("intake") }, { runPending: step("plan") }, { runPending: step("report") }, { runPending: step("stop"), reportPending: step("stop-report") });

    await new CoreLoop(withOverrides(deps, { client: { clientChanges: { runPending: step("change") } }, reporting: { blockReports: { runPending: step("block-report") }, deliveredReports: { runPending: step("delivered-report") } } })).runHaltedCycle();

    expect(order).toEqual(["stop", "stop-report", "block-report", "delivered-report", "report"]);
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
    const deps = buildDeps({ runPending: step("intake") }, undefined, undefined, { runPending: step("stop"), reportPending: step("stop-report") });
    const loop = new CoreLoop(withOverrides(deps, { client: { clientReceipts: { runPending: step("receipt"), dueMessages: async () => new Set() }, clientChanges: { runPending: step("change") } } }));

    await loop.runCycle();
    expect(order).toEqual(["stop", "receipt", "stop-report", "intake", "change", "dispatch", "dispatch", "receipt"]);

    order.length = 0;
    await loop.runHaltedCycle();
    expect(order).toEqual(["stop", "receipt", "stop-report"]);
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

  test("every step the cycle runs with no model call is either run by a halted cycle or excluded from it with its reason", () => {
    // A step with no model call that posts what the client is owed and is left out of runHaltedCycle
    // waits, after a cap halt, for a full cycle this process never runs. A new step is classified here.
    const classified: Record<string, "halted" | { readonly excluded: string }> = {
      "client-stop": "halted",
      "client-receipt": "halted",
      "client-stop-report": "halted",
      "settled-branches": "halted",
      "block-report": "halted",
      "delivered-report": "halted",
      "plan-report": "halted",
      "stack-choice": { excluded: "it records a vision version from a merged choice, a change a halted loop does not make; only a project at work has a choice due, so a project halted at the cap has its choice recorded and reported once it resumes, in a full cycle after the process restarts" },
      "infrastructure-resume": { excluded: "it returns a halted project to work, which a loop halted at the cap does not admit" },
      "client-wait-resume": { excluded: "it returns a halted project to work, which a loop halted at the cap does not admit" },
      "parked-exits": { excluded: "it moves Blocked tasks toward dispatch, and a halted cycle dispatches nothing" },
      "acceptance": { excluded: "it sweeps main on cells, which is work, not a report" },
      "terminal-sweep": "halted",
      "gate": { excluded: "it selects tasks to dispatch, and a halted cycle dispatches nothing" },
      "burn-warning": { excluded: "it warns before the budget halts a project; a project halted at the cap is told so by its block report" },
    };
    const source = readFileSync(new URL("./core-loop.ts", import.meta.url), "utf8");
    const steps = [...source.matchAll(/this\.step\("([a-z-]+)"/g)].map((match) => match[1]);

    expect(new Set(steps)).toEqual(new Set(Object.keys(classified)));
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
      buildDeps(
        { runPending: step("intake") },
        { runPending: step("plan") },
        { runPending: step("report") },
        { runPending: step("stop"), reportPending: step("stop-report") },
        { runPending: step("roster") },
        undefined,
        stubSpendCap(() => true),
      ),
    ).runCycle();

    // The stop reports run in the cycle's own steps and again as the cap halts it, both with no LLM call.
    expect(order).toEqual(["stop", "stop-report", "stop-report"]);
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
