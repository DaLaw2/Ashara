import type { EndpointCoverageGap } from "@ashara/shared";
import { parseProjectId } from "@ashara/shared";
import type { WorkItemRepository } from "@ashara/planning-domain";
import { resolvePlanDependencies } from "@ashara/planning-domain";
import { computeCoverageGaps, isBlockingCoverageGap } from "@ashara/planning";

import type { CoreLoopDeps, TerminationOutcome } from "./types.js";
import type { RunSummaryItem } from "./run-summary.js";
import { buildRunSummary } from "./run-summary.js";
import { isRecoverableFailed } from "./startup-reconciler.js";
import { evaluate } from "./termination.js";

export interface SnapshotAssemblyDeps {
  readonly workItemRepo: WorkItemRepository;
  /** FailureRouter.replanBound — the SAME bound the recovery path enforces. */
  readonly replanBound: number;
}

/**
 * Assembles the ONE `RunSummaryItem[]` array that mig7-t1 designed as a superset of
 * TerminationItemSnapshot, so the caller (core-loop) can hand it to BOTH `evaluate()`
 * and `buildRunSummary()` without a second read (run-summary.ts). Reuses the gate's
 * dependency machinery (resolvePlanDependencies → buildDependencyContext +
 * resolveDependencies) rather than re-deriving `blocked`/`blockedBy`, so the
 * transitive Abandoned-root signal (migration Phase 6) is computed once, one way.
 *
 * `recoverable` is populated for Failed items ONLY, using the shared
 * `isRecoverableFailed` predicate the startup reconciler acts on — the two callers
 * therefore agree on when a parked Failed item still has a route out. A non-Failed
 * item leaves it `undefined` (evaluate ignores it for those).
 *
 * The read is fresh (listAll at call time), so the caller must invoke this at a
 * QUIESCENT point — after decomposition and post-cycle mutations have settled — for
 * the liveness verdict not to race work that is about to appear (TerminationSnapshot
 * doc, mig7-t1).
 */
export async function assembleRunSummaryItems(deps: SnapshotAssemblyDeps): Promise<RunSummaryItem[]> {
  const { items, resolution } = await resolvePlanDependencies(deps.workItemRepo);

  const assembled: RunSummaryItem[] = [];
  for (const item of items) {
    const resolved = resolution.get(item.id);
    // In-flight tasks are simply the Task-level InProgress items this read observes:
    // the loop dispatches synchronously, so at a quiescent point the only InProgress
    // Tasks are the loop's own in-cycle knowledge (none in steady state; crash-orphans
    // are reset by the startup reconciler before the runner cycles). evaluate() derives
    // the inFlight tally from these, so nothing extra is threaded here.
    const recoverable =
      item.status === "Failed"
        ? isRecoverableFailed(item, item.dispatchCount, deps.replanBound)
        : undefined;

    assembled.push({
      id: item.id,
      parentId: item.parentId,
      status: item.status,
      level: item.level,
      resolution: resolved?.resolution ?? "met",
      blockedBy: resolved?.blockedBy ?? [],
      recoverable,
      title: item.title,
      blockedReason: item.blockedReason,
    });
  }

  return assembled;
}

/**
 * Builds the run-termination verdict for the current (quiescent) plan state. Reads
 * the plan fresh via assembleRunSummaryItems — the ONE RunSummaryItem[] array that
 * feeds both evaluate() and buildRunSummary() (mig7-t1) — using the SAME replan bound
 * the FailureRouter enforces so `recoverable` never drifts. `budgetExhausted` is the
 * caller's live Budget.isExhausted() verdict (termination only READS the policy). The
 * summary is built only on a `stop` decision; the caller decides whether to act on it.
 */
export async function evaluateRunTermination(
  deps: CoreLoopDeps,
  budgetExhausted: boolean,
): Promise<TerminationOutcome> {
  const items = await assembleRunSummaryItems({
    workItemRepo: deps.workItemRepo,
    replanBound: deps.failureRouter.replanBound,
  });
  // Open contract coverage gaps (mig9-t2). Always COMPUTED (for the summary's
  // visibility, out-of-scope inventions included) but only the BLOCKING ones are fed
  // to the completeness check, and only when ENFORCING — observe-only reports gaps
  // without letting them block the run, and an out-of-scope gap (r12-t1) is never
  // counted so it cannot deadlock a fully-built run. Zero LLM: reads the contract.
  const endpointGaps = await currentCoverageGaps(deps);
  const openCoverageGaps = deps.config.coverageEnforcing
    ? endpointGaps.filter(isBlockingCoverageGap).length
    : 0;
  const decision = evaluate({ items, budgetExhausted, openCoverageGaps });
  const summary = decision.decision === "stop" ? buildRunSummary({ items, endpointGaps }, decision) : null;
  return { decision, summary };
}

/** Open contract coverage gaps across all projects at the current plan state. */
async function currentCoverageGaps(deps: CoreLoopDeps): Promise<EndpointCoverageGap[]> {
  if (!deps.contractRepo) return [];
  const items = await deps.workItemRepo.listAll();
  const roots = items.filter((item) => item.parentId === undefined);
  const gaps: EndpointCoverageGap[] = [];
  for (const root of roots) {
    const contract = await deps.contractRepo.getLatest(parseProjectId(root.id));
    gaps.push(...computeCoverageGaps(contract, items));
  }
  return gaps;
}
