import { describe, test, expect } from "vitest";
import { parseProjectId } from "@ashara/shared";
import type { StoredBlockedReason } from "../work-item-language/blocked-reason.js";
import type { WorkItemStatus } from "../work-item-language/work-item-status.js";
import { canTransitionTo, InvalidStatusTransition } from "../work-item-language/transitions.js";
import { WORK_FAILED } from "../acl/quality-acl.js";
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
  giveUpWorkItem,
  takeEvents,
} from "./work-item.js";

const TEST_PROJECT_ID = parseProjectId("00000000-0000-4000-8000-000000000001", "test");

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
const ABANDON_REASON: StoredBlockedReason = { source: "failure_given_up", reason: "unrecoverable" };
const OWNER_ABANDON_REASON: StoredBlockedReason = { source: "api", note: "abandoned via API" };

function seedFailed() {
  const item = createPendingWorkItem("Task", "leaf-task", TEST_PROJECT_ID);
  startWorkItem(item);
  failWorkItem(item, FAIL_REASON, WORK_FAILED);
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
    const item = createPendingWorkItem("Task", "merged-task", TEST_PROJECT_ID);
    blockWorkItem(item, merged);
    takeEvents(item);
    expect(() => unblockWorkItem(item)).toThrow(InvalidStatusTransition);
    expect(() => completeWorkItem(item)).toThrow(InvalidStatusTransition);
    completeRecordedMerge(item);
    expect(item.status).toBe("Completed");
    expect(item.blockedReason).toBeUndefined();
    expect(takeEvents(item).map((e) => e.eventType)).toEqual(["work_item.completed"]);

    const other = createPendingWorkItem("Task", "parked-task", TEST_PROJECT_ID);
    blockWorkItem(other, BLOCK_REASON);
    expect(() => completeRecordedMerge(other)).toThrow(InvalidStatusTransition);
    expect(() => completeWorkItem(other)).toThrow(InvalidStatusTransition);
  });

  test("abandonWorkItem accepts a Blocked item (the owner-parked give-up path)", () => {
    const item = createPendingWorkItem("Task", "parked-task", TEST_PROJECT_ID);
    blockWorkItem(item, BLOCK_REASON);
    takeEvents(item);
    abandonWorkItem(item, { source: "api", reason: "owner dropped it" });
    expect(item.status).toBe("Abandoned");
  });
});

describe("requeueWorkItem", () => {
  function seedInProgress() {
    const item = createPendingWorkItem("Task", "leaf-task", TEST_PROJECT_ID);
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
    const pending = createPendingWorkItem("Task", "leaf-task", TEST_PROJECT_ID);
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
    const item = createPendingWorkItem("Task", "leaf-task", TEST_PROJECT_ID);
    startWorkItem(item);
    takeEvents(item);
    return item;
  }

  function seedBlocked() {
    const item = createPendingWorkItem("Task", "leaf-task", TEST_PROJECT_ID);
    blockWorkItem(item, BLOCK_REASON);
    takeEvents(item);
    return item;
  }

  test("unblockWorkItem accepts only a Blocked item, clears its reason and names the cleared block on its event", () => {
    const blocked = seedBlocked();
    unblockWorkItem(blocked);
    expect(blocked.status).toBe("Pending");
    expect(blocked.blockedReason).toBeUndefined();
    const [event] = takeEvents(blocked);
    expect(event?.eventType).toBe("work_item.unblocked");
    expect(event?.payload).toMatchObject({ unblocked_by: "automatic exit", previous_blocked_reason: BLOCK_REASON });
  });

  test("unblockWorkItem throws on an InProgress item (the transition-widening leak)", () => {
    expect(() => unblockWorkItem(seedInProgress())).toThrow(InvalidStatusTransition);
  });

  test("replanWorkItem throws on an InProgress item (retry intent, not a requeue)", () => {
    expect(() => replanWorkItem(seedInProgress(), null)).toThrow(InvalidStatusTransition);
  });

  test("replanWorkItem throws on a Blocked item", () => {
    expect(() => replanWorkItem(seedBlocked(), null)).toThrow(InvalidStatusTransition);
  });

  test("requeueWorkItem throws on a Blocked item (requeue is InProgress-only)", () => {
    expect(() => requeueWorkItem(seedBlocked())).toThrow(InvalidStatusTransition);
  });
});

describe("replanWorkItem", () => {
  test("moves a Failed item back to Pending, clears the failure reason, and emits work_item.replanned", () => {
    const item = seedFailed();

    replanWorkItem(item, null);
    const events = takeEvents(item);

    expect(item.status).toBe("Pending");
    expect(item.blockedReason).toBeUndefined();
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("work_item.replanned");
    expect(events[0]?.payload.work_item_id).toBe(item.id);
  });

  test("a replan with the failure's context records it as the item's reason, for its next attempt", () => {
    const item = seedFailed();

    replanWorkItem(item, { attempt: 2, detail: "tests failed", raw: { exit: 1 } });

    expect(item.status).toBe("Pending");
    expect(item.blockedReason).toEqual({ source: "replan", replanContext: { attempt: 2, detail: "tests failed", raw: { exit: 1 } } });
  });

  test("throws InvalidStatusTransition when the item is not Failed", () => {
    const item = createPendingWorkItem("Task", "leaf-task", TEST_PROJECT_ID);

    expect(() => replanWorkItem(item, null)).toThrow(InvalidStatusTransition);
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
    const item = createPendingWorkItem("Task", "leaf-task", TEST_PROJECT_ID);

    abandonWorkItem(item, OWNER_ABANDON_REASON);
    const events = takeEvents(item);

    expect(item.status).toBe("Abandoned");
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("work_item.abandoned");
  });

  test("moves an InProgress item directly to Abandoned (owner abandon via API)", () => {
    const item = createPendingWorkItem("Task", "leaf-task", TEST_PROJECT_ID);
    startWorkItem(item);
    takeEvents(item);

    abandonWorkItem(item, OWNER_ABANDON_REASON);
    const events = takeEvents(item);

    expect(item.status).toBe("Abandoned");
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("work_item.abandoned");
  });

  test("throws InvalidStatusTransition from a terminal status", () => {
    const item = createPendingWorkItem("Task", "leaf-task", TEST_PROJECT_ID);
    startWorkItem(item);
    failWorkItem(item, FAIL_REASON, WORK_FAILED);
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

    expect(() => replanWorkItem(item, null)).toThrow(InvalidStatusTransition);
  });
});

describe("Completed re-entry", () => {
  test("canTransitionTo('Completed', 'Pending') returns true", () => {
    expect(canTransitionTo("Completed", "Pending")).toBe(true);
  });
});

// A give-up is the one way a work item leaves without a person.
describe("giveUpWorkItem", () => {
  const CAUSE: StoredBlockedReason = { source: "check_disputed", checkTaskId: "c1", checkName: "put", reason: "past the bound" };

  function inStatus(status: "Pending" | "InProgress" | "Blocked" | "Failed") {
    const item = createPendingWorkItem("Task", "leaf-task", TEST_PROJECT_ID);
    if (status === "InProgress" || status === "Failed") startWorkItem(item);
    if (status === "Failed") failWorkItem(item, FAIL_REASON, WORK_FAILED);
    if (status === "Blocked") blockWorkItem(item, BLOCK_REASON);
    takeEvents(item);
    return item;
  }

  test.each(["Pending", "InProgress", "Blocked"] as const)("gives up a %s item with its cause and a work_item.given_up event", (status) => {
    const item = inStatus(status);
    giveUpWorkItem(item, CAUSE);
    expect(item.status).toBe("Abandoned");
    expect(item.blockedReason).toEqual(CAUSE);
    const [event] = takeEvents(item);
    expect(event?.eventType).toBe("work_item.given_up");
    expect(event?.payload).toMatchObject({ work_item_id: item.id, cause: "check_disputed" });
  });

  test("refuses a Failed item, the FailureRouter's to abandon", () => {
    expect(() => giveUpWorkItem(inStatus("Failed"), CAUSE)).toThrow(InvalidStatusTransition);
  });
});
