import type { WorkItemStatus } from "@ashara/shared";

// Re-export cross-boundary errors from Published Language (ADR-044).
// Planning's domain code still imports them from this file; consumers
// will migrate to @ashara/shared via their ACL.
export {
  InvalidStatusTransition,
  WorkItemNotFound,
  ContractVersionConflict,
} from "@ashara/shared";

export class PlanningError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "PlanningError";
  }
}

export class CycleDetected extends PlanningError {
  constructor() {
    super("Dependency cycle detected", "CYCLE_DETECTED");
    this.name = "CycleDetected";
  }
}

export type ContractConflictKind = "endpoint-divergence" | "module-purpose-divergence";

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

export class ContractAlreadyExists extends PlanningError {
  constructor(public readonly projectId: string) {
    super(
      `Contract already exists for project ${projectId}; use amendContract to change it`,
      "CONTRACT_ALREADY_EXISTS",
    );
    this.name = "ContractAlreadyExists";
  }
}

export class ContractNotFound extends PlanningError {
  constructor(public readonly projectId: string) {
    super(`No contract found for project ${projectId}; write it before amending`, "CONTRACT_NOT_FOUND");
    this.name = "ContractNotFound";
  }
}
