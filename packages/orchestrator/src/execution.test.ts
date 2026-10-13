import { describe, expect, test, vi, afterEach } from "vitest";
import type { StoredBlockedReason, WorkItemId } from "@ashara/shared";
import { createWorkItemId, parseProjectId, parseWorkItemJsonb } from "@ashara/shared";
import type { AgentOutputJson } from "@ashara/shared/agent-output";
import { startWorkItem, takeEvents } from "./acl/planning-acl.js";
import type { WorkItem, WorkItemRepository } from "./acl/planning-acl.js";
import { DEFAULT_CONFIG } from "./types.js";
import type { CoreLoopDeps } from "./types.js";
import { processTask } from "./execution.js";

const RUN_SCOPE = "run-test-preemption";
const TEST_PROJECT_ID = parseProjectId("00000000-0000-4000-8000-000000000001");
// Stable ID shared by every item copy the mock repo returns, so the domain
// service, lifecycle router, and processTask itself all operate on what looks
// like the same row.
const ITEM_ID: WorkItemId = createWorkItemId();

function freshPendingItem(): WorkItem {
  const now = new Date();
  return {
    id: ITEM_ID,
    level: "Task",
    status: "Pending",
    title: "test-preempted-task",
    runScope: RUN_SCOPE,
    projectId: TEST_PROJECT_ID,
    dispatchCount: 0,
    workKind: "implementation",
    createdAt: now,
    updatedAt: now,
    events: [],
  };
}

function freshAbandonedItem(opts?: { omitBlockedReason?: boolean }): WorkItem {
  const item = freshPendingItem();
  startWorkItem(item);
  item.status = "Abandoned";
  if (!opts?.omitBlockedReason) {
    item.blockedReason = { source: "api", reason: "cancelled by operator" } satisfies StoredBlockedReason;
  }
  item.updatedAt = new Date();
  takeEvents(item);
  return item;
}

function notExercised(label: string): () => never {
  return () => { throw new Error(`${label}: not exercised`); };
}

/**
 * Builds a CoreLoopDeps mock where the workItemRepo returns a Pending item on
 * the first findById call and an Abandoned item on all subsequent calls —
 * simulating an external actor (HTTP PATCH) moving the item while the agent
 * was executing.
 *
 * CoreLoopDeps references concrete classes from @ashara/db whose private fields
 * prevent structural mocking. We build a plain object with the methods
 * processTask exercises, then widen via `unknown` — the test validates
 * correctness by calling the real function and observing its output, not by
 * satisfying every private field of a repository class.
 */
interface PreemptionDepsOptions {
  /** Override the agent's execution result status. Default: "failed". */
  agentOutcome?: "completed" | "failed" | "blocked";
  /** When true, the Abandoned item has no blockedReason (the NULL gap). */
  omitBlockedReason?: boolean;
}

function buildPreemptionDeps(options?: PreemptionDepsOptions): {
  deps: CoreLoopDeps;
  warns: string[];
  logs: string[];
  savedBlockedReasons: StoredBlockedReason[];
} {
  const agentOutcome = options?.agentOutcome ?? "failed";
  const warns: string[] = [];
  const logs: string[] = [];
  const savedBlockedReasons: StoredBlockedReason[] = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warns.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });

  let findByIdCalls = 0;
  const workItemRepo: WorkItemRepository = {
    findById: async (_id: WorkItemId) => {
      findByIdCalls++;
      if (findByIdCalls === 1) return freshPendingItem();
      return freshAbandonedItem({ omitBlockedReason: options?.omitBlockedReason });
    },
    save: async (item: WorkItem) => {
      // Capture the blockedReason written by the salvage path
      if (item.blockedReason) savedBlockedReasons.push(item.blockedReason);
    },
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

  // Plain objects that satisfy only the methods processTask exercises.
  // Repository classes have private `db` fields that prevent structural
  // mocking without instantiation; the `unknown` widening below is the
  // standard test workaround for class-typed dependency slots.
  const eventStore = { publish: async () => {} };
  const projectRepo = {
    get: async () => null,
    recordWorkspacePath: notExercised("recordWorkspacePath"),
  };
  const failedApproachRepo = { record: async () => {} };
  const runStateStore = { load: async () => null, save: async () => {} };
  const developmentService = {
    execute: async () => ({
      status: agentOutcome,
      detail: agentOutcome === "completed"
        ? "task completed and verified successfully"
        : "agent hit turn limit",
      output: null as AgentOutputJson | null,
      sessionId: "test-session",
      attempt: 1,
      agentInvoked: false,
    }),
  };

  const deps = {
    config: { ...DEFAULT_CONFIG, workdirBase: "/tmp/test-workdir" },
    workItemRepo,
    eventStore,
    costRepo: { recordTaskCost: async () => {} },
    failedApproachRepo,
    projectRepo,
    developmentService,
    runStateStore,
  } as unknown as CoreLoopDeps;

  return { deps, warns, logs, savedBlockedReasons };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("processTask post-agent status ladder", () => {
  test("preempted-to-Abandoned item with failed result salvages the result", async () => {
    const { deps, logs, savedBlockedReasons } = buildPreemptionDeps();
    const task = freshPendingItem();

    const { result, costInfo } = await processTask(deps, task);

    // The function must return the agent's result, not throw
    expect(result.status).toBe("failed");
    expect(costInfo.costUsd).toBe(0);

    // The salvage must produce a structured log (Discipline C)
    const salvageLog = logs.find((l) => l.includes("salvaged preempted result"));
    expect(salvageLog).toBeDefined();
    expect(salvageLog).toContain(ITEM_ID);
    expect(salvageLog).toContain("outcome: failed");

    // The blockedReason must carry the salvaged fields after save
    expect(savedBlockedReasons.length).toBeGreaterThan(0);
    const lastSaved = savedBlockedReasons[savedBlockedReasons.length - 1];
    expect(lastSaved.salvagedOutcome).toBe("failed");
    expect(lastSaved.salvagedDetail).toBeDefined();
    expect(lastSaved.salvagedAt).toBeDefined();
  });

  test("preempted-to-Abandoned item with completed result salvages the result", async () => {
    const { deps, logs, savedBlockedReasons } = buildPreemptionDeps({
      agentOutcome: "completed",
    });
    const task = freshPendingItem();

    const { result, costInfo } = await processTask(deps, task);

    // The completed agent result is still returned
    expect(result.status).toBe("completed");
    expect(costInfo.costUsd).toBe(0);

    // The salvage must produce a structured log
    const salvageLog = logs.find((l) => l.includes("salvaged preempted result"));
    expect(salvageLog).toBeDefined();
    expect(salvageLog).toContain(ITEM_ID);
    expect(salvageLog).toContain("outcome: completed");

    // The blockedReason must carry the salvaged outcome
    expect(savedBlockedReasons.length).toBeGreaterThan(0);
    const lastSaved = savedBlockedReasons[savedBlockedReasons.length - 1];
    expect(lastSaved.salvagedOutcome).toBe("completed");
    expect(typeof lastSaved.salvagedAt).toBe("string");
  });

  test("Abandoned item with no prior blockedReason still salvages the result", async () => {
    const { deps, logs, warns, savedBlockedReasons } = buildPreemptionDeps({
      omitBlockedReason: true,
    });
    const task = freshPendingItem();

    const { result } = await processTask(deps, task);

    expect(result.status).toBe("failed");

    // A warning about the missing blockedReason must be emitted (Discipline C)
    const gapWarn = warns.find((w) => w.includes("no blockedReason"));
    expect(gapWarn).toBeDefined();
    expect(gapWarn).toContain(ITEM_ID);

    // The salvage must still succeed — the result must not be lost
    const salvageLog = logs.find((l) => l.includes("salvaged preempted result"));
    expect(salvageLog).toBeDefined();
    expect(salvageLog).toContain("outcome: failed");

    // The constructed reason must parse under storedBlockedReasonSchema
    expect(savedBlockedReasons.length).toBeGreaterThan(0);
    const lastSaved = savedBlockedReasons[savedBlockedReasons.length - 1];
    expect(() =>
      parseWorkItemJsonb({ id: ITEM_ID, projectId: "p", taskSpec: null, successCriteria: null, blockedReason: lastSaved }),
    ).not.toThrow();

    // The constructed reason must carry the salvaged fields
    expect(lastSaved.salvagedOutcome).toBe("failed");
    expect(lastSaved.salvagedDetail).toBeDefined();
    expect(lastSaved.salvagedAt).toBeDefined();
    // The base reason must be orchestrator_error (honest about provenance)
    expect(lastSaved.source).toBe("orchestrator_error");
  });

  test("vanished item (null re-read) logs a warning and does not throw", async () => {
    const { deps, warns } = buildPreemptionDeps();

    // Override findById to return null after the first call
    let calls = 0;
    (deps.workItemRepo as WorkItemRepository).findById = async () => {
      calls++;
      if (calls === 1) return freshPendingItem();
      return null;
    };

    const task = freshPendingItem();
    const { result } = await processTask(deps, task);

    expect(result.status).toBe("failed");

    const vanishedWarn = warns.find((w) => w.includes("vanished"));
    expect(vanishedWarn).toBeDefined();
    expect(vanishedWarn).toContain(ITEM_ID);
    expect(vanishedWarn).toContain("agent spend unrecoverable");
  });
});

describe("an environment-blocked dispatch parks the item at Blocked", () => {
  type ExecutionResult = Awaited<ReturnType<CoreLoopDeps["developmentService"]["execute"]>>;

  const probeBlocked: ExecutionResult = {
    status: "environment_blocked",
    unavailable: "podman",
    detail: "execution substrate \"podman\" unavailable; no agent ran: podman binary not found on PATH",
    output: null,
    sessionId: "test-session",
    attempt: 1,
    errorEnvelope: { outcome: "blocked", summary: "podman unavailable", chain: { boundary: "development", operation: "provision", message: "podman unavailable", timestamp: new Date().toISOString() } },
    agentInvoked: false,
  };

  function buildEnvironmentBlockedDeps(execResult: ExecutionResult = probeBlocked): {
    deps: CoreLoopDeps;
    stored: () => WorkItem;
    statusesWritten: string[];
    failureRoutes: () => number;
    failedApproaches: () => number;
  } {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let row = freshPendingItem();
    const statusesWritten: string[] = [];
    let routed = 0;
    let approaches = 0;
    const copy = (item: WorkItem): WorkItem => ({ ...item, events: [] });

    const workItemRepo: WorkItemRepository = {
      findById: async () => copy(row),
      save: async (item: WorkItem, expectedPreviousStatus) => {
        if (row.status !== expectedPreviousStatus) {
          throw new Error(`pre-image mismatch: stored ${row.status}, expected ${expectedPreviousStatus}`);
        }
        statusesWritten.push(item.status);
        row = copy(item);
      },
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

    const developmentService = { execute: async () => execResult };

    const deps = {
      config: { ...DEFAULT_CONFIG, workdirBase: "/tmp/test-workdir" },
      workItemRepo,
      eventStore: { publish: async () => {} },
      costRepo: { recordTaskCost: async () => {} },
      failedApproachRepo: { record: async () => { approaches++; } },
      projectRepo: { get: async () => null, recordWorkspacePath: notExercised("recordWorkspacePath") },
      developmentService,
      runStateStore: { load: async () => null, save: async () => {} },
      failureRouter: { route: () => { routed++; throw new Error("failure router must not be called"); } },
    } as unknown as CoreLoopDeps;

    return { deps, stored: () => row, statusesWritten, failureRoutes: () => routed, failedApproaches: () => approaches };
  }

  test("the item becomes Blocked with an environment_unavailable reason, never Failed, and the failure router is not called", async () => {
    const { deps, stored, statusesWritten, failureRoutes, failedApproaches } = buildEnvironmentBlockedDeps();

    const { result, costInfo } = await processTask(deps, freshPendingItem());

    expect(result.status).toBe("blocked");
    expect(costInfo.costUsd).toBe(0);
    expect(stored().status).toBe("Blocked");
    expect(statusesWritten).toEqual(["InProgress", "Blocked"]);
    expect(statusesWritten).not.toContain("Failed");
    expect(failureRoutes()).toBe(0);
    expect(failedApproaches()).toBe(0);

    const reason = stored().blockedReason;
    expect(reason?.source).toBe("environment_unavailable");
    if (reason?.source !== "environment_unavailable") return;
    expect(reason.unavailable).toBe("podman");
    expect(reason.reason).toContain("podman binary not found");
    // The persisted reason must survive the jsonb read-back schema.
    expect(() =>
      parseWorkItemJsonb({ id: ITEM_ID, projectId: "p", taskSpec: null, successCriteria: null, blockedReason: reason }),
    ).not.toThrow();
  });

  // The isolated-worker run's finding 1: the verifier cell refused after the agent's work passed.
  // Before, operation postMergeVerify reached the classifier as TREE_REGRESSION and was abandoned.
  test("a verifier cell refused after the agent ran: Blocked naming the stage, never the failure router", async () => {
    const output: AgentOutputJson = {
      status: "done",
      summary: "wrote greet.sh",
      findings: [],
      error: null,
      error_detail: null,
      total_tokens: { input: 100, output: 10 },
      total_cost: 0.0006,
      cost_measured: true,
      turn_count: 4,
      finish_reason: "completed",
    };
    const detail =
      "environment failed at stage postMergeVerify (MountPathRejected): Mount of \"/x/target\" refused: it is not strictly inside the mount root; " +
      "task t blocked, the agent's work is kept on the task branch";
    const { deps, stored, statusesWritten, failureRoutes, failedApproaches } = buildEnvironmentBlockedDeps({
      status: "environment_blocked",
      unavailable: "verifier cell mount (/x/target)",
      detail,
      output,
      sessionId: "test-session",
      attempt: 1,
      errorEnvelope: {
        outcome: "blocked",
        summary: detail,
        chain: { boundary: "development", operation: "postMergeVerify", message: "Post-merge verify could not run", timestamp: new Date().toISOString() },
        agentOutput: output,
      },
      agentInvoked: true,
    });

    const { result, costInfo } = await processTask(deps, freshPendingItem());

    expect(result.status).toBe("blocked");
    expect(costInfo.costUsd).toBe(0.0006);
    expect(statusesWritten).toEqual(["InProgress", "Blocked"]);
    expect(failureRoutes()).toBe(0);
    expect(failedApproaches()).toBe(0);
    const reason = stored().blockedReason;
    expect(reason?.source).toBe("environment_unavailable");
    if (reason?.source !== "environment_unavailable") return;
    expect(reason.unavailable).toBe("verifier cell mount (/x/target)");
    expect(reason.reason).toContain("stage postMergeVerify (MountPathRejected)");
  });
});
