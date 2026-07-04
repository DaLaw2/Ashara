import type { EventStoreRepository } from "@ashara/db";
import type { WorkItem, WorkItemRepository } from "@ashara/planning-domain";
import { createTask } from "@ashara/planning-domain";
import type { RawFailureContext } from "@ashara/planning";

import { applyAbandon } from "./failure-recovery.js";

/**
 * Split-on-failure escape hatch (granularity-debate.md §5 File 6, the
 * Evolutionary Architect position): a coarse vertical-slice task that burns an
 * excessive number of agent turns is too big for one session, not just
 * unlucky — retrying it identically (the normal FailureRouter replan path)
 * reproduces the same overrun. Splitting it into two smaller tasks is the
 * decomposition-level fix.
 */
/**
 * True when a Failed task should be split instead of routed through the
 * normal FailureRouter (replan/substitute/abandon). Signal: the agent hit
 * its turn limit while making progress (files changed) — structurally "too
 * big," not a specific bug. Capped at depth 1 via `splitDepth`.
 */
export function shouldSplit(
  finishReason: string,
  filesChanged: number,
  task: Pick<WorkItem, "taskSpec">,
): boolean {
  const alreadySplit = typeof task.taskSpec?.splitDepth === "number" && (task.taskSpec.splitDepth as number) > 0;
  return finishReason === "turn_limit" && filesChanged > 0 && !alreadySplit;
}

function splitDeliverables(deliverables: unknown): [string[], string[]] {
  const list = Array.isArray(deliverables) ? deliverables.filter((d): d is string => typeof d === "string") : [];
  if (list.length >= 2) {
    const mid = Math.ceil(list.length / 2);
    return [list.slice(0, mid), list.slice(mid)];
  }
  // Too few deliverables to split by content — fall back to a generic
  // part-1/part-2 split; both subtasks see the full deliverable list plus the
  // failure detail (recorded as a failed-approach lesson by the caller) so
  // part 2 picks up where part 1's partial work left off.
  return [list, list];
}

export interface TaskSplitDeps {
  readonly workItemRepo: WorkItemRepository;
  readonly eventStore: Pick<EventStoreRepository, "publish">;
}

/**
 * Splits a Failed, over-budget task into two Pending subtasks and abandons the
 * original via the substitute mechanism: part 2 depends on part 1
 * (sequential — inherits part 1's partial work), and the abandoned original's
 * `substitutedBy` points at part 2, so `DependencyGraph`'s existing
 * substitution rule (dependency.ts) resolves the original's dependents once
 * BOTH parts complete — no dependency-graph or repository changes needed.
 */
export async function splitFailedTask(
  deps: TaskSplitDeps,
  task: WorkItem,
  failure: RawFailureContext,
): Promise<void> {
  const spec = task.taskSpec ?? {};
  const [firstHalf, secondHalf] = splitDeliverables(spec.deliverables);
  const prerequisiteIds = await deps.workItemRepo.getDependencies(task.id);

  const partA = createTask(`${task.title} (part 1 of 2)`, task.parentId, {
    ...spec,
    deliverables: firstHalf,
    splitDepth: 1,
    splitFrom: task.id,
  });
  const partB = createTask(`${task.title} (part 2 of 2)`, task.parentId, {
    ...spec,
    deliverables: secondHalf,
    splitDepth: 1,
    splitFrom: task.id,
  });

  await deps.workItemRepo.withTransaction(async (repo) => {
    await repo.create(partA);
    await repo.create(partB);
    for (const depId of prerequisiteIds) {
      await repo.addDependency(partA.id, depId);
    }
    await repo.addDependency(partB.id, partA.id);
  });

  await applyAbandon(deps, task, {
    reason: "split into 2 subtasks: agent hit turn limit with partial progress",
    substitutedBy: partB.id,
    attempts: task.dispatchCount,
    lastFailure: failure,
    source: "split_on_failure",
  });
}
