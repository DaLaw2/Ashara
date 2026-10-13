import type { EventStoreRepository } from "@ashara/db";
import type { DomainEvent, ProjectId } from "@ashara/shared";
import { blockedExitOf, InvalidStatusTransition, WorkItemRowCorrupt } from "@ashara/shared";
import type { WorkItem, WorkItemRepository } from "./acl/planning-acl.js";
import { PlanningService, takeEvents, unblockWorkItem } from "./acl/planning-acl.js";

// The automatic exits of Blocked work items (story s-loop-never-stop-m1, Discipline B): a block
// whose cause can clear by itself is re-checked every cycle and released to Pending once it has;
// a merged task whose merge record was not written has the record written again, then Completed.
// Every other block waits on the operator's unblock (PATCH /work-items/:id/status), and the
// Liaison's report on the task says so (shared blockedExitOf decides which is which).

/** What the automatic exits read; the composition root supplies it. */
export interface ParkedExitChecks {
  /** The project's latest roster revision; null when it has none. */
  latestRosterRevision(projectId: ProjectId): Promise<number | null>;
  /**
   * Whether the environment version on the project's main has its statement and a succeeded
   * build; false when the project has no workspace yet.
   */
  environmentBuilt(projectId: ProjectId): Promise<boolean>;
}

interface ParkedExitDeps {
  readonly workItemRepo: WorkItemRepository;
  readonly eventStore: Pick<EventStoreRepository, "publish">;
  readonly projects: { listActiveIds(): Promise<ProjectId[]> };
  readonly checks: ParkedExitChecks;
}

/** Each check is read at most once per project per cycle. */
class ProjectChecks {
  private revision: Promise<number | null> | undefined;
  private built: Promise<boolean> | undefined;

  constructor(
    private readonly checks: ParkedExitChecks,
    private readonly projectId: ProjectId,
  ) {}

  latestRosterRevision(): Promise<number | null> {
    this.revision ??= this.checks.latestRosterRevision(this.projectId);
    return this.revision;
  }

  environmentBuilt(): Promise<boolean> {
    this.built ??= this.checks.environmentBuilt(this.projectId);
    return this.built;
  }
}

async function causeCleared(item: WorkItem, checks: ProjectChecks): Promise<boolean> {
  const exit = blockedExitOf(item.blockedReason);
  switch (exit.kind) {
    case "operator":
      return false;
    case "merge-recorded":
      // Its exit is to Completed, not Pending: releaseClearedBlocks takes it before this check.
      return false;
    case "roster-revision": {
      const latest = await checks.latestRosterRevision();
      return latest !== null && (exit.decidedAgainst === null || latest > exit.decidedAgainst);
    }
    case "environment-built":
      return checks.environmentBuilt();
  }
}

/**
 * Releases to Pending every Blocked task of an active project whose automatic exit has cleared,
 * publishing its work_item.unblocked event. A check that throws leaves the task Blocked
 * (fail-closed) and is logged at warn; the project's other tasks are still checked. A project
 * whose Blocked rows do not parse is skipped here: the gate blocks it this same cycle. A
 * merge_unrecorded task is Completed instead once its merge record is written. Returns how many
 * tasks were released or completed.
 */
export async function releaseClearedBlocks(deps: ParkedExitDeps): Promise<number> {
  let released = 0;
  for (const projectId of await deps.projects.listActiveIds()) {
    let blocked: WorkItem[];
    try {
      blocked = await deps.workItemRepo.findByProjectAndStatus(projectId, "Blocked");
    } catch (err) {
      if (!(err instanceof WorkItemRowCorrupt)) throw err;
      console.warn(`[parked-exits] project ${projectId}: ${err.message}; its Blocked tasks are not re-checked`);
      continue;
    }
    const checks = new ProjectChecks(deps.checks, projectId);
    for (const item of blocked) {
      const exit = blockedExitOf(item.blockedReason);
      if (exit.kind === "merge-recorded") {
        if (await completeRecordedMerge(deps, item, exit.mergeCommit)) released++;
        continue;
      }
      let cleared: boolean;
      try {
        cleared = await causeCleared(item, checks);
      } catch (err) {
        console.warn(`[parked-exits] task ${item.id}: its exit could not be checked; it stays Blocked:`, err);
        continue;
      }
      if (cleared && (await release(deps, item))) released++;
    }
  }
  return released;
}

/**
 * A merged task whose merge record could not be written: the record is written again, and once
 * it holds the task is Completed (never Pending: its work is on main). A write that fails leaves
 * it Blocked for the next cycle.
 */
async function completeRecordedMerge(deps: ParkedExitDeps, item: WorkItem, mergeCommit: string): Promise<boolean> {
  try {
    await deps.workItemRepo.recordMergeCommit(item.id, mergeCommit);
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

async function publishAll(deps: ParkedExitDeps, taskId: WorkItem["id"], events: readonly DomainEvent[]): Promise<void> {
  for (const event of events) {
    try {
      await deps.eventStore.publish(event);
    } catch (err) {
      console.warn(`[parked-exits] task ${taskId}: failed to publish ${event.eventType} (the transition is committed):`, err);
    }
  }
}

async function release(deps: ParkedExitDeps, item: WorkItem): Promise<boolean> {
  const source = item.blockedReason?.source ?? "none";
  unblockWorkItem(item, { kind: "exit-cleared" });
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
