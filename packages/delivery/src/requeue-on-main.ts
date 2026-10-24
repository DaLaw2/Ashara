import type { Logger } from "@ashara/shared";
import type { WorkItem } from "./domain/index.js";
import { requeueWorkItem, resumeOnAnswer, unblockWorkItem } from "./domain/index.js";
import { mergeOnMainOf } from "./orphan-merge.js";
import type { TargetPathSource } from "./orphan-merge.js";

// A dispatch can merge its work on main and stop before its merge record is written (a fault, a
// shutdown, a refusal, a dead process). A task sent back to Pending without reading main would
// have that work dispatched again. So every return to Pending after a dispatch started reads main
// here first, and the transition itself takes the read's answer: only a read that found no merge
// of the task yields the value returnToPending requires.

const noMerge: unique symbol = Symbol("main holds no merge of the task");

/** Main was read for this task's merge and holds none: what returnToPending requires. */
export interface MainHoldsNoMerge {
  readonly taskId: WorkItem["id"];
  readonly [noMerge]: true;
}

/** Main could not be read for a task's merge within the attempts given. */
class MainUnread extends Error {
  constructor(
    readonly taskId: WorkItem["id"],
    readonly attempts: number,
    options: { readonly cause: unknown },
  ) {
    super(`main could not be read for a merge of task ${taskId} in ${attempts} attempt(s)`, options);
    this.name = "MainUnread";
  }
}

/** A task's merge on main: the merge found, none (with the evidence a requeue takes), or main unread. */
export type MainRead =
  | { readonly kind: "merged"; readonly mergeCommit: string }
  | { readonly kind: "absent"; readonly absent: MainHoldsNoMerge }
  | { readonly kind: "unread"; readonly error: MainUnread };

/** Where a task's main is read from. */
export interface MainReadDeps {
  readonly projects: TargetPathSource;
  /** The workdir base every target workspace lies in (assertValidTargetProjectPath). */
  readonly workdirBase: string;
  readonly logger: Logger;
}

/**
 * Reads main for `item`'s merge (mergeOnMainOf), once and again after each of `waitsMs`. A read
 * that fails is never "nothing merged": every attempt failing is `unread`, and the caller keeps the
 * task off Pending.
 */
export async function readMainForMerge(deps: MainReadDeps, item: WorkItem, waitsMs: readonly number[]): Promise<MainRead> {
  const attempts = waitsMs.length + 1;
  let last: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const merge = await mergeOnMainOf(deps.projects, deps.workdirBase, item);
      return merge === null ? { kind: "absent", absent: { taskId: item.id, [noMerge]: true } } : { kind: "merged", mergeCommit: merge };
    } catch (e) {
      // eslint-disable-next-line ashara/catch-continue -- best effort: one attempt of a bounded retry; the last error is kept and returned as MainUnread below, which keeps the task off Pending
      last = e;
      const wait = waitsMs[attempt - 1];
      deps.logger.warn("delivery.main-unread", `main could not be read for its merge on attempt ${attempt} of ${attempts}`, { taskId: item.id, attempt, attempts }, e);
      if (wait !== undefined) await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  return { kind: "unread", error: new MainUnread(item.id, attempts, { cause: last }) };
}

/** A main read's answer handed to the transition of another task. */
class MainReadOfAnotherTask extends Error {
  constructor(
    readonly taskId: WorkItem["id"],
    readonly readFor: WorkItem["id"],
  ) {
    super(`task ${taskId} cannot go back to Pending on the main read of task ${readFor}`);
    this.name = "MainReadOfAnotherTask";
  }
}

/**
 * Moves `item` back to Pending by the domain function of its status: an InProgress item is
 * requeued, a task held for the client's answer resumes on it, any other Blocked item is unblocked.
 * Each throws InvalidStatusTransition when the item cannot take it.
 */
export function returnToPending(item: WorkItem, absent: MainHoldsNoMerge): void {
  if (absent.taskId !== item.id) throw new MainReadOfAnotherTask(item.id, absent.taskId);
  if (item.status !== "Blocked") {
    requeueWorkItem(item);
    return;
  }
  if (item.blockedReason?.source === "awaiting_client") {
    resumeOnAnswer(item);
    return;
  }
  unblockWorkItem(item);
}
