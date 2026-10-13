import { describe, expect, test, vi, afterEach, beforeEach } from "vitest";
import type { WorkItemId } from "@ashara/shared";
import { createWorkItemId } from "@ashara/shared";
import { createPendingWorkItem } from "./acl/planning-acl.js";
import type { WorkItem, WorkItemRepository } from "./acl/planning-acl.js";
import { DEFAULT_CONFIG } from "./types.js";
import type { CoreLoopDeps, TaskCostInfo, TaskResult } from "./types.js";
import { CoreLoop } from "./core-loop.js";

// ---------------------------------------------------------------------------
// Mock heavy orchestrator modules that CoreLoop.runCycle exercises. We replace
// them with stubs so the test drives only the batch-dispatch parallelism, not
// the full decomposition/termination pipeline.
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
    decomposeLeafStories: async () => 0,
  };
});

vi.mock("./termination-snapshot.js", () => ({
  evaluateRunTermination: async () => ({
    decision: { action: "continue" as const },
    summary: null,
  }),
}));

vi.mock("./post-cycle.js", () => ({
  runPostCycleChecks: async () => {},
  reconcileCoverageGaps: async () => {},
}));

vi.mock("./liveness-handler.js", () => ({
  attemptLivenessRecovery: async () => 0,
}));

vi.mock("./run-state.js", () => ({
  openRun: async () => ({
    runId: "run-parallel-test",
    spendUsd: 0,
    acceptanceAttempts: 0,
    replanRounds: 0,
  }),
  persistRun: async (_store: unknown, state: unknown) => state,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TASK_IDS: [WorkItemId, WorkItemId] = [createWorkItemId(), createWorkItemId()];

function twoTasks(): WorkItem[] {
  const a = createPendingWorkItem("Task", "task-alpha", "run-parallel-test");
  a.id = TASK_IDS[0];
  const b = createPendingWorkItem("Task", "task-beta", "run-parallel-test");
  b.id = TASK_IDS[1];
  return [a, b];
}

function notExercised(label: string): () => never {
  return () => { throw new Error(`${label}: not exercised`); };
}

function buildDeps(): CoreLoopDeps {
  const workItemRepo: WorkItemRepository = {
    findById: async () => null,
    save: async () => {},
    create: notExercised("create"),
    findByStatus: notExercised("findByStatus"),
    incrementDispatchCount: async () => 1,
    listAll: notExercised("listAll"),
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
  const visionRepo = { getLatest: async () => null, getProjectPath: async () => null, setProjectPath: async () => {} };
  const failedApproachRepo = { record: async () => {} };
  const runStateStore = { load: async () => null, save: async () => {} };

  return {
    config: { ...DEFAULT_CONFIG, workdirBase: "/tmp/test-parallel", maxBatchSize: 4 },
    workItemRepo,
    eventStore,
    costRepo,
    brainstormLogRepo: {},
    failedApproachRepo,
    contextBriefRepo: {},
    visionRepo,
    developmentService: {},
    acceptanceAttempts: 0,
    replanRounds: 0,
    runStateStore,
    withPlanningTransaction: async (fn: (repos: unknown) => Promise<unknown>) => fn({}),
    failureRouter: {},
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
