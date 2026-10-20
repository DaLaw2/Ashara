import type { EventStoreRepository } from "@ashara/db";
import type { DomainEvent, Logger, ProjectId, StepContainment } from "@ashara/shared";
import { containEach } from "@ashara/shared";
import type { MergeKind } from "./work-item-language/blocked-reason.js";
import { blockedExitOf } from "./work-item-language/blocked-reason.js";
import { InvalidStatusTransition } from "./work-item-language/transitions.js";
import { WorkItemRowCorrupt } from "./work-item-language/work-item-row.js";
import type { WorkItem, WorkItemRepository } from "./domain/index.js";
import { giveUpWorkItem, PlanningService, takeEvents, unblockWorkItem } from "./domain/index.js";
import { mergeOnMainOf, releaseMergedTask } from "./orphan-merge.js";
import type { TargetPathSource } from "./orphan-merge.js";

// The exits of Blocked work items (no work item waits on a person), each taken by the loop every
// cycle: a merged task whose merge record was not written has the record written again, then
// Completed; a crash orphan the startup reconciler could not settle has main read again, then
// Completed with its merge or back to Pending; an infrastructure block from a legacy row goes back
// to Pending at once; a task a client's correction holds waits for the correction's plan revision,
// which supersedes it; any other block (from a legacy row, or with no reason) has no cause that
// clears by itself, so the task is given up and its plan repaired.
// Shared blockedExitOf decides which is which.

interface ParkedExitDeps {
  readonly workItemRepo: WorkItemRepository;
  readonly eventStore: Pick<EventStoreRepository, "publish">;
  /** `get` names the target whose main an orphan_unreconciled task's merge is read from. */
  readonly projects: { listActiveIds(): Promise<ProjectId[]> } & TargetPathSource;
  /** The workdir base every target workspace lies in (assertValidTargetProjectPath). */
  readonly workdirBase: string;
  /** Each project's own fault is contained to it (containEach). */
  readonly containment: StepContainment;
  readonly logger: Logger;
}

/**
 * Takes the exit of every Blocked task of an active project, publishing its events: a
 * merge_unrecorded task is Completed once its merge record is written, an infrastructure block is
 * released to Pending, a correction_pending task stays for its revision, and any other block is given up. A project whose Blocked rows do not parse
 * is skipped here: the gate blocks it this same cycle. Any other failure is that project's,
 * contained to it (containEach). Returns how many tasks left Blocked.
 */
export async function releaseClearedBlocks(deps: ParkedExitDeps): Promise<number> {
  const projects = await deps.projects.listActiveIds();
  const released = await containEach(deps.containment, "parked-exits", projects, (projectId) => ({ id: projectId, projectId }), (projectId) => releaseProject(deps, projectId));
  let total = 0;
  for (const outcome of released) if (typeof outcome === "number") total += outcome;
  return total;
}

/** The exits of one project's Blocked tasks; returns how many left Blocked. */
async function releaseProject(deps: ParkedExitDeps, projectId: ProjectId): Promise<number> {
  let blocked: WorkItem[];
  try {
    blocked = await deps.workItemRepo.findByProjectAndStatus(projectId, "Blocked");
  } catch (err) {
    if (!(err instanceof WorkItemRowCorrupt)) throw err;
    deps.logger.warn("delivery.blocked-rows-corrupt", `project ${projectId}: its Blocked tasks are not re-checked`, { projectId }, err);
    // eslint-disable-next-line no-restricted-syntax -- policy default: the pass released no task, which is what it returns; the record above names why
    return 0;
  }
  let released = 0;
  for (const item of blocked) {
    const exit = blockedExitOf(item.blockedReason);
    let left: boolean;
    switch (exit.kind) {
      case "merge-recorded":
        left = await completeRecordedMerge(deps, item, exit.mergeCommit, exit.mergeKind);
        break;
      case "give-up":
        left = await giveUp(deps, item);
        break;
      case "read-main":
        left = await settleOnMain(deps, item);
        break;
      case "requeue":
        left = await release(deps, item);
        break;
      case "await-revision":
        // Held by a client's correction: the revision the replanning step writes for it supersedes it.
        left = false;
        break;
    }
    if (left) released++;
  }
  return released;
}

/**
 * A merged task whose merge record could not be written: the record is written again, and once
 * it holds the worktree and branch no dispatch released are released and the task is Completed
 * (never Pending: its work is on main). A write that fails leaves it Blocked for the next cycle.
 */
async function completeRecordedMerge(deps: ParkedExitDeps, item: WorkItem, mergeCommit: string, mergeKind: MergeKind | null): Promise<boolean> {
  try {
    await deps.workItemRepo.recordMergeCommit(item.id, mergeCommit, mergeKind);
  } catch (err) {
    deps.logger.warn("delivery.merge-record-failed", `the record of merge ${mergeCommit} still cannot be written; it stays Blocked`, { taskId: item.id, mergeCommit }, err);
    // eslint-disable-next-line no-restricted-syntax -- policy default: false is the fail-closed answer, the task stays Blocked; the record above names why
    return false;
  }
  await releaseMergedTask(deps.projects, deps.workdirBase, item, mergeKind, deps.logger);
  let events: DomainEvent[];
  try {
    events = await PlanningService.completeRecordedMerge(deps.workItemRepo, item);
  } catch (err) {
    if (!(err instanceof InvalidStatusTransition)) throw err;
    deps.logger.warn("delivery.transition-rejected", `merge ${mergeCommit} recorded, but not completed: it changed concurrently (${err.from} -> ${err.to})`, {
      taskId: item.id,
      from: err.from,
      to: err.to,
    }, err);
    // eslint-disable-next-line no-restricted-syntax -- policy default: false is the fail-closed answer, the task is not completed; the record above names why
    return false;
  }
  deps.logger.info("delivery.parked-merge-completed", `merge ${mergeCommit} recorded; Completed`, { taskId: item.id, mergeCommit });
  await publishAll(deps, item.id, events);
  return true;
}

/**
 * A crash orphan the startup reconciler could not settle (orphan_unreconciled): main is read again
 * for the task's merge. Found, it is recorded and the task Completed; none, the task goes back to
 * Pending, now that main says nothing of it was merged. Main still unreadable leaves it Blocked for
 * the next cycle: it is never requeued blind.
 */
async function settleOnMain(deps: ParkedExitDeps, item: WorkItem): Promise<boolean> {
  let merge: string | null;
  try {
    merge = await mergeOnMainOf(deps.projects, deps.workdirBase, item);
  } catch (err) {
    deps.logger.warn("delivery.main-unread", "main still cannot be read for its merge; it stays Blocked", { taskId: item.id }, err);
    // eslint-disable-next-line no-restricted-syntax -- policy default: false is the fail-closed answer, the task stays Blocked; the record above names why
    return false;
  }
  if (merge !== null) return completeRecordedMerge(deps, item, merge, "merged");
  return release(deps, item);
}

async function publishAll(deps: ParkedExitDeps, taskId: WorkItem["id"], events: readonly DomainEvent[]): Promise<void> {
  for (const event of events) {
    try {
      await deps.eventStore.publish(event);
    } catch (err) {
      // eslint-disable-next-line ashara/catch-continue -- best effort: the transition is committed before its events are published; domain_events is an operator audit log (GET /events is the bearer route) that no verdict, counter, charge or client text reads
      deps.logger.warn("delivery.event-publish-failed", `failed to publish ${event.eventType} (the transition is committed)`, {
        taskId,
        site: "parked-exits",
        eventType: event.eventType,
      }, err);
    }
  }
}

/**
 * A block with no exit that clears by itself: the task is given up with the cause it was blocked
 * for (a Blocked item with none is recorded as an orchestrator error, the state no writer should
 * have left), and its abandonment opens a plan repair.
 */
async function giveUp(deps: ParkedExitDeps, item: WorkItem): Promise<boolean> {
  const reason = item.blockedReason;
  const cause =
    reason === undefined || reason.source === "superseded"
      ? { source: "orchestrator_error" as const, reason: `Blocked with ${reason === undefined ? "no recorded reason" : "a superseded reason"}; given up` }
      : reason;
  giveUpWorkItem(item, cause);
  try {
    await PlanningService.saveWorkItem(deps.workItemRepo, item, "Blocked");
  } catch (err) {
    if (!(err instanceof InvalidStatusTransition)) throw err;
    deps.logger.warn("delivery.transition-rejected", `not given up, it changed concurrently (${err.from} -> ${err.to})`, { taskId: item.id, from: err.from, to: err.to }, err);
    // eslint-disable-next-line no-restricted-syntax -- policy default: false is the fail-closed answer, the task is not given up this pass; the record above names why
    return false;
  }
  deps.logger.info("delivery.task-given-up", `its ${cause.source} block has no exit that clears by itself; given up, its plan is repaired`, {
    taskId: item.id,
    source: cause.source,
  });
  await publishAll(deps, item.id, takeEvents(item));
  return true;
}

async function release(deps: ParkedExitDeps, item: WorkItem): Promise<boolean> {
  const source = item.blockedReason?.source ?? "none";
  unblockWorkItem(item);
  try {
    await PlanningService.saveWorkItem(deps.workItemRepo, item, "Blocked");
  } catch (err) {
    if (!(err instanceof InvalidStatusTransition)) throw err;
    deps.logger.warn("delivery.transition-rejected", `not released, it changed concurrently (${err.from} -> ${err.to})`, { taskId: item.id, from: err.from, to: err.to }, err);
    // eslint-disable-next-line no-restricted-syntax -- policy default: false is the fail-closed answer, the task is not released; the record above names why
    return false;
  }
  deps.logger.info("delivery.block-cleared", `its ${source} block cleared; back to Pending`, { taskId: item.id, source });
  await publishAll(deps, item.id, takeEvents(item));
  return true;
}
