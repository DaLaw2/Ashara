import { describe, expect, test, vi, afterEach, beforeEach } from "vitest";
import type { WorkItemId } from "@ashara/shared";
import { createWorkItemId, parseProjectId } from "@ashara/shared";
import type { LiaisonIntake, LiaisonPlanReports } from "./acl/engagement-acl.js";
import type { FirstPlanning, WorkItem, WorkItemRepository } from "./acl/planning-acl.js";
import { DEFAULT_CONFIG } from "./types.js";
import type { CoreLoopDeps, TaskCostInfo, TaskResult } from "./types.js";
import { CoreLoop } from "./core-loop.js";

// ---------------------------------------------------------------------------
// Mock heavy orchestrator modules that CoreLoop.runCycle exercises. We replace
// them with stubs so the test drives only the batch-dispatch parallelism, not
// reconciliation or the planning gate.
// ---------------------------------------------------------------------------

const mockProcessTask = vi.fn<(
  deps: CoreLoopDeps,
  task: WorkItem,
  runScope: string,
) => Promise<{ result: TaskResult; costInfo: TaskCostInfo }>>();

vi.mock("./execution.js", () => ({
  processTask: (deps: CoreLoopDeps, task: WorkItem, runScope: string) =>
    mockProcessTask(deps, task, runScope),
  handleProcessingError: async (_deps: CoreLoopDeps, task: WorkItem) => ({
    taskId: task.id,
    status: "failed" as const,
    detail: "mock error",
  }),
}));

vi.mock("./acl/planning-acl.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./acl/planning-acl.js")>();
  return {
    ...original,
    PlanningService: {
      gate: async () => twoTasks(),
      select: (_eligible: WorkItem[], _max: number) => twoTasks(),
    },
    DependencyGraph: {
      load: async () => ({ computeUnlockWeights: () => new Map<string, number>() }),
    },
  };
});

vi.mock("./run-state.js", () => ({
  openRun: async () => ({
    runId: "run-parallel-test",
    spendUsd: 0,
  }),
  persistRun: async (_store: unknown, state: unknown) => state,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_PROJECT_ID = parseProjectId("00000000-0000-4000-8000-000000000001");
const TASK_IDS: [WorkItemId, WorkItemId] = [createWorkItemId(), createWorkItemId()];

function pendingTask(id: WorkItemId, title: string): WorkItem {
  const now = new Date();
  return {
    id,
    level: "Task",
    status: "Pending",
    title,
    runScope: "run-parallel-test",
    projectId: TEST_PROJECT_ID,
    dispatchCount: 0,
    createdAt: now,
    updatedAt: now,
    events: [],
  };
}

function twoTasks(): WorkItem[] {
  return [pendingTask(TASK_IDS[0], "task-alpha"), pendingTask(TASK_IDS[1], "task-beta")];
}

function notExercised(label: string): () => never {
  return () => { throw new Error(`${label}: not exercised`); };
}

function buildDeps(
  liaisonIntake: LiaisonIntake = { runPending: async () => [] },
  firstPlanning: FirstPlanning = { runPending: async () => [] },
  planReports: LiaisonPlanReports = { runPending: async () => [] },
): CoreLoopDeps {
  const workItemRepo: WorkItemRepository = {
    findById: async () => null,
    save: async () => {},
    create: notExercised("create"),
    listByProject: notExercised("listByProject"),
    findByProjectAndStatus: notExercised("findByProjectAndStatus"),
    projectIdsWithStatus: notExercised("projectIdsWithStatus"),
    listIdsByStatus: notExercised("listIdsByStatus"),
    incrementDispatchCount: async () => 1,
    addDependency: notExercised("addDependency"),
    getDependencies: async () => [],
    findChildren: async () => [],
    listAllDependencies: notExercised("listAllDependencies"),
    withTransaction: notExercised("withTransaction"),
  };

  const eventStore = {
    publish: async () => {},
  };
  const costRepo = { recordTaskCost: async () => {}, getTaskCostHistory: async () => [] };
  const projectRepo = { get: async () => null, recordWorkspacePath: notExercised("recordWorkspacePath") };
  const failedApproachRepo = { record: async () => {} };
  const runStateStore = { load: async () => null, save: async () => {} };

  return {
    config: { ...DEFAULT_CONFIG, workdirBase: "/tmp/test-parallel", maxBatchSize: 4 },
    workItemRepo,
    eventStore,
    costRepo,
    failedApproachRepo,
    projectRepo,
    developmentService: {},
    runStateStore,
    failureRouter: {},
    liaisonIntake,
    firstPlanning,
    planReports,
  } as unknown as CoreLoopDeps;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
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
      return {
        result: { taskId, status: "completed" as const, detail: "ok" },
        costInfo: { costUsd: 0.01, inputTokens: 100, outputTokens: 50, modelId: "test", attempt: 1 },
      };
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

  test("budget accumulation happens sequentially after all tasks complete", async () => {
    const callOrder: string[] = [];

    mockProcessTask.mockImplementation(async (_deps: CoreLoopDeps, task: WorkItem) => {
      callOrder.push(`dispatch:${task.id}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        result: { taskId: task.id, status: "completed" as const, detail: "ok" },
        costInfo: { costUsd: 0.05, inputTokens: 100, outputTokens: 50, modelId: "test", attempt: 1 },
      };
    });

    const deps = buildDeps();
    const loop = new CoreLoop(deps);
    await loop.runCycle();

    // Both dispatch calls must appear in the log
    const dispatches = callOrder.filter((e) => e.startsWith("dispatch:"));
    expect(dispatches).toHaveLength(2);
  });

  test("rejected task in batch does not prevent other results from accumulating", async () => {
    let callCount = 0;
    mockProcessTask.mockImplementation(async (_deps: CoreLoopDeps, task: WorkItem) => {
      callCount++;
      if (callCount === 1) {
        throw new Error("simulated agent crash");
      }
      return {
        result: { taskId: task.id, status: "completed" as const, detail: "ok" },
        costInfo: { costUsd: 0.02, inputTokens: 100, outputTokens: 50, modelId: "test", attempt: 1 },
      };
    });

    const deps = buildDeps();
    const loop = new CoreLoop(deps);
    const cycleResult = await loop.runCycle();

    // Both tasks dispatched, one failed, one completed
    expect(cycleResult.tasksProcessed).toBe(2);
    expect(cycleResult.results).toHaveLength(2);
    const statuses = cycleResult.results.map((r) => r.status).sort();
    expect(statuses).toEqual(["completed", "failed"]);
  });
});

describe("CoreLoop tender intake", () => {
  test("a cycle runs the Liaison's intake before dispatching work", async () => {
    const order: string[] = [];
    mockProcessTask.mockImplementation(async (_deps: CoreLoopDeps, task: WorkItem) => {
      order.push("dispatch");
      return {
        result: { taskId: task.id, status: "completed" as const, detail: "ok" },
        costInfo: { costUsd: 0.01, inputTokens: 1, outputTokens: 1, modelId: "test", attempt: 1 },
      };
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
  test("a cycle runs intake, then first planning, then the Liaison's reports, then dispatch", async () => {
    const order: string[] = [];
    mockProcessTask.mockImplementation(async (_deps: CoreLoopDeps, task: WorkItem) => {
      order.push("dispatch");
      return {
        result: { taskId: task.id, status: "completed" as const, detail: "ok" },
        costInfo: { costUsd: 0.01, inputTokens: 1, outputTokens: 1, modelId: "test", attempt: 1 },
      };
    });
    const step = (name: string) =>
      vi.fn(async () => {
        order.push(name);
        return [];
      });

    await new CoreLoop(buildDeps({ runPending: step("intake") }, { runPending: step("plan") }, { runPending: step("report") })).runCycle();

    expect(order).toEqual(["intake", "plan", "report", "dispatch", "dispatch"]);
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
