import { describe, test, expect } from "vitest";
import type { WorkItemStatus } from "@ashara/shared";

import {
  createPendingWorkItem,
  canTransitionTo,
  startWorkItem,
  failWorkItem,
  blockWorkItem,
  unblockWorkItem,
  replanWorkItem,
  abandonWorkItem,
  requeueWorkItem,
  takeEvents,
} from "./work-item.js";
import { InvalidStatusTransition } from "./errors.js";

const ALL_STATUSES: readonly WorkItemStatus[] = [
  "Pending",
  "InProgress",
  "Completed",
  "Blocked",
  "Failed",
  "Archived",
  "Abandoned",
];

function seedFailed() {
  const item = createPendingWorkItem("Task", "leaf-task");
  startWorkItem(item);
  failWorkItem(item, { reason: "task_failed" });
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

  test("the crash-orphan edge does not loosen any other transition", () => {
    // Only InProgress->Pending is newly legal; the rest of the InProgress row and
    // the terminal statuses are unchanged. (Abandoned->Pending is covered by the
    // "Abandoned is terminal" test above.)
    expect(canTransitionTo("InProgress", "Completed")).toBe(true);
    expect(canTransitionTo("InProgress", "Failed")).toBe(true);
    expect(canTransitionTo("InProgress", "Blocked")).toBe(true);
    expect(canTransitionTo("Completed", "Pending")).toBe(false);
    expect(canTransitionTo("Pending", "Completed")).toBe(false);
  });
});

describe("requeueWorkItem", () => {
  function seedInProgress() {
    const item = createPendingWorkItem("Task", "leaf-task");
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
    const pending = createPendingWorkItem("Task", "leaf-task");
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
    const item = createPendingWorkItem("Task", "leaf-task");
    startWorkItem(item);
    takeEvents(item);
    return item;
  }

  function seedBlocked() {
    const item = createPendingWorkItem("Task", "leaf-task");
    blockWorkItem(item, { reason: "waiting on dependency" });
    takeEvents(item);
    return item;
  }

  test("unblockWorkItem accepts only a Blocked item", () => {
    const blocked = seedBlocked();
    unblockWorkItem(blocked);
    expect(blocked.status).toBe("Pending");
  });

  test("unblockWorkItem throws on an InProgress item (the transition-widening leak)", () => {
    expect(() => unblockWorkItem(seedInProgress())).toThrow(InvalidStatusTransition);
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
    const item = createPendingWorkItem("Task", "leaf-task");

    expect(() => replanWorkItem(item)).toThrow(InvalidStatusTransition);
  });
});

describe("abandonWorkItem", () => {
  test("moves a Failed item to the terminal Abandoned status and emits work_item.abandoned", () => {
    const item = seedFailed();

    abandonWorkItem(item, { reason: "unrecoverable" });
    const events = takeEvents(item);

    expect(item.status).toBe("Abandoned");
    expect(item.blockedReason).toEqual({ reason: "unrecoverable" });
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("work_item.abandoned");
    expect(events[0]?.payload.work_item_id).toBe(item.id);
  });

  test("throws InvalidStatusTransition when the item is not Failed", () => {
    const item = createPendingWorkItem("Task", "leaf-task");

    expect(() => abandonWorkItem(item, { reason: "unrecoverable" })).toThrow(
      InvalidStatusTransition,
    );
  });

  test("Abandoned cannot be replanned — abandon is terminal", () => {
    const item = seedFailed();
    abandonWorkItem(item, { reason: "unrecoverable" });
    takeEvents(item);

    expect(() => replanWorkItem(item)).toThrow(InvalidStatusTransition);
  });
});
