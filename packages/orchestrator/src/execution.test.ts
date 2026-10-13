import { describe, expect, test, vi, afterEach } from "vitest";
import type { StoredBlockedReason, WorkItemId } from "@ashara/shared";
import { createWorkItemId, parseProjectId, parseStoredBlockedReason } from "@ashara/shared";
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
    findByStatus: notExercised("findByStatus"),
    incrementDispatchCount: async () => 1,
    listAll: notExercised("listAll"),
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
  const visionRepo = {
    getCurrent: async () => null,
    getProjectPath: async () => null,
    setProjectPath: async () => {},
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
    visionRepo,
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
    expect(() => parseStoredBlockedReason(lastSaved)).not.toThrow();

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
