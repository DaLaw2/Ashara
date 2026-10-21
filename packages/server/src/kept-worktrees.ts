import type { WorkItemRepository } from "@ashara/delivery";
import { OPEN_WORK_ITEM_STATUSES } from "@ashara/delivery/work-item";

/**
 * The reader of the task ids whose worktree the startup sweep keeps: every open task, since any of
 * them may still be attempted, and the sweep keeps more rather than remove a directory an attempt
 * may read. Ids only: a row whose jsonb does not parse still keeps its worktree.
 */
export function keptWorktreeTaskIds(workItemRepo: Pick<WorkItemRepository, "listIdsByStatus">): () => Promise<readonly string[]> {
  return () => workItemRepo.listIdsByStatus(OPEN_WORK_ITEM_STATUSES);
}
