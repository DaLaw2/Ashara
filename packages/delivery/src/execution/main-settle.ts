import type { DomainEvent } from "@ashara/shared";
import { describeErrorChain } from "@ashara/shared";
import type { StoredBlockedReason } from "../work-item-language/blocked-reason.js";
import { InvalidStatusTransition } from "../work-item-language/transitions.js";
import type { WorkItem } from "../domain/index.js";
import { PlanningService, blockWorkItem } from "../domain/index.js";
import { releaseMergedTask } from "../orphan-merge.js";
import type { MainHoldsNoMerge } from "../requeue-on-main.js";
import { chargeUnreadMain, readMainForMerge } from "../requeue-on-main.js";
import { publishBestEffort } from "./audit-events.js";
import { MERGE_RECORD_BACKOFF_MS, recordMergeWithRetry } from "./merge-record.js";
import { reopen } from "./reopen.js";
import type { ExecutionRoutingDeps } from "./routing-deps.js";

/** The block a dispatch parks a task with: the loop takes its exit by itself (parked-exits.ts). */
export type ParkedReason = Extract<StoredBlockedReason, { source: "merge_unrecorded" | "orphan_unreconciled" }>;

/**
 * Parks the item at Blocked with the stated reason, and returns `parked` once that block is written.
 * An item that is no longer InProgress (moved by the owner during dispatch) is left where it is, and
 * `moved` returned: no agent ran, so there is no result to salvage.
 */
export async function routeAsParked(deps: ExecutionRoutingDeps, taskId: WorkItem["id"], reason: ParkedReason): Promise<"parked" | "moved"> {
  const written = await reopen(deps, {
    taskId,
    site: "execution.routeAsParked",
    vanished: `work item vanished before it could be blocked (${reason.reason})`,
    transition: (item) => blockWorkItem(item, reason),
    transitionRejected: (e) => ({
      message: `${reason.source} block rejected (${e.from} -> Blocked); item left at ${e.from} (${reason.reason})`,
      to: "Blocked",
      source: reason.source,
    }),
    plan: () => ({
      before: [],
      write: { kind: "save" },
      rejected: null,
      log: () =>
        deps.logger.info(
          "delivery.task-parked",
          reason.source === "merge_unrecorded"
            ? `blocked, merge ${reason.mergeCommit} unrecorded, the loop writes it again each cycle: ${reason.reason}`
            : `blocked, main unread for its merge (${reason.step}), the loop reads it again each cycle: ${reason.reason}`,
          { taskId, source: reason.source },
        ),
    }),
  });
  return written === "written" ? "parked" : "moved";
}

/**
 * Main read for the task's merge before a dispatch that stopped short of its routing sends it back
 * to Pending (`why`): Z0 commits the merge on main and only then reads its id and writes the record,
 * so a dispatch stopped after the commit leaves merged work behind, and a requeue would redo it.
 * Main is read within the merge record's bound. The evidence that main holds no merge is returned
 * for the requeue. Otherwise the task is settled here and null returned: a merge found is recorded,
 * its worktree and branch released, and the task Completed (or parked merge_unrecorded when the
 * record cannot be written); main that cannot be read parks the task orphan_unreconciled, whose
 * exit reads main again each cycle, under the one policy for an unread main (chargeUnreadMain): a
 * transient fault retried within the task's infrastructure fault budget, a refused workspace path
 * halting the project at once. A task that moved before it could be parked, or before its charge
 * (the owner abandoned it), is no longer at work, and nothing is charged for it.
 */
export async function mainHoldsNoMergeOf(deps: ExecutionRoutingDeps, task: WorkItem, why: string): Promise<MainHoldsNoMerge | null> {
  const read = await readMainForMerge(deps, task, MERGE_RECORD_BACKOFF_MS);
  if (read.kind === "absent") return read.absent;
  if (read.kind === "unread") {
    const step = `read main for the task's merge before it goes back to Pending after ${why}`;
    const parked = await routeAsParked(deps, task.id, { source: "orphan_unreconciled", faultClass: "ashara", step, reason: describeErrorChain(read.error.cause) });
    if (parked === "parked") await chargeUnreadMain(deps, task, step, read);
    return null;
  }
  const merge = read.mergeCommit;
  deps.logger.info("delivery.merged-before-requeue", `its dispatch stopped after merging it on main as ${merge} (${why}): recorded and Completed, never requeued`, {
    taskId: task.id,
    mergeCommit: merge,
  });
  const unrecorded = await recordMergeWithRetry(deps, task.id, merge, "merged");
  if (unrecorded !== null) {
    await routeAsParked(deps, task.id, { source: "merge_unrecorded", mergeCommit: merge, mergeKind: "merged", reason: `merged on main as ${merge}, but the merge record could not be written: ${unrecorded}` });
    return null;
  }
  await releaseMergedTask(deps.projects, deps.workdirBase, task, "merged", deps.logger);
  try {
    await routeAsSuccess(deps, task, MERGE_RECORD_BACKOFF_MS.length + 1);
  } catch (e) {
    // eslint-disable-next-line no-restricted-syntax -- not a reopen: merged work whose completion is rejected stays where the item moved, never parked or requeued
    if (e instanceof InvalidStatusTransition) {
      deps.logger.warn("delivery.transition-rejected", `merged as ${merge} and recorded; its completion was rejected (${e.from} -> Completed), left at ${e.from}`, {
        taskId: task.id,
        from: e.from,
        to: "Completed",
      }, e);
      return null;
    }
    const reason = `merged on main as ${merge} and recorded, but the task could not be Completed: ${describeErrorChain(e)}`;
    await routeAsParked(deps, task.id, { source: "merge_unrecorded", mergeCommit: merge, mergeKind: "merged", reason });
  }
  return null;
}

/**
 * Completes the task, within `attempts` (the waits between them MERGE_RECORD_BACKOFF_MS's). An
 * InvalidStatusTransition is an answer, never retried: the item moved; the last other error throws.
 */
export async function routeAsSuccess(deps: ExecutionRoutingDeps, task: WorkItem, attempts: number): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    let events: DomainEvent[];
    try {
      // The Completed transition is committed before its events return: a publish failure after it
      // must not route a merged, Completed task as failed.
      events = await PlanningService.route(deps.workItemRepo, task.id, "passed");
    } catch (e) {
      const wait = MERGE_RECORD_BACKOFF_MS[attempt - 1];
      // eslint-disable-next-line no-restricted-syntax -- not a reopen: a rejected completion is the caller's answer, never retried
      if (e instanceof InvalidStatusTransition || attempt >= attempts || wait === undefined) throw e;
      deps.logger.warn("delivery.completion-retry", `completion failed on attempt ${attempt} of ${attempts}; retrying in ${wait}ms`, { taskId: task.id, attempt, attempts }, e);
      await new Promise((resolve) => setTimeout(resolve, wait));
      continue;
    }
    await publishBestEffort(deps, task.id, events, "execution.routeAsSuccess");
    return;
  }
}
