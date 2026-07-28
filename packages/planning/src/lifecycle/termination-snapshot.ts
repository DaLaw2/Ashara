import type { WorkItem, WorkItemRepository } from "../domain/index.js";
import { resolvePlanDependencies } from "../domain/index.js";
import type { RunSummaryItem } from "./run-summary.js";

export interface SnapshotAssemblyDeps {
  readonly workItemRepo: WorkItemRepository;
  readonly replanBound: number;
}

export function isRecoverableFailed(
  item: Pick<WorkItem, "status">,
  priorAttempts: number,
  replanBound: number,
): boolean {
  return item.status === "Failed" && priorAttempts < replanBound;
}

export async function assembleRunSummaryItems(deps: SnapshotAssemblyDeps): Promise<RunSummaryItem[]> {
  const { items, resolution } = await resolvePlanDependencies(deps.workItemRepo);

  const assembled: RunSummaryItem[] = [];
  for (const item of items) {
    const resolved = resolution.get(item.id);
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
      runScope: item.runScope,
    });
  }

  return assembled;
}
