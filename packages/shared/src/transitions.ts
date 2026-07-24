import type { WorkItemStatus } from "./enums.js";

/**
 * Published Language: the WorkItem state-machine contract.
 * Both the domain layer (planning BC) and the persistence layer (db)
 * validate against this single source of truth — neither imports the other.
 * ADR-044: Anti-Corruption Layer.
 */

export const TERMINAL_STATUSES: ReadonlySet<WorkItemStatus> = new Set([
  "Completed",
  "Abandoned",
  "Archived",
]);

export function canTransitionTo(
  from: WorkItemStatus,
  to: WorkItemStatus,
): boolean {
  return (
    (from === "Pending" && to === "InProgress") ||
    (from === "InProgress" && to === "Completed") ||
    (from === "InProgress" && to === "Blocked") ||
    (from === "InProgress" && to === "Failed") ||
    (from === "InProgress" && to === "Pending") ||
    (from === "Pending" && to === "Blocked") ||
    (from === "Blocked" && to === "Pending") ||
    (from === "Failed" && to === "Pending") ||
    (from === "Failed" && to === "Abandoned")
  );
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
