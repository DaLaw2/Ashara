class PlanningError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "PlanningError";
  }
}

/** The dependency edge fromId -> toId closes a cycle: toId already waits, transitively, on fromId. */
export class CycleDetected extends PlanningError {
  constructor(
    public readonly fromId: string,
    public readonly toId: string,
  ) {
    super(`dependency cycle detected: the edge ${fromId} -> ${toId} closes it`, "CYCLE_DETECTED");
    this.name = "CycleDetected";
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
