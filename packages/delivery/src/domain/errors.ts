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
