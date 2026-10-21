import type { Logger } from "@ashara/shared";
import { describeErrorChain } from "@ashara/shared";
import type { MergeKind } from "../work-item-language/blocked-reason.js";
import type { WorkItem, WorkItemRepository } from "../domain/index.js";

/** Policy: the waits between attempts at the merge record; three attempts in all. */
export const MERGE_RECORD_BACKOFF_MS: readonly number[] = [250, 1000];

/**
 * Writes the task's merge record, retrying with bounded backoff. Null once it is written; the
 * last attempt's error, described, when every attempt failed.
 */
export async function recordMergeWithRetry(
  deps: { readonly workItemRepo: Pick<WorkItemRepository, "recordMergeCommit">; readonly logger: Logger },
  taskId: WorkItem["id"],
  mergeCommit: string,
  kind: MergeKind,
): Promise<string | null> {
  let last = "";
  for (let attempt = 1; attempt <= MERGE_RECORD_BACKOFF_MS.length + 1; attempt++) {
    try {
      await deps.workItemRepo.recordMergeCommit(taskId, mergeCommit, kind);
      if (attempt > 1) deps.logger.info("delivery.merge-recorded-late", `merge record for ${mergeCommit} written on attempt ${attempt}`, { taskId, mergeCommit, attempt });
      return null;
    } catch (e) {
      // eslint-disable-next-line ashara/catch-continue -- best effort: one attempt of a bounded retry; the last attempt's error is kept and returned below, where the caller parks the task merge_unrecorded
      last = describeErrorChain(e);
      const wait = MERGE_RECORD_BACKOFF_MS[attempt - 1];
      deps.logger.warn(
        "delivery.merge-record-failed",
        `merge record for ${mergeCommit} failed on attempt ${attempt} of ${MERGE_RECORD_BACKOFF_MS.length + 1}` +
          `${wait === undefined ? "; giving up" : `; retrying in ${wait}ms`}`,
        { taskId, mergeCommit, attempt },
        e,
      );
      if (wait !== undefined) await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  return last;
}
