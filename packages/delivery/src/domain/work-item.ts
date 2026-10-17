import { type ProjectId, type WorkItemId, type DomainEvent, createWorkItemId, createDomainEvent } from "@ashara/shared";
import type { WorkItemLevel, WorkItemStatus } from "../work-item-language/work-item-status.js";
import type { StoredTaskSpec } from "../work-item-language/task-spec.js";
import { type StoredBlockedReason, blockedReasonToRecord } from "../work-item-language/blocked-reason.js";
import type { StoredSuccessCriteria } from "../work-item-language/success-criteria.js";
import type { WorkKind } from "../acl/organization-acl.js";
import { canTransitionTo, InvalidStatusTransition } from "../work-item-language/transitions.js";
import type { FailureVerdict } from "../acl/quality-acl.js";

/**
 * Quality's verdict on a Failed item's last attempt as its row holds it, read only
 * while the item is Failed. `none`: no verdict is stored, which on a Failed row means it failed
 * before verdicts were stored. `unreadable`: the stored value does not parse; it is never read as either
 * verdict.
 */
export type StoredFailureVerdict =
  | { readonly kind: "recorded"; readonly verdict: FailureVerdict }
  | { readonly kind: "none" }
  | { readonly kind: "unreadable"; readonly detail: string };

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
  /** Quality's verdict on the last attempt, stored with the Failed transition. */
  failureVerdict: StoredFailureVerdict;
  /** The project (projects.id) this item belongs to. Required: no item exists outside a project. */
  projectId: ProjectId;
  /**
   * Number of times this item has been dispatched for execution.
   * Incremented UNCONDITIONALLY at the dispatch seam (CoreLoop.processTask)
   * so it counts real dispatches even when the agent crashes or its output is lost.
   * The FailureRouter reads this as the retry-bound signal — decoupled from billing.
   */
  dispatchCount: number;
  /**
   * The kind of work a Task is, set with its owner when the plan is
   * written. null on an Epic and on a task planned before owners were assigned.
   */
  workKind: WorkKind | null;
  /**
   * The roster role that owns a Task, as stored; undefined when the row has none.
   * Written on create only for a task created with its owner (requestEnvironmentChange): a
   * planned task's owner is assigned after its creation by the plan store.
   */
  ownerRoleId?: string;
  /**
   * The largest context window an attempt of the item did not fit, written only by
   * WorkItemRepository.saveRefundedOverflow; null when no attempt has overflowed one.
   */
  overflowedWindowTokens: number | null;
  /**
   * On an environment-change task, the task it was opened for, set when it is
   * created (requestEnvironmentChange); null on every other item.
   */
  repairsTaskId: WorkItemId | null;
  createdAt: Date;
  updatedAt: Date;
  events: DomainEvent[];
}

export function createPendingWorkItem(
  level: WorkItemLevel,
  title: string,
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
    projectId,
    failureVerdict: { kind: "none" },
    dispatchCount: 0,
    workKind: null,
    overflowedWindowTokens: null,
    repairsTaskId: null,
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
    createDomainEvent("work_item.started", "delivery", {
      work_item_id: item.id,
      level: item.level,
    }),
  );
}

/**
 * Completes work that ran. Pinned to InProgress: the `Blocked -> Completed` edge belongs to
 * completeRecordedMerge alone.
 */
export function completeWorkItem(item: WorkItem): void {
  if (item.status !== "InProgress" || !canTransitionTo(item.status, "Completed")) {
    throw new InvalidStatusTransition(item.id, item.status, "Completed");
  }
  item.status = "Completed";
  item.updatedAt = new Date();
  item.events.push(
    createDomainEvent("work_item.completed", "delivery", {
      work_item_id: item.id,
      level: item.level,
    }),
  );
}

/**
 * Completes an item Blocked as `merge_unrecorded`, or as `orphan_unreconciled` whose merge was
 * since found on main, once the record of its merge is written: its work is on main already, so it
 * never goes back to Pending. Clears the block's reason.
 */
export function completeRecordedMerge(item: WorkItem): void {
  const source = item.blockedReason?.source;
  if (
    item.status !== "Blocked" ||
    (source !== "merge_unrecorded" && source !== "orphan_unreconciled") ||
    !canTransitionTo(item.status, "Completed")
  ) {
    throw new InvalidStatusTransition(item.id, item.status, "Completed");
  }
  item.status = "Completed";
  item.blockedReason = undefined;
  item.updatedAt = new Date();
  item.events.push(
    createDomainEvent("work_item.completed", "delivery", {
      work_item_id: item.id,
      level: item.level,
    }),
  );
}

/**
 * Fails an item with Quality's verdict on whether another attempt can succeed: the verdict is
 * saved with the transition, so the item is routed by it whenever it is routed, a restart between
 * the two included.
 */
export function failWorkItem(item: WorkItem, reason: StoredBlockedReason, verdict: FailureVerdict): void {
  if (!canTransitionTo(item.status, "Failed")) {
    throw new InvalidStatusTransition(item.id, item.status, "Failed");
  }
  item.status = "Failed";
  item.blockedReason = reason;
  item.failureVerdict = { kind: "recorded", verdict };
  item.updatedAt = new Date();
  item.events.push(
    createDomainEvent("work_item.failed", "delivery", {
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
    createDomainEvent("work_item.blocked", "delivery", {
      work_item_id: item.id,
      level: item.level,
    }),
  );
}

/**
 * Returns a Blocked item to Pending once its automatic exit has cleared (orchestrator
 * parked-exits.ts); no person unblocks a task. Pins its
 * from-status to `Blocked` EXPLICITLY: several statuses share the `-> Pending` graph edge
 * (Blocked, Failed, InProgress), but each is owned by a distinct method with its own domain event
 * and intent. canTransitionTo is only the edge-level guard (enforced again at save()); the method
 * adds the method-level invariant so a caller cannot, say, drive an InProgress item (with a live
 * agent) back to Pending through unblock. See "Aggregates own their invariants" (CLAUDE.md DDD).
 * Clears the reason; the event carries the block it cleared.
 */
export function unblockWorkItem(item: WorkItem): void {
  // A merge_unrecorded item's work is merged: Pending would re-dispatch it (completeRecordedMerge is its exit).
  if (item.status !== "Blocked" || item.blockedReason?.source === "merge_unrecorded" || !canTransitionTo(item.status, "Pending")) {
    throw new InvalidStatusTransition(item.id, item.status, "Pending");
  }
  const previous = item.blockedReason === undefined ? null : blockedReasonToRecord(item.blockedReason);
  item.status = "Pending";
  item.blockedReason = undefined;
  item.updatedAt = new Date();
  item.events.push(
    createDomainEvent("work_item.unblocked", "delivery", {
      work_item_id: item.id,
      level: item.level,
      unblocked_by: "automatic exit",
      note: `the cause of its ${previous === null ? "unrecorded" : String(previous["source"])} block cleared`,
      previous_blocked_reason: previous,
    }),
  );
}

/** Why a work item is given up: any recorded cause but a plan revision's supersession, which is supersedeWorkItem's. */
type GiveUpReason = Exclude<StoredBlockedReason, { readonly source: "superseded" }>;

/**
 * Gives an item up: its work cannot be
 * done as planned, and no person decides what happens next. The item goes to the terminal
 * Abandoned with the cause, and the abandonment itself records the plan repair the project then
 * awaits (the plan-repair trigger): the remaining work is planned again around it,
 * at most R times before the project halts as undeliverable (Replanner). Pinned to the open
 * statuses a give-up is decided in: an InProgress item whose attempt ended with the cause, a
 * Pending item the gate finds can never be dispatched, a Blocked item whose block has no exit that
 * clears by itself. A Failed item is the FailureRouter's to abandon.
 */
export function giveUpWorkItem(item: WorkItem, reason: GiveUpReason): void {
  const open = item.status === "InProgress" || item.status === "Pending" || item.status === "Blocked";
  if (!open || !canTransitionTo(item.status, "Abandoned")) {
    throw new InvalidStatusTransition(item.id, item.status, "Abandoned");
  }
  item.status = "Abandoned";
  item.blockedReason = reason;
  item.updatedAt = new Date();
  item.events.push(
    createDomainEvent("work_item.given_up", "delivery", {
      work_item_id: item.id,
      level: item.level,
      cause: reason.source,
    }),
  );
}

/** Why a replanned item's prior attempt failed, carried to its next attempt. */
type ReplanContext = Extract<StoredBlockedReason, { source: "replan" }>["replanContext"];

/**
 * Recovers a Failed item back to Pending so it re-enters planning (FailureRouter's
 * "replan" decision). Replaces the prior failure reason with `replanContext`, the
 * failure the next attempt is told about, or with none when a person replans by hand
 * (`null`): no stale blockedReason lingers on the row. Pins its from-status to
 * `Failed` EXPLICITLY (the `-> Pending` edge is shared with Blocked/InProgress, each
 * owned by its own method): replan is a retry decision, distinct from an unblock or
 * a crash-orphan requeue, so it must never accept a Blocked or InProgress item.
 */
export function replanWorkItem(item: WorkItem, replanContext: ReplanContext | null): void {
  if (item.status !== "Failed" || !canTransitionTo(item.status, "Pending")) {
    throw new InvalidStatusTransition(item.id, item.status, "Pending");
  }
  item.status = "Pending";
  item.blockedReason = replanContext === null ? undefined : { source: "replan", replanContext };
  item.updatedAt = new Date();
  item.events.push(
    createDomainEvent("work_item.replanned", "delivery", {
      work_item_id: item.id,
      level: item.level,
    }),
  );
}

/**
 * Moves an item to the terminal Abandoned status. Which statuses may reach
 * Abandoned is governed solely by `canTransitionTo` and the transition table
 * in `work-item-language/transitions.ts` — this function delegates to it and
 * adds no further guard. Callers include the FailureRouter (Failed →
 * Abandoned) and the HTTP PATCH /work-items/:id/status route, which
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
    createDomainEvent("work_item.abandoned", "delivery", {
      work_item_id: item.id,
      level: item.level,
    }),
  );
}

/**
 * Supersedes open work a revision of the plan replaced: a Pending, Blocked or
 * Failed item goes to the terminal Abandoned with a `superseded` reason. Pinned to those
 * from-statuses: an InProgress task has a live attempt the revision waits for, and a Completed
 * item is merged work the revision keeps. An InProgress Epic is open too: it has no attempt of
 * its own, and once its open tasks are superseded no child completion can ever settle it.
 */
export function supersedeWorkItem(
  item: WorkItem,
  reason: Extract<StoredBlockedReason, { readonly source: "superseded" }>,
): void {
  const open =
    item.status === "Pending" ||
    item.status === "Blocked" ||
    item.status === "Failed" ||
    (item.level === "Epic" && item.status === "InProgress");
  if (!open || !canTransitionTo(item.status, "Abandoned")) {
    throw new InvalidStatusTransition(item.id, item.status, "Abandoned");
  }
  item.status = "Abandoned";
  item.blockedReason = reason;
  item.updatedAt = new Date();
  item.events.push(
    createDomainEvent("work_item.superseded", "delivery", {
      work_item_id: item.id,
      level: item.level,
      plan_revision: reason.planRevision,
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
    createDomainEvent("work_item.requeued", "delivery", {
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
