import type { EventStoreRepository } from "@ashara/db";
import type { DomainEvent, MergeKind, ProjectId } from "@ashara/shared";
import { blockedExitOf, describeErrorChain, InvalidStatusTransition, WorkItemRowCorrupt } from "@ashara/shared";
import type { WorkItem, WorkItemRepository } from "./acl/planning-acl.js";
import { giveUpWorkItem, PlanningService, takeEvents, unblockWorkItem } from "./acl/planning-acl.js";
import { mergeOnMainOf } from "./orphan-merge.js";
import type { TargetPathSource } from "./orphan-merge.js";

// The exits of Blocked work items (story s-loop-never-stop-m1, Discipline B; W6: no work item waits
// on a person), each taken by the loop every cycle: a merged task whose merge record was not written
// has the record written again, then Completed; a crash orphan the startup reconciler could not
// settle has main read again, then Completed with its merge or back to Pending; an infrastructure block (written before migration
// 048) goes back to Pending at once; any other block (written before migration 048, or with no
// reason) has no cause that clears by itself, so the task is given up and its plan repaired.
// Shared blockedExitOf decides which is which.

interface ParkedExitDeps {
  readonly workItemRepo: WorkItemRepository;
  readonly eventStore: Pick<EventStoreRepository, "publish">;
  /** `get` names the target whose main an orphan_unreconciled task's merge is read from. */
  readonly projects: { listActiveIds(): Promise<ProjectId[]> } & TargetPathSource;
}

/**
 * Takes the exit of every Blocked task of an active project, publishing its events: a
 * merge_unrecorded task is Completed once its merge record is written, an infrastructure block is
 * released to Pending, and any other block is given up. A project whose Blocked rows do not parse
 * is skipped here: the gate blocks it this same cycle. Returns how many tasks left Blocked.
 */
export async function releaseClearedBlocks(deps: ParkedExitDeps): Promise<number> {
  let released = 0;
  for (const projectId of await deps.projects.listActiveIds()) {
    let blocked: WorkItem[];
    try {
      blocked = await deps.workItemRepo.findByProjectAndStatus(projectId, "Blocked");
    } catch (err) {
      if (!(err instanceof WorkItemRowCorrupt)) throw err;
      console.warn(`[parked-exits] project ${projectId}: ${describeErrorChain(err)}; its Blocked tasks are not re-checked`);
      continue;
    }
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
      }
      if (left) released++;
    }
  }
  return released;
}

/**
 * A merged task whose merge record could not be written: the record is written again, and once
 * it holds the task is Completed (never Pending: its work is on main). A write that fails leaves
 * it Blocked for the next cycle.
 */
async function completeRecordedMerge(deps: ParkedExitDeps, item: WorkItem, mergeCommit: string, mergeKind: MergeKind | null): Promise<boolean> {
  try {
    await deps.workItemRepo.recordMergeCommit(item.id, mergeCommit, mergeKind);
  } catch (err) {
    console.warn(`[parked-exits] task ${item.id}: the record of merge ${mergeCommit} still cannot be written; it stays Blocked:`, err);
    return false;
  }
  let events: DomainEvent[];
  try {
    events = await PlanningService.completeRecordedMerge(deps.workItemRepo, item);
  } catch (err) {
    if (!(err instanceof InvalidStatusTransition)) throw err;
    console.warn(`[parked-exits] task ${item.id}: merge ${mergeCommit} recorded, but not completed: it changed concurrently (${err.from} -> ${err.to})`);
    return false;
  }
  console.log(`[parked-exits] task ${item.id}: merge ${mergeCommit} recorded; Completed`);
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
    merge = await mergeOnMainOf(deps.projects, item);
  } catch (err) {
    console.warn(`[parked-exits] task ${item.id}: main still cannot be read for its merge; it stays Blocked:`, err);
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
      console.warn(`[parked-exits] task ${taskId}: failed to publish ${event.eventType} (the transition is committed):`, err);
    }
  }
}

/**
 * A block with no exit that clears by itself: the task is given up with the cause it was blocked
 * for (a Blocked item with none is recorded as an orchestrator error, the state no writer should
 * have left), and its abandonment opens a plan repair (migration 048).
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
    console.warn(`[parked-exits] task ${item.id}: not given up, it changed concurrently (${err.from} -> ${err.to})`);
    return false;
  }
  console.warn(`[parked-exits] task ${item.id}: its ${cause.source} block has no exit that clears by itself; given up, its plan is repaired`);
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
    console.warn(`[parked-exits] task ${item.id}: not released, it changed concurrently (${err.from} -> ${err.to})`);
    return false;
  }
  console.log(`[parked-exits] task ${item.id}: its ${source} block cleared; back to Pending`);
  await publishAll(deps, item.id, takeEvents(item));
  return true;
}
