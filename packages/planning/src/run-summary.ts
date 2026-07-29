import type { WorkItemLevel, WorkItemStatus } from "@ashara/shared";
import type { TerminationReason, TerminationCounts, StalledCause, StopReason } from "./termination.js";
import type { AcceptanceVerdict } from "./acceptance.js";

/**
 * The migration Phase 7 run-completion report (ADR-029). Every field here is a
 * pure derivation from a termination snapshot + the TerminationDecision computed
 * over it (packages/orchestrator/src/termination.ts) — no fact lives ONLY in a
 * human-readable string; the structured source (StalledCause, blockedBy,
 * TerminationCounts) always rides alongside it (Discipline C: no lossy
 * conversions). Reading a RunSummary alone must explain why the run stopped and
 * what was left undone, with no other file open.
 */

/** A work item that reached Completed — the run's delivered output. */
export interface ShippedItem {
  readonly id: string;
  readonly title: string;
  readonly level: WorkItemLevel;
}

/**
 * Why a FailureRouter decision (packages/planning/src/failure-router.ts) ended
 * an item at Abandoned:
 *  - `substitute-abandon`  — a completed sibling with an equivalent title already
 *    delivers this work; the duplicate was terminated in its favor
 *    (blockedReason.substitutedBy is set).
 *  - `exhausted-abandon`   — retries ran out with no equivalent found (or the
 *    router itself errored and the orchestrator abandoned fail-closed); the
 *    deliverable was never produced.
 *  - `unspecified-abandon` — the item was abandoned outside the FailureRouter
 *    path (e.g. the HTTP PATCH /status endpoint, blockedReason.source ===
 *    "api") with a caller-supplied reason that matches neither shape above.
 *    classifyAbandon() (run-summary.ts) prefers blockedReason.source when
 *    present — an "api" tag always classifies here even if its free-text
 *    payload happens to contain a "reason" key, so it is never mistaken for
 *    an exhausted-abandon. Untagged legacy rows fall back to duck-typing.
 */
export type AbandonKind = "exhausted-abandon" | "substitute-abandon" | "unspecified-abandon";

/** A work item that reached Abandoned, with its recovery-path reason preserved. */
export interface AbandonedItem {
  readonly id: string;
  readonly title: string;
  readonly level: WorkItemLevel;
  readonly kind: AbandonKind;
  /** Always derivable from the fields below — never the only place the fact lives. */
  readonly reason: string;
  /** Present only for substitute-abandon: the id of the item satisfying the deliverable instead. */
  readonly substitutedBy?: string;
  /** Retry count recorded at abandonment time, when the router provided one. */
  readonly attempts?: number;
  /** Raw failure detail from the last attempt, when the router provided one. */
  readonly lastFailureDetail?: string;
  // contract-erasing: the original StoredBlockedReason is widened via blockedReasonToRecord
  readonly raw: Record<string, unknown>;
}

/**
 * A CONTRACT-declared endpoint the plan does not yet cover (mig9-t2, ADR-032 §2).
 * Distinct from `CoverageGap` (a planned work item left undone): this is the
 * reconciliation signal that an endpoint the ProjectContract requires has no
 * completed work producing it — the Run-9 "register declared, never built" hole.
 * Deterministically derived from the persisted contract (no LLM), so reading it
 * alone names the missing endpoint and why it is still open.
 */
export interface EndpointCoverageGap {
  /** The contract endpoint's stable logical ref (see contract.ts identity rules). */
  readonly ref: string;
  readonly method: string;
  readonly path: string;
  readonly purpose: string;
  /**
   * `unplanned` — no work item declares it (declaredBy unset): the reconciler
   * proposes a task for it. `planned-unbuilt` — a task declares it but has not
   * completed, so the endpoint is not yet produced. Both are BLOCKING (they keep the
   * run incomplete and hold parent rollup). `out-of-scope` — a spec-derivation
   * invention absent from vision and plan (r12-t1): INFORMATIONAL only, surfaced to
   * the owner with its reason but never counted toward completeness nor auto-tasked,
   * so it can neither burn dispatch budget nor deadlock the run.
   */
  readonly kind: "unplanned" | "planned-unbuilt" | "out-of-scope";
  /** Human-readable WHY, always derivable from the fields alongside it. */
  readonly reason: string;
}

export type CoverageGapKind = "stalled" | "budget-cutoff";

/** A planned-but-not-completed item, with WHY it was left undone. */
export interface CoverageGap {
  readonly id: string;
  readonly title: string;
  readonly level: WorkItemLevel;
  readonly status: WorkItemStatus;
  readonly kind: CoverageGapKind;
  /** Human-readable WHY, always derived from the structured fields alongside it. */
  readonly reason: string;
  /** Populated for kind === "stalled" (the StalledItem root cause); absent for budget-cutoff. */
  readonly cause?: StalledCause;
  /** Ids this item is blocked by — Abandoned roots, or the frozen subtree's Abandoned leaves. */
  readonly blockedBy: readonly string[];
}

/**
 * The run-termination report (migration Phase 7). Reading this object ALONE —
 * with no other file open — must explain why the run stopped and what remains
 * undone (Discipline C: error/outcome reproducibility).
 */
export interface RunSummary {
  readonly stopReason: StopReason;
  readonly counts: TerminationCounts;
  readonly shipped: readonly ShippedItem[];
  readonly abandoned: readonly AbandonedItem[];
  readonly gaps: readonly CoverageGap[];
  /**
   * CONTRACT-declared endpoints the plan does not yet cover (mig9-t2). Populated
   * in both enforcing and observe-only modes so an open coverage gap is always
   * visible in the report, even when observe-only lets the run settle over it.
   */
  readonly endpointGaps: readonly EndpointCoverageGap[];
  /** Distinct Abandoned root ids the liveness stop attributed stalls to; empty otherwise. */
  readonly abandonedRoots: readonly string[];
  /** Product-level acceptance verdict (ADR-040). Populated when the acceptance loop ran. */
  readonly acceptance?: AcceptanceVerdict;
  /** One self-sufficient paragraph: why the run stopped and what remains undone. */
  readonly narrative: string;
}
