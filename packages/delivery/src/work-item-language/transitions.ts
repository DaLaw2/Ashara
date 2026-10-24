import type { WorkItemStatus } from "./work-item-status.js";

/**
 * Published Language: the WorkItem state-machine contract.
 * Both the domain layer (planning BC) and the persistence layer (db)
 * validate against this single source of truth — neither imports the other.
 */

/**
 * Every status's outbound edges, keyed by `Record<WorkItemStatus, ...>` so the
 * machine is TOTAL by construction: adding a member to WorkItemStatus without
 * declaring where it can go fails to typecheck, and a terminal state has to say
 * `[]` out loud instead of being terminal by omission. A status nothing
 * writes is not declared either: it would be terminal by omission in the
 * other direction.
 *
 * `Blocked -> Abandoned` exists because Blocked is the owner-parked state and
 * its only other exit is `-> Pending`: without a give-up edge, work an owner
 * parks and then decides against could never leave the machine.
 *
 * `Pending -> Abandoned` and `InProgress -> Abandoned` give every non-terminal
 * status a one-hop path to a terminal one: without them Pending would reach no
 * terminal status at all, and InProgress only in two hops (-> Failed ->
 * Abandoned). The owner's PATCH /work-items/:id/status route traverses them.
 *
 * `Completed -> Pending` has one traverser: planning's exitStaleChecks reopens a
 * Completed check task whose stored checks went stale, pinned to work kind
 * "check" (unblock/replan/requeue each pin a different from-status).
 *
 * `Blocked -> Completed` has one traverser: planning's completeRecordedMerge, pinned to a
 * `merge_unrecorded` block, or one whose exit to Pending reads main first and found the task's
 * merge there, for work already merged on main whose merge record is written late.
 * Unblocking such an item to Pending would re-dispatch merged work.
 */
export const OUTBOUND_TRANSITIONS: Record<WorkItemStatus, readonly WorkItemStatus[]> = {
  Pending: ["InProgress", "Blocked", "Abandoned"],
  InProgress: ["Completed", "Blocked", "Failed", "Pending", "Abandoned"],
  Blocked: ["Pending", "Abandoned", "Completed"],
  Failed: ["Pending", "Abandoned"],
  Completed: ["Pending"],
  Abandoned: [],
};

export function canTransitionTo(
  from: WorkItemStatus,
  to: WorkItemStatus,
): boolean {
  return OUTBOUND_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// Cross-boundary error types (Published Language)
// ---------------------------------------------------------------------------

export class InvalidStatusTransition extends Error {
  constructor(
    public readonly id: string,
    public readonly from: WorkItemStatus,
    public readonly to: WorkItemStatus,
  ) {
    super(`Invalid status transition for ${id}: ${from} -> ${to}`);
    this.name = "InvalidStatusTransition";
  }
}

export class WorkItemNotFound extends Error {
  constructor(public readonly workItemId: string) {
    super(`Work item not found: ${workItemId}`);
    this.name = "WorkItemNotFound";
  }
}
