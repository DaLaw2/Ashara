import type { WorkItem, WorkItemRepository } from "../domain/index.js";
import { createTask } from "../domain/index.js";
import type { RawFailureContext } from "../failure-router.js";
import type { EventPublisher } from "./ports.js";
import { applyAbandon } from "./failure-recovery.js";

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
  return [list, list];
}

export interface TaskSplitDeps {
  readonly workItemRepo: WorkItemRepository;
  readonly eventPublisher: EventPublisher;
  readonly runScope: string;
}

export async function splitFailedTask(
  deps: TaskSplitDeps,
  task: WorkItem,
  failure: RawFailureContext,
): Promise<void> {
  const spec = task.taskSpec ?? {};
  const [firstHalf, secondHalf] = splitDeliverables(spec.deliverables);
  const prerequisiteIds = await deps.workItemRepo.getDependencies(task.id);

  const partA = createTask(`${task.title} (part 1 of 2)`, deps.runScope, task.parentId, {
    ...spec,
    deliverables: firstHalf,
    splitDepth: 1,
    splitFrom: task.id,
  });
  const partB = createTask(`${task.title} (part 2 of 2)`, deps.runScope, task.parentId, {
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
