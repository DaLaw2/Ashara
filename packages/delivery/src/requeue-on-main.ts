import type { Logger, ProjectId } from "@ashara/shared";
import type { WorkItem, WorkItemRepository } from "./domain/index.js";
import { requeueWorkItem, resumeOnAnswer, unblockWorkItem } from "./domain/index.js";
import { InvalidTargetProjectPath } from "./acl/execution-infra-acl.js";
import { INFRASTRUCTURE_FAULT_BUDGET } from "./execution/halt-causes.js";
import { mergeOnMainOf, OrphanUnreconciled } from "./orphan-merge.js";
import type { TargetPathSource } from "./orphan-merge.js";
import { projectBlockCause } from "./project-halt.js";
import type { ProjectBlockCause } from "./project-halt.js";

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

/**
 * Why main went unread: `configuration` when the target's recorded workspace path is refused, which
 * no retry clears; `transient` for every other failure (git, the filesystem, the store).
 */
type MainUnreadFault = "transient" | "configuration";

/** Main read for a task's merge and not answered. */
export interface MainUnreadRead {
  readonly kind: "unread";
  readonly error: MainUnread;
  readonly fault: MainUnreadFault;
}

/** A task's merge on main: the merge found, none (with the evidence a requeue takes), or main unread. */
export type MainRead =
  | { readonly kind: "merged"; readonly mergeCommit: string }
  | { readonly kind: "absent"; readonly absent: MainHoldsNoMerge }
  | MainUnreadRead;

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
 * task off Pending. A refused workspace path is not retried: it is `unread` at once, as a
 * configuration fault.
 */
export async function readMainForMerge(deps: MainReadDeps, item: WorkItem, waitsMs: readonly number[]): Promise<MainRead> {
  const attempts = waitsMs.length + 1;
  let last: unknown = null;
  let tried = 0;
  while (tried < attempts && !(last instanceof InvalidTargetProjectPath)) {
    tried++;
    try {
      const merge = await mergeOnMainOf(deps.projects, deps.workdirBase, item);
      return merge === null ? { kind: "absent", absent: { taskId: item.id, [noMerge]: true } } : { kind: "merged", mergeCommit: merge };
    } catch (e) {
      // eslint-disable-next-line ashara/catch-continue -- best effort: one attempt of a bounded retry; the last error is kept and returned as MainUnread below, which keeps the task off Pending
      last = e;
      const wait = e instanceof InvalidTargetProjectPath ? undefined : waitsMs[tried - 1];
      deps.logger.warn("delivery.main-unread", `main could not be read for its merge on attempt ${tried} of ${attempts}`, { taskId: item.id, attempt: tried, attempts }, e);
      if (wait !== undefined) await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  const fault: MainUnreadFault = last instanceof InvalidTargetProjectPath ? "configuration" : "transient";
  return { kind: "unread", error: new MainUnread(item.id, tried, { cause: last }), fault };
}

/** Where a main read that failed is counted, and the project halted. */
export interface UnreadMainDeps {
  readonly workItemRepo: Pick<WorkItemRepository, "recordInfrastructureFault">;
  readonly projects: { block(projectId: ProjectId, cause: ProjectBlockCause): Promise<"blocked" | "already-blocked"> };
  readonly logger: Logger;
}

/**
 * The one policy for a main read that failed, applied once the task is kept off Pending for it
 * (Blocked orphan_unreconciled, whose exit reads main again each cycle). A configuration fault halts
 * the project at once: a retry meets the same refused path. A transient one is counted on the
 * task's infrastructure faults, durably, so its retries survive a restart and stay within
 * INFRASTRUCTURE_FAULT_BUDGET; the read past it halts the project on Ashara's own fault. A count
 * that cannot be written throws: the task stays where the caller kept it, off Pending, and its exit
 * reads main again. Returns whether the project halted.
 */
export async function chargeUnreadMain(deps: UnreadMainDeps, task: WorkItem, step: string, read: MainUnreadRead): Promise<"retried" | "halted"> {
  const unread = new OrphanUnreconciled(task.id, step, read.error.attempts, { cause: read.error.cause });
  if (read.fault === "transient") {
    const faults = await deps.workItemRepo.recordInfrastructureFault(task.id);
    if (faults <= INFRASTRUCTURE_FAULT_BUDGET) {
      deps.logger.warn(
        "delivery.main-unread-retried",
        `kept off Pending, main is read again next cycle: fault ${faults} of ${INFRASTRUCTURE_FAULT_BUDGET} (${step})`,
        { taskId: task.id, faults },
        unread,
      );
      return "retried";
    }
  }
  const halted = await deps.projects.block(task.projectId, projectBlockCause(unread));
  deps.logger.error("delivery.project-halted", `project ${task.projectId} ${halted} on Ashara's own fault (${read.fault}): ${unread.message}`, {
    taskId: task.id,
    projectId: task.projectId,
    faultClass: "ashara",
    result: halted,
  }, unread);
  return "halted";
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
