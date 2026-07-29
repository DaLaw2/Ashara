import { describe, expect, test, vi, afterEach } from "vitest";
import type { StoredBlockedReason, WorkItemId } from "@ashara/shared";
import { createWorkItemId } from "@ashara/shared";
import { createPendingWorkItem, startWorkItem, takeEvents } from "./acl/planning-acl.js";
import type { WorkItem, WorkItemRepository } from "./acl/planning-acl.js";
import { DEFAULT_CONFIG } from "./types.js";
import type { CoreLoopDeps } from "./types.js";
import { processTask } from "./execution.js";

const RUN_SCOPE = "run-test-preemption";
// Stable ID shared by every item copy the mock repo returns, so the domain
// service, lifecycle router, and processTask itself all operate on what looks
// like the same row.
const ITEM_ID: WorkItemId = createWorkItemId();

function freshPendingItem(): WorkItem {
  const item = createPendingWorkItem("Task", "test-preempted-task", RUN_SCOPE);
  item.id = ITEM_ID;
  return item;
}

function freshAbandonedItem(): WorkItem {
  const item = freshPendingItem();
  startWorkItem(item);
  item.status = "Abandoned";
  item.blockedReason = { source: "api", reason: "cancelled by operator" } satisfies StoredBlockedReason;
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
function buildPreemptionDeps(): {
  deps: CoreLoopDeps;
  warns: string[];
} {
  const warns: string[] = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warns.push(args.map(String).join(" "));
  });

  let findByIdCalls = 0;
  const workItemRepo: WorkItemRepository = {
    findById: async (_id: WorkItemId) => {
      findByIdCalls++;
      if (findByIdCalls === 1) return freshPendingItem();
      return freshAbandonedItem();
    },
    save: async () => {},
    create: notExercised("create"),
    findByStatus: notExercised("findByStatus"),
    incrementDispatchCount: async () => 1,
    listAll: notExercised("listAll"),
    addDependency: notExercised("addDependency"),
    getDependencies: async () => [],
    findChildren: async () => [],
    findDuplicate: async () => null,
    listAllDependencies: notExercised("listAllDependencies"),
    withTransaction: notExercised("withTransaction"),
  };

  // Plain objects that satisfy only the methods processTask exercises.
  // Repository classes have private `db` fields that prevent structural
  // mocking without instantiation; the `unknown` widening below is the
  // standard test workaround for class-typed dependency slots.
  const eventStore = { publish: async () => {} };
  const visionRepo = {
    getLatest: async () => null,
    getProjectPath: async () => null,
    setProjectPath: async () => {},
  };
  const failedApproachRepo = { record: async () => {} };
  const runStateStore = { load: async () => null, save: async () => {} };
  const developmentService = {
    execute: async () => ({
      status: "failed" as const,
      detail: "agent hit turn limit",
      output: null,
      sessionId: "test-session",
      filesChanged: [] as string[],
      attempt: 1,
      agentInvoked: false,
    }),
  };

  const deps = {
    config: { ...DEFAULT_CONFIG, workdirBase: "/tmp/test-workdir" },
    workItemRepo,
    eventStore,
    costRepo: { recordTaskCost: async () => {} },
    brainstormLogRepo: {},
    failedApproachRepo,
    contextBriefRepo: {},
    visionRepo,
    developmentService,
    acceptanceAttempts: 0,
    replanRounds: 0,
    runStateStore,
  } as unknown as CoreLoopDeps;

  return { deps, warns };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("processTask post-agent status ladder", () => {
  test("preempted item (Abandoned during execution) logs a warning and does not throw", async () => {
    const { deps, warns } = buildPreemptionDeps();
    const task = freshPendingItem();

    const { result, costInfo } = await processTask(deps, task, RUN_SCOPE);

    // The function must return the agent's result, not throw
    expect(result.status).toBe("failed");
    expect(costInfo.costUsd).toBe(0);

    // The preemption must produce an observable warning (Discipline C)
    const preemptionWarn = warns.find((w) => w.includes("preempted"));
    expect(preemptionWarn).toBeDefined();
    expect(preemptionWarn).toContain(ITEM_ID);
    expect(preemptionWarn).toContain("Abandoned");
    expect(preemptionWarn).toContain("dispatchCount already incremented");
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
    const { result } = await processTask(deps, task, RUN_SCOPE);

    expect(result.status).toBe("failed");

    const vanishedWarn = warns.find((w) => w.includes("vanished"));
    expect(vanishedWarn).toBeDefined();
    expect(vanishedWarn).toContain(ITEM_ID);
    expect(vanishedWarn).toContain("agent spend unrecoverable");
  });
});
