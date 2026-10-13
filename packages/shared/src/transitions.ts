import type { WorkItemStatus } from "./enums.js";
import { WORK_ITEM_STATUSES } from "./enums.js";

/**
 * Published Language: the WorkItem state-machine contract.
 * Both the domain layer (planning BC) and the persistence layer (db)
 * validate against this single source of truth — neither imports the other.
 * ADR-044: Anti-Corruption Layer.
 */

/**
 * Every status's outbound edges, keyed by `Record<WorkItemStatus, ...>` so the
 * machine is TOTAL by construction: adding a member to WorkItemStatus without
 * declaring where it can go fails to typecheck, and a terminal state has to say
 * `[]` out loud instead of being terminal by omission. `Archived` was removed
 * because it was terminal by omission in the other direction — declared, never
 * reachable, and never written by anything.
 *
 * `Blocked -> Abandoned` exists because Blocked is the owner-parked state and
 * its only other exit is `-> Pending`: without a give-up edge, work an owner
 * parks and then decides against can never leave the machine (HTTP PATCH to
 * Abandoned threw InvalidStatusTransition).
 *
 * `Pending -> Abandoned` and `InProgress -> Abandoned` give every non-terminal
 * status a one-hop path to a terminal one. Without them, Pending had no path to
 * any terminal status at all, and InProgress required two hops (-> Failed ->
 * Abandoned). Their first traverser, the run-end sweep, was deleted by
 * t-cut-w7; the owner's PATCH /work-items/:id/status route remains one.
 *
 * `Completed -> Pending` has no traverser: its only one, reopenWorkItem, was
 * removed, and unblock/replan/requeue each pin a different from-status. The edge
 * is kept because removing it makes Completed terminal, which changes every
 * TERMINAL_STATUSES consumer; that is an owner decision. Its intended traverser
 * is story c-change-handling (reopened items).
 */
const OUTBOUND_TRANSITIONS: Record<WorkItemStatus, readonly WorkItemStatus[]> = {
  Pending: ["InProgress", "Blocked", "Abandoned"],
  InProgress: ["Completed", "Blocked", "Failed", "Pending", "Abandoned"],
  Blocked: ["Pending", "Abandoned"],
  Failed: ["Pending", "Abandoned"],
  Completed: ["Pending"],
  Abandoned: [],
};

/** Derived, never hand-listed: a status is terminal exactly when it has no exits. */
export const TERMINAL_STATUSES: ReadonlySet<WorkItemStatus> = new Set(
  WORK_ITEM_STATUSES.filter((status) => OUTBOUND_TRANSITIONS[status].length === 0),
);

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

export class RepositoryError extends Error {
  constructor(message: string) {
    super(`Repository error: ${message}`);
    this.name = "RepositoryError";
  }
}

export class ContractVersionConflict extends Error {
  constructor(
    public readonly projectId: string,
    public readonly attemptedVersion: number,
  ) {
    super(
      `Contract version ${attemptedVersion} for project ${projectId} was taken concurrently; ` +
        `re-read the latest version and retry`,
    );
    this.name = "ContractVersionConflict";
  }
}
