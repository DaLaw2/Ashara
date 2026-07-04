import type { WorkItem } from "./work-item.js";

/**
 * Marker stamped on a task's `taskSpec.origin` when the task was minted by
 * coverage reconciliation (a backstop gap-filler) rather than by decomposition
 * (the primary plan). Dispatch deprioritizes coverage-origin tasks below
 * plan-origin tasks so contract-declared core work (create/list endpoints, final
 * wiring) can never starve Pending while backstop/duplicate-namespace tasks
 * dispatch (Run-11 starvation: create-todo + wiring never dispatched while
 * spec-derivation /api/auth/* duplicates consumed the budget).
 */
export const COVERAGE_TASK_ORIGIN = "coverage-reconciliation";

/** True when a work item was minted by coverage reconciliation (see COVERAGE_TASK_ORIGIN). */
function isCoverageOrigin(item: WorkItem): boolean {
  return item.taskSpec?.["origin"] === COVERAGE_TASK_ORIGIN;
}

export class TaskSelector {
  static selectBatch(
    available: WorkItem[],
    maxBatchSize: number,
    unlockWeights?: Map<string, number>,
  ): WorkItem[] {
    const sorted = [...available].sort((a, b) => {
      // Plan-origin tasks (decomposition) always outrank coverage-reconciliation
      // backstop tasks, regardless of unlock weight — the primary plan's core
      // endpoints must not starve behind duplicate/out-of-scope coverage fills.
      const aCoverage = isCoverageOrigin(a);
      const bCoverage = isCoverageOrigin(b);
      if (aCoverage !== bCoverage) return aCoverage ? 1 : -1;
      if (unlockWeights) {
        const wa = unlockWeights.get(a.id) ?? 0;
        const wb = unlockWeights.get(b.id) ?? 0;
        if (wa !== wb) return wb - wa;
      }
      return a.createdAt.getTime() - b.createdAt.getTime();
    });
    return sorted.slice(0, maxBatchSize);
  }
}
