import { describe, expect, test, vi, afterEach, beforeEach } from "vitest";
import type { WorkItemId } from "@ashara/shared";
import { createWorkItemId, parseProjectId } from "@ashara/shared";
import type { LiaisonClientStops, LiaisonIntake, LiaisonPlanReports, LiaisonStackChoices } from "./acl/engagement-acl.js";
import type { RosterDerivationStep } from "./acl/organization-acl.js";
import type { FirstPlanning, WorkItem, WorkItemRepository } from "./acl/planning-acl.js";
import { DEFAULT_CONFIG } from "./types.js";
import type { CoreLoopDeps, LoopStop, TaskResult } from "./types.js";
import { CoreLoop } from "./core-loop.js";

type SpendCapPort = CoreLoopDeps["spendCap"];

// ---------------------------------------------------------------------------
// Mock heavy orchestrator modules that CoreLoop.runCycle exercises. We replace
// them with stubs so the test drives only the batch-dispatch parallelism, not
// reconciliation or the planning gate.
// ---------------------------------------------------------------------------

const mockProcessTask = vi.fn<(
  deps: CoreLoopDeps,
  task: WorkItem,
  runScope: string,
) => Promise<TaskResult>>();

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
      unlockWeights: async () => new Map<string, number>(),
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
    runScope: "run-parallel-test",
    projectId: TEST_PROJECT_ID,
    dispatchCount: 0,
    workKind: "implementation",
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
  clientStops: LiaisonClientStops = { runPending: async () => [] },
  rosterDerivation: RosterDerivationStep = { runPending: async () => [] },
  stackChoices: LiaisonStackChoices = { runPending: async () => [] },
  spendCap: SpendCapPort = { deploymentStop: async () => null, refusalOf: () => null },
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
    refundDispatchCount: notExercised("refundDispatchCount"),
    recordMergeCommit: notExercised("recordMergeCommit"),
    addDependency: notExercised("addDependency"),
    getDependencies: async () => [],
    findChildren: async () => [],
    listDependenciesByProject: notExercised("listDependenciesByProject"),
    withTransaction: notExercised("withTransaction"),
  };

  // Fully typed: a dep CoreLoopDeps gains and this omits is a compile error here, never a
  // runtime TypeError the runner retries forever.
  return {
    config: { ...DEFAULT_CONFIG, workdirBase: "/tmp/test-parallel", maxBatchSize: 4 },
    workItemRepo,
    eventStore: { publish: async () => {} },
    failedApproachRepo: { record: async () => {} },
    projectRepo: {
      get: async () => null,
      recordWorkspacePath: notExercised("recordWorkspacePath"),
      listActiveIds: async () => [],
      block: notExercised("block"),
    },
    developmentService: { execute: notExercised("execute") },
    spendCap,
    failureRouter: { route: notExercised("route") },
    clientStops,
    liaisonIntake,
    liaisonAnswers: { runPending: async () => [] },
    rosterDerivation,
    firstPlanning,
    replanning: { runPending: async () => [] },
    planReports,
    stackChoices,
    checkDisputes: { record: notExercised("checkDisputes") },
    disputeReports: { blockOnDisputes: notExercised("disputeReports") },
    blockReports: { runPending: async () => [] },
    parkedExits: { latestRosterRevision: notExercised("latestRosterRevision"), environmentBuilt: notExercised("environmentBuilt") },
    environmentOwner: notExercised("environmentOwner"),
  };
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
  test("a cycle runs client stops, then intake, the roster, first planning, the Liaison's reports, then dispatch", async () => {
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

    await new CoreLoop(
      buildDeps(
        { runPending: step("intake") },
        { runPending: step("plan") },
        { runPending: step("report") },
        { runPending: step("stop") },
        { runPending: step("roster") },
      ),
    ).runCycle();

    expect(order).toEqual(["stop", "intake", "roster", "plan", "report", "dispatch", "dispatch"]);
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

/** A spend cap whose deployment stop is `stop` once `stopped()` returns true. */
function stubSpendCap(stopped: () => boolean): SpendCapPort {
  const stop: LoopStop = { reason: "budget_cap: stub deployment cap" };
  return {
    deploymentStop: async () => (stopped() ? stop : null),
    refusalOf: (error) =>
      error instanceof StubRefusal
        ? error.refusal === "project"
          ? { kind: "project", projectId: TEST_PROJECT_ID, reason: error.message }
          : { kind: "deployment", reason: error.message }
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
        { runPending: step("stop") },
        { runPending: step("roster") },
        undefined,
        stubSpendCap(() => true),
      ),
    ).runCycle();

    expect(order).toEqual(["stop"]);
    expect(result.stop?.reason).toMatch(/budget_cap/);
    expect(mockProcessTask).not.toHaveBeenCalled();
  });

  test("a project refusal out of a step ends that step only; the cycle goes on to dispatch", async () => {
    mockProcessTask.mockImplementation(async (_deps: CoreLoopDeps, task: WorkItem) => ({
      taskId: task.id,
      status: "completed" as const,
      detail: "ok",
    }));
    const roster = vi.fn(async () => []);

    const result = await new CoreLoop(
      buildDeps(
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
      ),
    ).runCycle();

    expect(roster).toHaveBeenCalledTimes(1);
    expect(result.stop).toBeNull();
    expect(result.tasksProcessed).toBe(2);
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
        ? { taskId: task.id, status: "refused" as const, detail: "refused", refusal: { kind: "project" as const, projectId: TEST_PROJECT_ID, reason: "budget_cap: project" } }
        : { taskId: task.id, status: "refused" as const, detail: "refused", refusal: { kind: "deployment" as const, reason } },
    );

    const deps = buildDeps(undefined, undefined, undefined, undefined, undefined, undefined, stubSpendCap(() => false));
    const result = await new CoreLoop(deps).runCycle();

    expect(result.tasksProcessed).toBe(2);
    expect(result.stop).toEqual({ reason });
  });

  test("tasks refused only at their project's cap leave the loop running", async () => {
    mockProcessTask.mockImplementation(async (_deps: CoreLoopDeps, task: WorkItem) => ({
      taskId: task.id,
      status: "refused" as const,
      detail: "refused",
      refusal: { kind: "project" as const, projectId: TEST_PROJECT_ID, reason: "budget_cap: project" },
    }));

    const result = await new CoreLoop(buildDeps(undefined, undefined, undefined, undefined, undefined, undefined, stubSpendCap(() => false))).runCycle();

    expect(result.stop).toBeNull();
  });
});
