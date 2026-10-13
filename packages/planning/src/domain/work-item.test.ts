import { describe, test, expect } from "vitest";
import type { StoredBlockedReason, WorkItemStatus } from "@ashara/shared";
import {
  RUN_SCOPE_AD_HOC,
  parseProjectId,
  canTransitionTo,
  InvalidStatusTransition,
} from "@ashara/shared";
import {
  createPendingWorkItem,
  startWorkItem,
  completeWorkItem,
  completeRecordedMerge,
  failWorkItem,
  blockWorkItem,
  unblockWorkItem,
  replanWorkItem,
  abandonWorkItem,
  requeueWorkItem,
  takeEvents,
} from "./work-item.js";

const TEST_PROJECT_ID = parseProjectId("00000000-0000-4000-8000-000000000001");

// A Record keyed by the union: a status added to WorkItemStatus fails to
// compile here until it is listed, so no sweep below silently skips it.
const STATUS_BY_NAME: Record<WorkItemStatus, WorkItemStatus> = {
  Pending: "Pending",
  InProgress: "InProgress",
  Completed: "Completed",
  Blocked: "Blocked",
  Failed: "Failed",
  Abandoned: "Abandoned",
};
const ALL_STATUSES = Object.values(STATUS_BY_NAME);

// Test fixture: a valid StoredBlockedReason for use in domain method calls.
const FAIL_REASON: StoredBlockedReason = { source: "task_failed", reason: "task_failed" };
const BLOCK_REASON: StoredBlockedReason = { source: "api", reason: "waiting on dependency" };
const ABANDON_REASON: StoredBlockedReason = { source: "failure_router", reason: "unrecoverable" };
const OWNER_ABANDON_REASON: StoredBlockedReason = { source: "api", note: "abandoned via API" };

function seedFailed() {
  const item = createPendingWorkItem("Task", "leaf-task", "test-run", TEST_PROJECT_ID);
  startWorkItem(item);
  failWorkItem(item, FAIL_REASON);
  takeEvents(item);
  return item;
}

describe("canTransitionTo — Failed recovery transitions", () => {
  test("Failed -> Pending is legal (re-plan)", () => {
    expect(canTransitionTo("Failed", "Pending")).toBe(true);
  });

  test("Failed -> Abandoned is legal (terminal)", () => {
    expect(canTransitionTo("Failed", "Abandoned")).toBe(true);
  });

  test("Abandoned is terminal: no outgoing transition is legal", () => {
    for (const to of ALL_STATUSES) {
      expect(canTransitionTo("Abandoned", to)).toBe(false);
    }
  });

  test("InProgress -> Pending is legal (crash-orphan requeue)", () => {
    expect(canTransitionTo("InProgress", "Pending")).toBe(true);
  });

  test("Pending -> Abandoned is legal (owner abandon via API)", () => {
    expect(canTransitionTo("Pending", "Abandoned")).toBe(true);
  });

  test("InProgress -> Abandoned is legal (owner abandon via API)", () => {
    expect(canTransitionTo("InProgress", "Abandoned")).toBe(true);
  });

  test("the crash-orphan and terminalization edges do not loosen any other transition", () => {
    expect(canTransitionTo("InProgress", "Completed")).toBe(true);
    expect(canTransitionTo("InProgress", "Failed")).toBe(true);
    expect(canTransitionTo("InProgress", "Blocked")).toBe(true);
    // Completed -> Pending stays legal with no traverser; see transitions.ts
    expect(canTransitionTo("Completed", "Pending")).toBe(true);
    expect(canTransitionTo("Pending", "Completed")).toBe(false);
  });
});

describe("state-machine totality", () => {
  test("Abandoned is the only status with no exit", () => {
    const terminal = ALL_STATUSES.filter((from) => !ALL_STATUSES.some((to) => canTransitionTo(from, to)));
    expect(terminal).toEqual(["Abandoned"]);
  });

  test("every status is either terminal or reachable — no declared-but-unwritable state", () => {
    for (const status of ALL_STATUSES) {
      if (status === "Pending") continue; // the creation status; no inbound edge needed
      const inbound = ALL_STATUSES.filter((from) => canTransitionTo(from, status));
      expect(inbound.length, `${status} has no inbound transition`).toBeGreaterThan(0);
    }
  });

  test("Blocked can be given up on, not only unblocked", () => {
    expect(canTransitionTo("Blocked", "Pending")).toBe(true);
    expect(canTransitionTo("Blocked", "Abandoned")).toBe(true);
  });

  test("Blocked -> Completed is merge_unrecorded's alone; such an item never goes back to Pending", () => {
    const merged: StoredBlockedReason = { source: "merge_unrecorded", mergeCommit: "a".repeat(40), reason: "db down" };
    const item = createPendingWorkItem("Task", "merged-task", "test-run", TEST_PROJECT_ID);
    blockWorkItem(item, merged);
    takeEvents(item);
    expect(() => unblockWorkItem(item, { kind: "exit-cleared" })).toThrow(InvalidStatusTransition);
    expect(() => completeWorkItem(item)).toThrow(InvalidStatusTransition);
    completeRecordedMerge(item);
    expect(item.status).toBe("Completed");
    expect(item.blockedReason).toBeUndefined();
    expect(takeEvents(item).map((e) => e.eventType)).toEqual(["work_item.completed"]);

    const other = createPendingWorkItem("Task", "parked-task", "test-run", TEST_PROJECT_ID);
    blockWorkItem(other, BLOCK_REASON);
    expect(() => completeRecordedMerge(other)).toThrow(InvalidStatusTransition);
    expect(() => completeWorkItem(other)).toThrow(InvalidStatusTransition);
  });

  test("abandonWorkItem accepts a Blocked item (the owner-parked give-up path)", () => {
    const item = createPendingWorkItem("Task", "parked-task", "test-run", TEST_PROJECT_ID);
    blockWorkItem(item, BLOCK_REASON);
    takeEvents(item);
    abandonWorkItem(item, { source: "api", reason: "owner dropped it" });
    expect(item.status).toBe("Abandoned");
  });
});

describe("requeueWorkItem", () => {
  function seedInProgress() {
    const item = createPendingWorkItem("Task", "leaf-task", "test-run", TEST_PROJECT_ID);
    startWorkItem(item);
    takeEvents(item);
    return item;
  }

  test("moves a crash-orphaned InProgress item back to Pending and emits work_item.requeued", () => {
    const item = seedInProgress();

    requeueWorkItem(item);
    const events = takeEvents(item);

    expect(item.status).toBe("Pending");
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("work_item.requeued");
    expect(events[0]?.payload.work_item_id).toBe(item.id);
  });

  test("throws InvalidStatusTransition when the item is not InProgress", () => {
    const pending = createPendingWorkItem("Task", "leaf-task", "test-run", TEST_PROJECT_ID);
    expect(() => requeueWorkItem(pending)).toThrow(InvalidStatusTransition);

    const failed = seedFailed();
    // A Failed item is recovered via replanWorkItem, never requeued — requeue is
    // InProgress-only even though Failed->Pending is itself a legal edge.
    expect(() => requeueWorkItem(failed)).toThrow(InvalidStatusTransition);
  });
});

describe("method-level preconditions guard the shared -> Pending edge", () => {
  // Blocked, Failed and InProgress all share the graph edge `-> Pending`, but each
  // is owned by a distinct method. Each method must pin its own from-status so the
  // shared edge cannot be reached through the wrong intent (e.g. the HTTP unblock
  // path forcing a live-agent InProgress item back to Pending).
  function seedInProgress() {
    const item = createPendingWorkItem("Task", "leaf-task", "test-run", TEST_PROJECT_ID);
    startWorkItem(item);
    takeEvents(item);
    return item;
  }

  function seedBlocked() {
    const item = createPendingWorkItem("Task", "leaf-task", "test-run", TEST_PROJECT_ID);
    blockWorkItem(item, BLOCK_REASON);
    takeEvents(item);
    return item;
  }

  test("unblockWorkItem accepts only a Blocked item", () => {
    const blocked = seedBlocked();
    unblockWorkItem(blocked, { kind: "exit-cleared" });
    expect(blocked.status).toBe("Pending");
    expect(blocked.blockedReason).toBeUndefined();
  });

  test("an operator's unblock records who, their note and the block it cleared, on the item and its event (third run N11)", () => {
    const item = createPendingWorkItem("Task", "refused-task", "test-run", TEST_PROJECT_ID);
    const refused: StoredBlockedReason = { source: "environment_change_needed", paths: ["main.go"], reason: "main.go is the environment's" };
    blockWorkItem(item, refused);
    takeEvents(item);

    unblockWorkItem(item, { kind: "operator", by: "operator-a", note: "moved main.go out of the environment's owned set" });

    expect(item.status).toBe("Pending");
    expect(item.blockedReason).toMatchObject({
      source: "operator_unblock",
      unblockedBy: "operator-a",
      note: "moved main.go out of the environment's owned set",
      previous: refused,
    });
    const [event] = takeEvents(item);
    expect(event?.eventType).toBe("work_item.unblocked");
    expect(event?.payload).toMatchObject({ unblocked_by: "operator-a", note: "moved main.go out of the environment's owned set", previous_blocked_reason: refused });
  });

  test("unblockWorkItem throws on an InProgress item (the transition-widening leak)", () => {
    expect(() => unblockWorkItem(seedInProgress(), { kind: "exit-cleared" })).toThrow(InvalidStatusTransition);
  });

  test("replanWorkItem throws on an InProgress item (retry intent, not a requeue)", () => {
    expect(() => replanWorkItem(seedInProgress())).toThrow(InvalidStatusTransition);
  });

  test("replanWorkItem throws on a Blocked item", () => {
    expect(() => replanWorkItem(seedBlocked())).toThrow(InvalidStatusTransition);
  });

  test("requeueWorkItem throws on a Blocked item (requeue is InProgress-only)", () => {
    expect(() => requeueWorkItem(seedBlocked())).toThrow(InvalidStatusTransition);
  });
});

describe("replanWorkItem", () => {
  test("moves a Failed item back to Pending, clears the failure reason, and emits work_item.replanned", () => {
    const item = seedFailed();

    replanWorkItem(item);
    const events = takeEvents(item);

    expect(item.status).toBe("Pending");
    expect(item.blockedReason).toBeUndefined();
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("work_item.replanned");
    expect(events[0]?.payload.work_item_id).toBe(item.id);
  });

  test("throws InvalidStatusTransition when the item is not Failed", () => {
    const item = createPendingWorkItem("Task", "leaf-task", "test-run", TEST_PROJECT_ID);

    expect(() => replanWorkItem(item)).toThrow(InvalidStatusTransition);
  });
});

describe("abandonWorkItem", () => {
  test("moves a Failed item to the terminal Abandoned status and emits work_item.abandoned", () => {
    const item = seedFailed();

    abandonWorkItem(item, ABANDON_REASON);
    const events = takeEvents(item);

    expect(item.status).toBe("Abandoned");
    expect(item.blockedReason).toEqual(ABANDON_REASON);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("work_item.abandoned");
    expect(events[0]?.payload.work_item_id).toBe(item.id);
  });

  test("moves a Pending item directly to Abandoned (owner abandon via API)", () => {
    const item = createPendingWorkItem("Task", "leaf-task", "test-run", TEST_PROJECT_ID);

    abandonWorkItem(item, OWNER_ABANDON_REASON);
    const events = takeEvents(item);

    expect(item.status).toBe("Abandoned");
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("work_item.abandoned");
  });

  test("moves an InProgress item directly to Abandoned (owner abandon via API)", () => {
    const item = createPendingWorkItem("Task", "leaf-task", "test-run", TEST_PROJECT_ID);
    startWorkItem(item);
    takeEvents(item);

    abandonWorkItem(item, OWNER_ABANDON_REASON);
    const events = takeEvents(item);

    expect(item.status).toBe("Abandoned");
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("work_item.abandoned");
  });

  test("throws InvalidStatusTransition from a terminal status", () => {
    const item = createPendingWorkItem("Task", "leaf-task", "test-run", TEST_PROJECT_ID);
    startWorkItem(item);
    failWorkItem(item, FAIL_REASON);
    abandonWorkItem(item, ABANDON_REASON);
    takeEvents(item);

    expect(() => abandonWorkItem(item, ABANDON_REASON)).toThrow(
      InvalidStatusTransition,
    );
  });

  test("Abandoned cannot be replanned — abandon is terminal", () => {
    const item = seedFailed();
    abandonWorkItem(item, ABANDON_REASON);
    takeEvents(item);

    expect(() => replanWorkItem(item)).toThrow(InvalidStatusTransition);
  });
});

describe("Completed re-entry", () => {
  test("canTransitionTo('Completed', 'Pending') returns true", () => {
    expect(canTransitionTo("Completed", "Pending")).toBe(true);
  });
});

describe("createPendingWorkItem stamps the caller-supplied runScope", () => {
  // This test would FAIL against the pre-fix code: before the fix,
  // createPendingWorkItem did not accept a runScope parameter, and WorkItem
  // did not carry one. The Drizzle $defaultFn silently wrote "pre-scoping"
  // for every row, making the column uniformly meaningless.
  test("the returned WorkItem carries the exact runScope the caller passed", () => {
    const runId = "550e8400-e29b-41d4-a716-446655440000";
    const item = createPendingWorkItem("Task", "test-task", runId, TEST_PROJECT_ID);
    expect(item.runScope).toBe(runId);
  });

  test("ad-hoc scope is preserved, not collapsed to pre-scoping", () => {
    const item = createPendingWorkItem("Task", "api-created", RUN_SCOPE_AD_HOC, TEST_PROJECT_ID);
    expect(item.runScope).toBe(RUN_SCOPE_AD_HOC);
  });
});
