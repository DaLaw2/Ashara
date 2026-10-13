import {
  type ProjectId,
  type WorkItemId,
  type WorkItemLevel,
  type WorkItemStatus,
  type DomainEvent,
  type StoredTaskSpec,
  type StoredBlockedReason,
  type StoredSuccessCriteria,
  type WorkKind,
  createWorkItemId,
  createDomainEvent,
  canTransitionTo,
  InvalidStatusTransition,
} from "@ashara/shared";

export interface WorkItem {
  id: WorkItemId;
  level: WorkItemLevel;
  status: WorkItemStatus;
  parentId?: WorkItemId;
  title: string;
  description?: string;
  taskSpec?: StoredTaskSpec;
  northStar?: string;
  successCriteria?: StoredSuccessCriteria;
  blockedReason?: StoredBlockedReason;
  /**
   * Which run created this item: either a runId (a run's UUID),
   * "pre-scoping" (migration backfill), or RUN_SCOPE_AD_HOC
   * (created without a run id, today a project's first plan). Every insert site
   * must supply this explicitly — there is no default (Discipline A).
   */
  runScope: string;
  /** The project (projects.id) this item belongs to. Required: no item exists outside a project. */
  projectId: ProjectId;
  /**
   * Number of times this item has been dispatched for execution (migration 018,
   * r9f-t1). Incremented UNCONDITIONALLY at the dispatch seam (CoreLoop.processTask)
   * so it counts real dispatches even when the agent crashes or its output is lost.
   * The FailureRouter reads this as the retry-bound signal — decoupled from billing.
   */
  dispatchCount: number;
  /**
   * The kind of work a Task is (migration 031), set with its owner when the plan is
   * written. null on an Epic and on a task planned before owners were assigned.
   */
  workKind: WorkKind | null;
  createdAt: Date;
  updatedAt: Date;
  events: DomainEvent[];
}

export function createPendingWorkItem(
  level: WorkItemLevel,
  title: string,
  runScope: string,
  projectId: ProjectId,
  parentId?: WorkItemId,
  description?: string,
  taskSpec?: StoredTaskSpec,
  northStar?: string,
  successCriteria?: StoredSuccessCriteria,
): WorkItem {
  const now = new Date();
  return {
    id: createWorkItemId(),
    level,
    status: "Pending",
    parentId,
    title,
    description,
    taskSpec,
    northStar,
    successCriteria,
    runScope,
    projectId,
    dispatchCount: 0,
    workKind: null,
    createdAt: now,
    updatedAt: now,
    events: [],
  };
}

export function startWorkItem(item: WorkItem): void {
  if (!canTransitionTo(item.status, "InProgress")) {
    throw new InvalidStatusTransition(item.id, item.status, "InProgress");
  }
  item.status = "InProgress";
  item.updatedAt = new Date();
  item.events.push(
    createDomainEvent("work_item.started", "planning", {
      work_item_id: item.id,
      level: item.level,
    }),
  );
}

export function completeWorkItem(item: WorkItem): void {
  if (!canTransitionTo(item.status, "Completed")) {
    throw new InvalidStatusTransition(item.id, item.status, "Completed");
  }
  item.status = "Completed";
  item.updatedAt = new Date();
  item.events.push(
    createDomainEvent("work_item.completed", "planning", {
      work_item_id: item.id,
      level: item.level,
    }),
  );
}

export function failWorkItem(item: WorkItem, reason: StoredBlockedReason): void {
  if (!canTransitionTo(item.status, "Failed")) {
    throw new InvalidStatusTransition(item.id, item.status, "Failed");
  }
  item.status = "Failed";
  item.blockedReason = reason;
  item.updatedAt = new Date();
  item.events.push(
    createDomainEvent("work_item.failed", "planning", {
      work_item_id: item.id,
      level: item.level,
    }),
  );
}

export function blockWorkItem(item: WorkItem, reason: StoredBlockedReason): void {
  if (!canTransitionTo(item.status, "Blocked")) {
    throw new InvalidStatusTransition(item.id, item.status, "Blocked");
  }
  item.status = "Blocked";
  item.blockedReason = reason;
  item.updatedAt = new Date();
  item.events.push(
    createDomainEvent("work_item.blocked", "planning", {
      work_item_id: item.id,
      level: item.level,
    }),
  );
}

/**
 * Returns an externally-Blocked item to Pending (the HTTP unblock path). Pins its
 * from-status to `Blocked` EXPLICITLY: several statuses now share the `-> Pending`
 * graph edge (Blocked, Failed, InProgress), but each is owned by a distinct method
 * with its own domain event and intent. canTransitionTo is only the edge-level
 * guard (enforced again at save()); the method adds the method-level invariant so a
 * caller cannot, say, drive an InProgress item (with a live agent) back to Pending
 * through unblock. See "Aggregates own their invariants" (CLAUDE.md DDD).
 */
export function unblockWorkItem(item: WorkItem): void {
  if (item.status !== "Blocked" || !canTransitionTo(item.status, "Pending")) {
    throw new InvalidStatusTransition(item.id, item.status, "Pending");
  }
  item.status = "Pending";
  item.blockedReason = undefined;
  item.updatedAt = new Date();
  item.events.push(
    createDomainEvent("work_item.unblocked", "planning", {
      work_item_id: item.id,
      level: item.level,
    }),
  );
}

/**
 * Recovers a Failed item back to Pending so it re-enters planning (FailureRouter's
 * "replan" decision, ADR-029). Clears the prior failure reason — a fresh attempt
 * starts without a stale blockedReason lingering on the row. Pins its from-status to
 * `Failed` EXPLICITLY (the `-> Pending` edge is shared with Blocked/InProgress, each
 * owned by its own method): replan is a retry decision, distinct from an unblock or
 * a crash-orphan requeue, so it must never accept a Blocked or InProgress item.
 */
export function replanWorkItem(item: WorkItem): void {
  if (item.status !== "Failed" || !canTransitionTo(item.status, "Pending")) {
    throw new InvalidStatusTransition(item.id, item.status, "Pending");
  }
  item.status = "Pending";
  item.blockedReason = undefined;
  item.updatedAt = new Date();
  item.events.push(
    createDomainEvent("work_item.replanned", "planning", {
      work_item_id: item.id,
      level: item.level,
    }),
  );
}

/**
 * Moves an item to the terminal Abandoned status. Which statuses may reach
 * Abandoned is governed solely by `canTransitionTo` and the transition table
 * in `@ashara/shared/transitions.ts` — this function delegates to it and
 * adds no further guard. Callers include the FailureRouter (Failed →
 * Abandoned, ADR-029) and the HTTP PATCH /work-items/:id/status route, which
 * is the only caller that takes Blocked, Pending or InProgress to Abandoned.
 */
export function abandonWorkItem(item: WorkItem, reason: StoredBlockedReason): void {
  if (!canTransitionTo(item.status, "Abandoned")) {
    throw new InvalidStatusTransition(item.id, item.status, "Abandoned");
  }
  item.status = "Abandoned";
  item.blockedReason = reason;
  item.updatedAt = new Date();
  item.events.push(
    createDomainEvent("work_item.abandoned", "planning", {
      work_item_id: item.id,
      level: item.level,
    }),
  );
}

/**
 * Requeues a crash-orphaned InProgress item back to Pending (Discipline B startup
 * reconciliation). A freshly started process owns no in-flight agent, so any item
 * a previous crash left InProgress can never make progress on its own — the gate
 * selects only Pending items — and would strand forever. This is a liveness reset,
 * NOT a retry decision: it is deliberately distinct from replanWorkItem (Failed ->
 * Pending) and emits its own `work_item.requeued` event so the audit trail shows a
 * reconciler requeue rather than a planning replan. The dispatch path takes the same
 * transition when a spend cap refused the attempt's model call: that is no failed
 * approach either, so the item waits at Pending rather than going through Failed.
 * Guarded to InProgress-only so a
 * Failed/Blocked item cannot be requeued through this path (those have their own
 * transitions: replanWorkItem / unblockWorkItem).
 */
export function requeueWorkItem(item: WorkItem): void {
  if (item.status !== "InProgress" || !canTransitionTo(item.status, "Pending")) {
    throw new InvalidStatusTransition(item.id, item.status, "Pending");
  }
  item.status = "Pending";
  item.updatedAt = new Date();
  item.events.push(
    createDomainEvent("work_item.requeued", "planning", {
      work_item_id: item.id,
      level: item.level,
    }),
  );
}

export function takeEvents(item: WorkItem): DomainEvent[] {
  const events = item.events;
  item.events = [];
  return events;
}
