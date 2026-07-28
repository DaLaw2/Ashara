import { describe, test, expect } from "vitest";
import { TERMINAL_STATUSES, WORK_ITEM_STATUSES, RUN_SCOPE_AD_HOC, RUN_SCOPE_PRE_SCOPING } from "@ashara/shared";
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

// Read from the Published Language, not re-listed here: a status added to the
// union is automatically covered by every sweep below instead of silently
// escaping a stale local copy.
const ALL_STATUSES = WORK_ITEM_STATUSES;

function seedFailed() {
  const item = createPendingWorkItem("Task", "leaf-task", "test-run");
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

  test("Pending -> Abandoned is legal (run-end terminalization)", () => {
    expect(canTransitionTo("Pending", "Abandoned")).toBe(true);
  });

  test("InProgress -> Abandoned is legal (run-end terminalization)", () => {
    expect(canTransitionTo("InProgress", "Abandoned")).toBe(true);
  });

  test("the crash-orphan and terminalization edges do not loosen any other transition", () => {
    expect(canTransitionTo("InProgress", "Completed")).toBe(true);
    expect(canTransitionTo("InProgress", "Failed")).toBe(true);
    expect(canTransitionTo("InProgress", "Blocked")).toBe(true);
    expect(canTransitionTo("Completed", "Pending")).toBe(false);
    expect(canTransitionTo("Pending", "Completed")).toBe(false);
  });
});

describe("state-machine totality", () => {
  test("every non-terminal status has at least one exit", () => {
    for (const from of ALL_STATUSES) {
      if (TERMINAL_STATUSES.has(from)) continue;
      const exits = ALL_STATUSES.filter((to) => canTransitionTo(from, to));
      expect(exits.length, `${from} has no outbound transition`).toBeGreaterThan(0);
    }
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

  test("abandonWorkItem accepts a Blocked item (the owner-parked give-up path)", () => {
    const item = createPendingWorkItem("Task", "parked-task", "test-run");
    blockWorkItem(item, { reason: "waiting on owner" });
    takeEvents(item);
    abandonWorkItem(item, { reason: "owner dropped it", source: "api" });
    expect(item.status).toBe("Abandoned");
  });
});

describe("requeueWorkItem", () => {
  function seedInProgress() {
    const item = createPendingWorkItem("Task", "leaf-task", "test-run");
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
    const pending = createPendingWorkItem("Task", "leaf-task", "test-run");
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
    const item = createPendingWorkItem("Task", "leaf-task", "test-run");
    startWorkItem(item);
    takeEvents(item);
    return item;
  }

  function seedBlocked() {
    const item = createPendingWorkItem("Task", "leaf-task", "test-run");
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
    const item = createPendingWorkItem("Task", "leaf-task", "test-run");

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

  test("moves a Pending item directly to Abandoned (run-end terminalization)", () => {
    const item = createPendingWorkItem("Task", "leaf-task", "test-run");

    abandonWorkItem(item, { reason: "run terminated", source: "shutdown-reconciler" });
    const events = takeEvents(item);

    expect(item.status).toBe("Abandoned");
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("work_item.abandoned");
  });

  test("moves an InProgress item directly to Abandoned (run-end terminalization)", () => {
    const item = createPendingWorkItem("Task", "leaf-task", "test-run");
    startWorkItem(item);
    takeEvents(item);

    abandonWorkItem(item, { reason: "run terminated", source: "shutdown-reconciler" });
    const events = takeEvents(item);

    expect(item.status).toBe("Abandoned");
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("work_item.abandoned");
  });

  test("throws InvalidStatusTransition from a terminal status", () => {
    const item = createPendingWorkItem("Task", "leaf-task", "test-run");
    startWorkItem(item);
    failWorkItem(item, { reason: "failed" });
    abandonWorkItem(item, { reason: "give up" });
    takeEvents(item);

    expect(() => abandonWorkItem(item, { reason: "double abandon" })).toThrow(
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

describe("createPendingWorkItem stamps the caller-supplied runScope", () => {
  // This test would FAIL against the pre-fix code: before the fix,
  // createPendingWorkItem did not accept a runScope parameter, and WorkItem
  // did not carry one. The Drizzle $defaultFn silently wrote "pre-scoping"
  // for every row, making the column uniformly meaningless.
  test("the returned WorkItem carries the exact runScope the caller passed", () => {
    const runId = "550e8400-e29b-41d4-a716-446655440000";
    const item = createPendingWorkItem("Task", "test-task", runId);
    expect(item.runScope).toBe(runId);
  });

  test("ad-hoc scope is preserved, not collapsed to pre-scoping", () => {
    const item = createPendingWorkItem("Task", "api-created", RUN_SCOPE_AD_HOC);
    expect(item.runScope).toBe(RUN_SCOPE_AD_HOC);
    expect(item.runScope).not.toBe(RUN_SCOPE_PRE_SCOPING);
  });
});
