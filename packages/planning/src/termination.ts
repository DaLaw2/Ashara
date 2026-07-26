import type { WorkItemLevel, WorkItemStatus } from "@ashara/shared";

/**
 * Why a run stopped (migration Phase 7, ADR-029). The three dimensions are kept
 * deliberately SEPARATE (user directive DA-01): they are never collapsed into a
 * single "everything is blocked" check.
 *
 *  - `completeness` — every planned work item reached a terminal state
 *    (Completed / Abandoned). The run did all it set out to do; this
 *    is the clean-finish signal and is distinct from `liveness`.
 *  - `economy`      — the budget policy is exhausted. The run stops even while
 *    dispatchable work remains. Termination only READS the policy verdict
 *    (Budget.isExhausted); it does not own the policy.
 *  - `liveness`     — no future cycle can change the plan: nothing is
 *    dispatchable, nothing is in flight, and every remaining non-terminal item
 *    is frozen (blocked by an Abandoned root, stuck at Failed with no recovery
 *    path, externally Blocked, or waiting on a dependency/child that is itself
 *    frozen). This is the backstop against the Run-8 "idle forever" failure.
 */
export type TerminationReason = "completeness" | "economy" | "liveness";

/**
 * Why a plan-exhausted run settled. `unverified` is the honest outcome when the
 * acceptance check never produced a verdict: the plan ran out, but nothing
 * confirms the vision was met. It must stay distinct from both accepting
 * reasons so a reader can tell "checked and fine" from "never checked".
 */
export type StopReason = "economy" | "accepted" | "accepted-with-caveats" | "unverified";

/**
 * Why a single non-terminal item cannot progress, attributed at the liveness
 * decision point so a RunSummary can explain the stall per item.
 *
 *  - `blocked_by_abandoned` — a dependency resolved to `blocked`: transitively
 *    unsatisfiable because an Abandoned root sits upstream (the Run-8 shape).
 *  - `stuck_failed`         — the item itself is Failed AND no recovery path still
 *    reaches it. In-cycle recovery (FailureRouter replan/abandon) fires
 *    synchronously inside processTask on a fresh failure, and the STARTUP
 *    reconciler re-routes any parked Failed item on boot — but between those points
 *    the gate selects only Pending items, so a Failed item whose replan bound is
 *    exhausted (the `recoverable` seam on TerminationItemSnapshot is `false`) has no
 *    route out and cannot progress on its own.
 *  - `externally_blocked`   — the item is in the Blocked status (reachable only
 *    via the HTTP PATCH dependency-block path); the loop cannot advance it.
 *  - `cascade_frozen`       — a non-leaf parent that can never cascade-complete
 *    because a descendant reached a terminal state other than Completed
 *    (LifecycleRouter.cascadeCompletion requires ALL children Completed).
 *  - `stalled_waiting`      — a Pending leaf task whose dependencies are neither
 *    met nor Abandoned-blocked, but whose upstream is itself frozen (e.g. a
 *    parked-Failed dependency that resolveDependencies still reports as waiting).
 */
export type StalledCause =
  | "blocked_by_abandoned"
  | "stuck_failed"
  | "externally_blocked"
  | "cascade_frozen"
  | "stalled_waiting";

/** A non-terminal item that cannot progress, with its attributed root cause. */
export interface StalledItem {
  readonly id: string;
  readonly status: WorkItemStatus;
  readonly level: WorkItemLevel;
  readonly cause: StalledCause;
  /** Abandoned root ids blocking this item (from resolveDependencies blockedBy). */
  readonly blockedBy: readonly string[];
}

/** Snapshot tallies at the decision point; carried by every decision for observability. */
export interface TerminationCounts {
  readonly total: number;
  readonly pending: number;
  readonly inProgress: number;
  readonly completed: number;
  readonly blocked: number;
  readonly failed: number;
  readonly abandoned: number;
  readonly nonTerminal: number;
  /** Items the gate/planner could act on this cycle (dispatchable tasks + decomposable stories). */
  readonly dispatchable: number;
  /** Dispatched leaf tasks awaiting a result (InProgress at Task level). */
  readonly inFlight: number;
}

/** The run should keep cycling — progress is still possible. */
export interface TerminationContinue {
  readonly decision: "continue";
  readonly counts: TerminationCounts;
}

/** The run should stop, with a separated reason and structured evidence. */
export interface TerminationStop {
  readonly decision: "stop";
  readonly reason: TerminationReason | StopReason;
  readonly counts: TerminationCounts;
  /** Non-terminal items that cannot progress. Populated for `liveness`; empty otherwise. */
  readonly stalled: readonly StalledItem[];
  /** Distinct Abandoned root ids across all stalled items. Empty unless liveness with roots. */
  readonly abandonedRoots: readonly string[];
}

export interface TerminationPlanExhausted {
  readonly decision: "plan_exhausted";
  readonly trigger: "completeness" | "liveness";
  readonly counts: TerminationCounts;
  readonly stalled: readonly StalledItem[];
}

export type TerminationDecision = TerminationContinue | TerminationStop | TerminationPlanExhausted;
