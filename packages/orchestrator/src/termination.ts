import type { DependencyResolution } from "@ashara/planning-domain";
import type {
  WorkItemLevel,
  WorkItemStatus,
  TerminationDecision,
  TerminationCounts,
  StalledItem,
  StalledCause,
} from "@ashara/shared";

/**
 * The status/dependency view of one work item, as termination sees it. Every
 * field is derivable from a WorkItemRepository.listAll() plus a single
 * DependencyGraph.resolveDependencies() pass — the wiring task (mig7-t3)
 * assembles it; this module performs no I/O and no LLM calls (DA-01: the
 * termination signal is deterministic).
 */
export interface TerminationItemSnapshot {
  readonly id: string;
  readonly parentId?: string;
  readonly status: WorkItemStatus;
  readonly level: WorkItemLevel;
  /**
   * How this item's dependency edges resolve, straight from
   * DependencyGraph.resolveDependencies (`met` when the item has no edges or is
   * absent from the resolution map). The `blocked` value already encodes the
   * transitive Abandoned-root signal from migration Phase 6 — this module
   * consumes it rather than re-deriving it.
   */
  readonly resolution: DependencyResolution;
  /** Abandoned root ids from resolveDependencies; empty unless `resolution === "blocked"`. */
  readonly blockedBy: readonly string[];
  /**
   * For a `Failed` item only: does a recovery path STILL exist? The caller asserts
   * `true` when something will re-route this Failed item (the startup reconciler
   * replans it) AND the replan bound is not yet exhausted — the single source of
   * that predicate is `isRecoverableFailed` in startup-reconciler.ts, which the
   * reconciler and this seam share so they never drift. Defaults to `false`: a
   * parked Failed item is only re-routed by the startup reconciler (on boot) and by
   * synchronous in-cycle recovery on a FRESH failure; the gate selects only Pending
   * items, so a bound-exhausted Failed item has no route out and counts toward
   * unfinishability. Marking it `true` keeps the run alive (fail-closed against
   * premature termination) so the reconciler can act.
   */
  readonly recoverable?: boolean;
}

/**
 * A quiescent picture of the run at a cycle boundary. The caller (mig7-t3) must
 * assemble this AFTER decomposition and post-cycle mutations have settled, so
 * `items` reflects the state a fresh cycle would observe — otherwise a liveness
 * verdict could race work that is about to appear.
 */
export interface TerminationSnapshot {
  readonly items: readonly TerminationItemSnapshot[];
  /** Budget policy verdict (Budget.isExhausted). Termination reads it; it never sets policy. */
  readonly budgetExhausted: boolean;
  /**
   * Open contract coverage gaps at this snapshot (mig9-t2): declared endpoints the
   * plan does not yet produce. A run with an open gap has NOT done all it set out
   * to do, so `completeness` cannot fire while this is > 0. The caller passes the
   * ENFORCING count here and 0 in observe-only mode (where gaps are reported but
   * never block the run). Defaults to 0 so existing snapshots are unaffected.
   */
  readonly openCoverageGaps?: number;
}

const TERMINAL_STATUSES: ReadonlySet<WorkItemStatus> = new Set<WorkItemStatus>([
  "Completed",
  "Abandoned",
  "Archived",
]);

function isTerminal(status: WorkItemStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * Decides whether a run should keep cycling or stop, and if it stops, WHY — as
 * one of three separated dimensions (DA-01): completeness, economy, liveness.
 * Pure and deterministic: the same snapshot always yields the same decision.
 *
 * Priority (documented, and covered by the mixed-signal tests):
 *   1. completeness — every item terminal. The definitive "done" state wins even
 *      when the budget is also exhausted: reaching a terminal state for every
 *      item is the truthful, most informative reason, and there is nothing left
 *      to spend budget on.
 *   2. economy — budget exhausted. A hard external stop that fires even while
 *      dispatchable work remains (that is the DA-01 separation made concrete).
 *   3. liveness — the plan is frozen: no future cycle can change it.
 *   4. continue — progress is still possible.
 *
 * LIVENESS DEFINITION (fail-closed — see the story gate). The loop's only
 * progress mechanisms are: dispatch a gate-eligible Task, decompose a childless
 * Pending Story, receive an in-flight Task's result (which cascades to parents
 * and unblocks dependents), or have a reconciler replan a still-recoverable
 * Failed item. If NONE of those can happen this cycle, the next cycle starts
 * from a bit-identical state and also does nothing — the run is frozen. So
 * liveness stops iff there is at least one non-terminal item and NO item is
 * `advanceable`. Because the dependency graph is acyclic, every "waiting" chain
 * bottoms out at either an advanceable leaf (→ not frozen, we continue) or an
 * Abandoned / non-recoverable-Failed node (→ genuinely frozen), so gating the
 * stop on "nothing currently actionable" is sound and never terminates a plan
 * that could still advance.
 *
 * ASSUMPTIONS (explicit, per the story review):
 *  - PARENTS ARE NEVER DISPATCHABLE. Only Tasks dispatch and childless Stories
 *    decompose; Epic/Feature/Story-with-children items advance only by
 *    cascade-completion. So the module reasons at the LEAF level and rolls the
 *    conclusion up: a parent is never a progress source, therefore a parent
 *    stuck non-terminal never blocks termination (no hang), and its unfinishable
 *    subtree surfaces as `cascade_frozen` with the offending Abandoned leaves
 *    rolled up into its `blockedBy` and the aggregate `abandonedRoots`.
 *  - COMPLETENESS IS THE POST-CASCADE-FIX WORLD. A parent reaches a terminal
 *    state only when every child is SETTLED — Completed, or Abandoned with a
 *    satisfied substitute (the sibling cascadeCompletion fix). An EXHAUSTED
 *    abandon (retries spent, no substitute, work never delivered) never settles
 *    its parent, so a plan containing one can never reach `completeness`;
 *    `liveness` is the signal that must fire, reporting the frozen ancestors of
 *    that abandoned leaf as a coverage gap.
 *  - PARKED-FAILED RECOVERABILITY. A Failed item is advanceable ONLY if the
 *    caller marks it `recoverable` (the startup reconciler will replan it and the
 *    bound is not exhausted — see isRecoverableFailed). Unmarked ⇒ non-recoverable
 *    ⇒ counts toward unfinishability. This is fail-closed in both directions: it
 *    never terminates while recovery is still possible, and it never idles forever
 *    on a Failed item nothing will re-route (a bound-exhausted Failed item, which
 *    the reconciler abandons rather than replans).
 */
export function evaluate(snapshot: TerminationSnapshot): TerminationDecision {
  const { items, budgetExhausted } = snapshot;
  const openCoverageGaps = snapshot.openCoverageGaps ?? 0;
  const parentsWithChildren = collectParents(items);
  const counts = tallyCounts(items, parentsWithChildren);

  // Completeness is the "did everything it set out to do" verdict. An open contract
  // coverage gap means a declared endpoint was never produced, so the run is NOT
  // complete even if every work item is terminal (the Run-9 Completed-while-auth-
  // unusable hole). In enforcing mode a gap keeps the run cycling so reconciliation
  // can surface it as a task; observe-only passes 0 here and completeness fires.
  if (counts.total > 0 && counts.nonTerminal === 0 && openCoverageGaps === 0) {
    return { decision: "stop", reason: "completeness", counts, stalled: [], abandonedRoots: [] };
  }

  if (budgetExhausted) {
    return { decision: "stop", reason: "economy", counts, stalled: [], abandonedRoots: [] };
  }

  if (counts.total > 0 && counts.nonTerminal > 0 && !hasAdvanceableItem(items, parentsWithChildren)) {
    const { stalled, abandonedRoots } = classifyStalled(items);
    return { decision: "stop", reason: "liveness", counts, stalled, abandonedRoots };
  }

  return { decision: "continue", counts };
}

function collectParents(items: readonly TerminationItemSnapshot[]): ReadonlySet<string> {
  const parents = new Set<string>();
  for (const item of items) {
    if (item.parentId !== undefined) parents.add(item.parentId);
  }
  return parents;
}

/**
 * An item is `advanceable` when a future cycle can act on it directly — the only
 * sources of forward progress in the loop:
 *  - a dispatched leaf Task still running (its result will cascade), or
 *  - a still-recoverable Failed item (a reconciler will replan it), or
 *  - a Pending leaf Task with dependencies met (the gate will dispatch it), or
 *  - a childless Pending Story with dependencies met (the planner decomposes it).
 * Only Stories are decomposed by the loop (findStoriesNeedingDecomposition), so
 * a childless Feature/Epic is intentionally NOT advanceable — it surfaces as a
 * stall rather than masking a broken plan.
 */
function isAdvanceable(item: TerminationItemSnapshot, parentsWithChildren: ReadonlySet<string>): boolean {
  if (item.status === "InProgress" && item.level === "Task") return true;
  if (item.status === "Failed") return item.recoverable === true;
  if (item.status !== "Pending") return false;
  if (item.resolution !== "met") return false;
  if (item.level === "Task") return true;
  if (item.level === "Story" && !parentsWithChildren.has(item.id)) return true;
  return false;
}

function hasAdvanceableItem(
  items: readonly TerminationItemSnapshot[],
  parentsWithChildren: ReadonlySet<string>,
): boolean {
  return items.some((item) => isAdvanceable(item, parentsWithChildren));
}

/**
 * Attributes a root cause to each non-terminal item and aggregates the distinct
 * Abandoned roots. Called only when the plan is already known to be frozen, so
 * every classified item is genuinely stuck.
 *
 * Rollup: a `cascade_frozen` ancestor reports the Abandoned leaves in its own
 * subtree as its `blockedBy` (the leaf-level cause of the freeze), and those
 * leaves feed the aggregate `abandonedRoots` — so a frozen Epic/Feature/Story
 * is linked to the abandonment that made it unfinishable.
 */
function classifyStalled(items: readonly TerminationItemSnapshot[]): {
  stalled: StalledItem[];
  abandonedRoots: string[];
} {
  const childrenByParent = groupByParent(items);
  const stalled: StalledItem[] = [];
  const roots = new Set<string>();

  for (const item of items) {
    if (isTerminal(item.status)) continue;
    const cause = classifyCause(item);
    let blockedBy = item.blockedBy;

    if (cause === "blocked_by_abandoned") {
      for (const root of item.blockedBy) roots.add(root);
    } else if (cause === "cascade_frozen") {
      const abandonedLeaves = collectAbandonedDescendants(item.id, childrenByParent);
      if (abandonedLeaves.length > 0) blockedBy = abandonedLeaves;
      for (const root of abandonedLeaves) roots.add(root);
    }

    stalled.push({ id: item.id, status: item.status, level: item.level, cause, blockedBy });
  }

  return { stalled, abandonedRoots: [...roots] };
}

function groupByParent(
  items: readonly TerminationItemSnapshot[],
): ReadonlyMap<string, TerminationItemSnapshot[]> {
  const byParent = new Map<string, TerminationItemSnapshot[]>();
  for (const item of items) {
    if (item.parentId === undefined) continue;
    const siblings = byParent.get(item.parentId);
    if (siblings) siblings.push(item);
    else byParent.set(item.parentId, [item]);
  }
  return byParent;
}

/** DFS the parent→child tree collecting Abandoned descendant ids (visited-guarded). */
function collectAbandonedDescendants(
  rootId: string,
  childrenByParent: ReadonlyMap<string, TerminationItemSnapshot[]>,
): string[] {
  const out: string[] = [];
  const visited = new Set<string>([rootId]);
  const stack: TerminationItemSnapshot[] = [...(childrenByParent.get(rootId) ?? [])];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined || visited.has(node.id)) continue;
    visited.add(node.id);
    if (node.status === "Abandoned") out.push(node.id);
    const children = childrenByParent.get(node.id);
    if (children) stack.push(...children);
  }
  return out;
}

function classifyCause(item: TerminationItemSnapshot): StalledCause {
  if (item.resolution === "blocked") return "blocked_by_abandoned";
  if (item.status === "Failed") return "stuck_failed";
  if (item.status === "Blocked") return "externally_blocked";
  if (item.level !== "Task") return "cascade_frozen";
  return "stalled_waiting";
}

function tallyCounts(
  items: readonly TerminationItemSnapshot[],
  parentsWithChildren: ReadonlySet<string>,
): TerminationCounts {
  let pending = 0;
  let inProgress = 0;
  let completed = 0;
  let blocked = 0;
  let failed = 0;
  let abandoned = 0;
  let archived = 0;
  let nonTerminal = 0;
  let dispatchable = 0;
  let inFlight = 0;

  for (const item of items) {
    switch (item.status) {
      case "Pending":
        pending += 1;
        break;
      case "InProgress":
        inProgress += 1;
        break;
      case "Completed":
        completed += 1;
        break;
      case "Blocked":
        blocked += 1;
        break;
      case "Failed":
        failed += 1;
        break;
      case "Abandoned":
        abandoned += 1;
        break;
      case "Archived":
        archived += 1;
        break;
    }

    if (!isTerminal(item.status)) nonTerminal += 1;
    if (item.status === "InProgress" && item.level === "Task") inFlight += 1;
    if (isAdvanceable(item, parentsWithChildren) && item.status === "Pending") dispatchable += 1;
  }

  return {
    total: items.length,
    pending,
    inProgress,
    completed,
    blocked,
    failed,
    abandoned,
    archived,
    nonTerminal,
    dispatchable,
    inFlight,
  };
}
