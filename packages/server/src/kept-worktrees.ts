import type { WorkItemRepository } from "@ashara/delivery";
import { OPEN_WORK_ITEM_STATUSES } from "@ashara/delivery/work-item";
import { sweepOrphanedWorktrees } from "@ashara/execution-infra";

/**
 * The reader of the task ids whose worktree the startup sweep keeps: every open task, since any of
 * them may still be attempted, and the sweep keeps more rather than remove a directory an attempt
 * may read. Ids only: a row whose jsonb does not parse still keeps its worktree.
 */
function keptWorktreeTaskIds(workItemRepo: Pick<WorkItemRepository, "listIdsByStatus">): () => Promise<readonly string[]> {
  return () => workItemRepo.listIdsByStatus(OPEN_WORK_ITEM_STATUSES);
}

/** The one sweep of task worktrees at boot: each one under `workdirBase` no open task of Delivery's work items keeps is removed. */
export function sweepWorktreesAtStartup(workdirBase: string, workItemRepo: Pick<WorkItemRepository, "listIdsByStatus">): ReturnType<typeof sweepOrphanedWorktrees> {
  return sweepOrphanedWorktrees(workdirBase, keptWorktreeTaskIds(workItemRepo));
}
