import type { WorkItemStatus } from "@ashara/shared";

export class PlanningError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "PlanningError";
  }
}

export class InvalidStatusTransition extends PlanningError {
  constructor(
    public readonly id: string,
    public readonly from: WorkItemStatus,
    public readonly to: WorkItemStatus,
  ) {
    super(
      `Invalid status transition for ${id}: ${from} -> ${to}`,
      "INVALID_STATUS_TRANSITION",
    );
    this.name = "InvalidStatusTransition";
  }
}

export class WorkItemNotFound extends PlanningError {
  constructor(public readonly workItemId: string) {
    super(`Work item not found: ${workItemId}`, "WORK_ITEM_NOT_FOUND");
    this.name = "WorkItemNotFound";
  }
}

export class InvalidLevel extends PlanningError {
  constructor(public readonly level: string) {
    super(`Invalid level: ${level}`, "INVALID_LEVEL");
    this.name = "InvalidLevel";
  }
}

export class CycleDetected extends PlanningError {
  constructor() {
    super("Dependency cycle detected", "CYCLE_DETECTED");
    this.name = "CycleDetected";
  }
}

export class RepositoryError extends PlanningError {
  constructor(message: string) {
    super(`Repository error: ${message}`, "REPOSITORY_ERROR");
    this.name = "RepositoryError";
  }
}

export type ContractConflictKind = "endpoint-divergence" | "module-purpose-divergence";

/**
 * A contract amendment tried to overwrite an existing declaration with a divergent
 * one (ADR-028): the same endpoint `ref` at a different method/path, or the same
 * module `path` with a different purpose. Both sides ride along untouched
 * (Discipline C) so the caller can see exactly what was declared vs. what was
 * attempted — the delta is rejected, never silently applied.
 */
export class ContractConflict extends PlanningError {
  constructor(
    public readonly conflictKind: ContractConflictKind,
    public readonly identity: string,
    public readonly existing: unknown,
    public readonly incoming: unknown,
  ) {
    super(
      `Contract conflict (${conflictKind}) on "${identity}": ` +
        `existing=${JSON.stringify(existing)} incoming=${JSON.stringify(incoming)}`,
      "CONTRACT_CONFLICT",
    );
    this.name = "ContractConflict";
  }
}

/**
 * `writeContract` seeds version 1 and is fail-closed against clobbering an existing
 * contract: once a project has a contract, changes must go through `amendContract`
 * (which runs conflict validation) rather than a blind full re-write.
 */
export class ContractAlreadyExists extends PlanningError {
  constructor(public readonly projectId: string) {
    super(
      `Contract already exists for project ${projectId}; use amendContract to change it`,
      "CONTRACT_ALREADY_EXISTS",
    );
    this.name = "ContractAlreadyExists";
  }
}

/** `amendContract` requires a base version to merge onto; none was found. */
export class ContractNotFound extends PlanningError {
  constructor(public readonly projectId: string) {
    super(`No contract found for project ${projectId}; write it before amending`, "CONTRACT_NOT_FOUND");
    this.name = "ContractNotFound";
  }
}

/**
 * A concurrent writer already took the version this operation targeted (the
 * persistence UNIQUE (project_id, version) guard fired). The raw driver exception
 * is translated to this typed error at the db boundary so no unhandled SQLSTATE
 * 23505 leaks past the repository (Discipline C). It is the RETRYABLE signal for
 * amendContract: the caller may re-read the latest version and re-apply its delta
 * onto the newer base. (writeContract translates it further to
 * ContractAlreadyExists, since a version-1 collision means the contract now
 * exists.)
 */
export class ContractVersionConflict extends PlanningError {
  constructor(
    public readonly projectId: string,
    public readonly attemptedVersion: number,
  ) {
    super(
      `Contract version ${attemptedVersion} for project ${projectId} was taken concurrently; ` +
        `re-read the latest version and retry`,
      "CONTRACT_VERSION_CONFLICT",
    );
    this.name = "ContractVersionConflict";
  }
}
