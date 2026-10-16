import type { DomainEvent, ProjectId } from "@ashara/shared";
import { describeErrorChain } from "@ashara/shared";
import type { EventStoreRepository } from "@ashara/db";
import type { StoredBlockedReason } from "./work-item-language/blocked-reason.js";
import type { WorkItemStatus } from "./work-item-language/work-item-status.js";
import { blockedReasonToRecord } from "./work-item-language/blocked-reason.js";
import { TERMINAL_SESSION_PHASES } from "./acl/workplace-acl.js";
import { WorkItemRowCorrupt } from "./work-item-language/work-item-row.js";
import type { DevSessionRepository } from "./acl/workplace-acl.js";
import type { ProjectHaltRepository } from "./repositories/project-halt.js";
import { projectBlockCause } from "./project-halt.js";
import type { WorkItem, WorkItemRepository } from "./domain/index.js";
import type { FailureRouter, RawFailureContext } from "./failure-router.js";
import type { ParkedFailureDeps } from "./lifecycle/failure-recovery.js";
import { blockWorkItem, PlanningService, requeueWorkItem, takeEvents } from "./domain/index.js";
import { recoverParkedFailedItem } from "./lifecycle/failure-recovery.js";
import { ORPHANED_SESSION_RESOLVER } from "./acl/workplace-acl.js";
import { mergeOnMainOf, OrphanUnreconciled, releaseMergedTask } from "./orphan-merge.js";
import type { TargetPathSource } from "./orphan-merge.js";
import { releaseBranchesOfSettledTasks } from "./settled-branches.js";
import type { SettledTargets } from "./settled-branches.js";

// Delivery's reconcile at startup: its work items, and the branches of those settled. Each other context reconciles its own
// resources in its own call (Workplace its sessions, Execution Infrastructure its cells and task
// worktrees), ordered by the composition root (S9).

interface StartupReconcilerDeps {
  readonly workItemRepo: WorkItemRepository;
  /**
   * Blocks a project one of whose rows does not parse (migration 025), or whose crash orphan could
   * not be settled; `get` names the target whose main an orphan's merge is read from, and
   * `listWithWorkspace` every target whose settled tasks' branches are released.
   */
  readonly projects: Pick<ProjectHaltRepository, "block"> & TargetPathSource & SettledTargets;
  readonly eventStore: Pick<EventStoreRepository, "publish">;
  readonly failureRouter: FailureRouter;
  /**
   * Whether an orphan's dispatch never finished: its latest session still non-terminal. Read before
   * Workplace's session reconcile closes those sessions.
   */
  readonly devSessionStore: Pick<DevSessionRepository, "dispatchEvidence">;
  /** The workdir base every target workspace lies in (assertValidTargetProjectPath). */
  readonly workdirBase: string;
}

interface ReconcileSummary {
  readonly orphansRequeued: number;
  /** Orphans whose merge was found on main: recorded and Completed, never re-dispatched. */
  readonly orphansCompleted: number;
  /** Orphans not settled within the bound: Blocked under a typed cause, never left InProgress. */
  readonly orphansBlocked: number;
  readonly failedReplanned: number;
  readonly failedAbandoned: number;
  /** Parked Failed items whose stored verdict does not parse: left Failed, their project blocked. */
  readonly failedHeld: number;
  readonly failedErrored: number;
  /** Projects blocked because one of their rows does not parse; their items are not reconciled. */
  readonly projectsBlocked: number;
}

/**
 * Each project's items in `status`, read project by project so one corrupt row
 * blocks its own project (recorded durably, logged at warn) and the other
 * projects are still reconciled. A project blocked here yields nothing. Any
 * other failure, a database failure included, throws through.
 */
async function* itemsByProject(
  deps: StartupReconcilerDeps,
  status: WorkItemStatus,
  blocked: Set<ProjectId>,
): AsyncGenerator<WorkItem[]> {
  for (const projectId of await deps.workItemRepo.projectIdsWithStatus(status)) {
    if (blocked.has(projectId)) continue;
    try {
      yield await deps.workItemRepo.findByProjectAndStatus(projectId, status);
    } catch (err) {
      if (!(err instanceof WorkItemRowCorrupt)) throw err;
      blocked.add(projectId);
      const cause = projectBlockCause(err);
      const result = await deps.projects.block(projectId, cause);
      console.warn(
        `[startup-reconciler] project ${projectId}: ${cause.errorClass} (item ${err.itemId}, ${err.column}); ` +
          `its ${status} items are not reconciled; project ${result}: ${cause.reason}`,
      );
    }
  }
}

export async function reconcileWorkItemsOnStartup(deps: StartupReconcilerDeps): Promise<ReconcileSummary> {
  let orphansRequeued = 0;
  let orphansCompleted = 0;
  let orphansBlocked = 0;
  let failedReplanned = 0;
  let failedAbandoned = 0;
  let failedHeld = 0;
  let failedErrored = 0;
  let failedRouted = 0;
  const blockedProjects = new Set<ProjectId>();

  for await (const orphans of itemsByProject(deps, "InProgress", blockedProjects)) {
    for (const orphan of orphans) {
      const settled = await settleOrphan(deps, orphan);
      if (settled === "requeued") orphansRequeued += 1;
      else if (settled === "completed") orphansCompleted += 1;
      else if (settled === "blocked") orphansBlocked += 1;
    }
  }

  const recoveryDeps: ParkedFailureDeps = {
    workItemRepo: deps.workItemRepo,
    eventPublisher: deps.eventStore,
    failureRouter: deps.failureRouter,
    projects: deps.projects,
  };

  for await (const parkedFailed of itemsByProject(deps, "Failed", blockedProjects)) {
    for (const failed of parkedFailed) {
      failedRouted += 1;
      try {
        const action = await recoverParkedFailedItem(recoveryDeps, failed, reconstructFailure(failed));
        if (action === "replan") failedReplanned += 1;
        else if (action === "abandon") failedAbandoned += 1;
        else failedHeld += 1;
      } catch (error) {
        failedErrored += 1;
        console.warn(
          `[startup-reconciler] failed to route parked Failed item ${failed.id}; left Failed for the next reconcile:`,
          error,
        );
      }
    }
  }

  // Last, so a task this pass settled (an orphan Completed, a parked Failed item abandoned) is covered.
  await releaseBranchesOfSettledTasks({ workItemRepo: deps.workItemRepo, projects: deps.projects, workdirBase: deps.workdirBase });

  const summary: ReconcileSummary = {
    orphansRequeued,
    orphansCompleted,
    orphansBlocked,
    failedReplanned,
    failedAbandoned,
    failedHeld,
    failedErrored,
    projectsBlocked: blockedProjects.size,
  };
  console.log(
    `[startup-reconciler] orphans requeued=${orphansRequeued} completed=${orphansCompleted} blocked=${orphansBlocked}; ` +
      `parked Failed routed=${failedRouted} (replan=${failedReplanned} abandon=${failedAbandoned} ` +
      `held=${failedHeld} errored=${failedErrored}); ` +
      `projects blocked on a corrupt row=${blockedProjects.size}`,
  );
  return summary;
}

/**
 * Crash-orphaned dispatches of one task given back before a further one is left counted: a task
 * whose dispatch keeps dying with the process may be what kills it, and a refund every time would
 * re-dispatch it forever without its retry bound moving.
 */
const MAX_ORPHAN_REFUNDS = 1;

/**
 * Policy: the waits between attempts at settling one crash orphan, and at blocking it; three
 * attempts each. A store or a git call that fails once is retried, never taken as the answer.
 */
const ORPHAN_BACKOFF_MS: readonly number[] = [100, 500];

type Settled = "requeued" | "completed" | "blocked" | "moved";

/**
 * Settles an InProgress item a previous process left (Discipline A, B). Main is read first: a
 * dead process may have committed the task's merge and died before its record, and a requeue
 * would redo merged work. A merge found is recorded, the worktree and branch the dead process left
 * released (releaseMergedTask), and the task Completed through the path a finished dispatch takes
 * (recordMergeCommit, then PlanningService.route); none found, the task is
 * requeued (requeueOrphan). Each attempt re-reads the item, so a partial write of the one before
 * is never built on. Past the bound the task is blocked, never left InProgress: with its merge
 * found but unrecorded, as merge_unrecorded, whose record the loop writes again each cycle;
 * otherwise as orphan_unreconciled under Ashara's own fault class, with the project blocked on it
 * so the operator sees it. A block that cannot be written either throws: the start is refused
 * rather than run with an item InProgress and no attempt alive.
 */
async function settleOrphan(deps: StartupReconcilerDeps, orphan: WorkItem): Promise<Settled> {
  let merge: string | null | undefined;
  let step = "read main for the task's merge";
  let last: unknown = null;
  for (let attempt = 1; attempt <= ORPHAN_BACKOFF_MS.length + 1; attempt++) {
    try {
      step = "re-read the item";
      const item = attempt === 1 ? orphan : await deps.workItemRepo.findById(orphan.id);
      if (item === null || item.status !== "InProgress") {
        console.warn(`[startup-reconciler] orphan ${orphan.id} is ${item?.status ?? "gone"} now; left as it is`);
        return "moved";
      }
      step = "read main for the task's merge";
      if (merge === undefined) merge = await mergeOnMainOf(deps.projects, deps.workdirBase, item);
      if (merge === null) {
        step = "requeue the task";
        await requeueOrphan(deps, item);
        return "requeued";
      }
      step = `record the merge ${merge}`;
      await deps.workItemRepo.recordMergeCommit(item.id, merge, "merged");
      await releaseMergedTask(deps.projects, deps.workdirBase, item, "merged");
      step = `complete the task merged as ${merge}`;
      const events = await PlanningService.route(deps.workItemRepo, item.id, "passed");
      await publishBestEffort(deps.eventStore, events, item.id);
      console.warn(`[startup-reconciler] ${item.id} was merged on main as ${merge} by a dead process; merge recorded, Completed, not re-dispatched`);
      return "completed";
    } catch (error) {
      last = error;
      const wait = ORPHAN_BACKOFF_MS[attempt - 1];
      console.warn(
        `[startup-reconciler] orphan ${orphan.id}: ${step} failed on attempt ${attempt} of ${ORPHAN_BACKOFF_MS.length + 1}` +
          `${wait === undefined ? "; blocking it" : `; retrying in ${wait}ms`}:`,
        error,
      );
      if (wait !== undefined) await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  const unsettled = new OrphanUnreconciled(orphan.id, step, ORPHAN_BACKOFF_MS.length + 1, { cause: last });
  const reason: StoredBlockedReason =
    typeof merge === "string"
      ? { source: "merge_unrecorded", mergeCommit: merge, mergeKind: "merged", reason: unsettled.message }
      : { source: "orphan_unreconciled", faultClass: "ashara", step, reason: describeErrorChain(last) };
  const blocked = await blockUnsettled(deps, orphan, reason, unsettled);
  if (blocked === "moved") return "moved";
  if (reason.source === "orphan_unreconciled") {
    try {
      const result = await deps.projects.block(orphan.projectId, projectBlockCause(unsettled));
      console.warn(`[startup-reconciler] project ${orphan.projectId} ${result} on Ashara's own fault: ${unsettled.message}`);
    } catch (error) {
      // The item is Blocked with its own exit, which the loop takes each cycle while the project runs.
      console.warn(`[startup-reconciler] project ${orphan.projectId} could not be blocked on ${unsettled.message}:`, error);
    }
  }
  return "blocked";
}

/** Blocks the orphan under `reason`, within the same bound; throws `unsettled`'s chain when it cannot. */
async function blockUnsettled(
  deps: StartupReconcilerDeps,
  orphan: WorkItem,
  reason: StoredBlockedReason,
  unsettled: OrphanUnreconciled,
): Promise<"blocked" | "moved"> {
  let last: unknown = null;
  for (let attempt = 1; attempt <= ORPHAN_BACKOFF_MS.length + 1; attempt++) {
    try {
      const item = await deps.workItemRepo.findById(orphan.id);
      if (item === null || item.status !== "InProgress") return "moved";
      blockWorkItem(item, reason);
      await deps.workItemRepo.save(item, "InProgress");
      await publishBestEffort(deps.eventStore, takeEvents(item), item.id);
      console.warn(`[startup-reconciler] orphan ${orphan.id} blocked (${reason.source}): ${unsettled.message}`);
      return "blocked";
    } catch (error) {
      last = error;
      const wait = ORPHAN_BACKOFF_MS[attempt - 1];
      console.warn(`[startup-reconciler] orphan ${orphan.id}: its block failed on attempt ${attempt}:`, error);
      if (wait !== undefined) await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  throw new OrphanUnreconciled(orphan.id, `block it (${reason.source}) after this: ${unsettled.message}; the block`, ORPHAN_BACKOFF_MS.length + 1, {
    cause: last,
  });
}

/**
 * Requeues an InProgress item left by a previous process, and gives back the dispatch that
 * process counted when the evidence says the dispatch never finished: the item is InProgress and
 * its latest dev_session is still non-terminal. withSessionLifecycle owns every terminal write of
 * a session, so a session that never got one is a dispatch whose execute never returned (a hard
 * kill, a power loss), not an attempt tried and found wanting. Left counted, the conservative
 * direction, when the latest session is terminal (the dispatch finished and only its routing was
 * lost), when there is none (the process died before the dispatch opened its session, which no
 * record tells apart from a session of an earlier dispatch), and past MAX_ORPHAN_REFUNDS.
 */
async function requeueOrphan(deps: StartupReconcilerDeps, orphan: WorkItem): Promise<void> {
  const evidence = await deps.devSessionStore.dispatchEvidence(orphan.id, ORPHANED_SESSION_RESOLVER);
  const unfinished = evidence.latestPhase !== null && !isTerminalSessionPhase(evidence.latestPhase);
  const previousStatus = orphan.status;
  requeueWorkItem(orphan);
  if (!unfinished) {
    await deps.workItemRepo.save(orphan, previousStatus);
    console.warn(
      `[startup-reconciler] requeued ${orphan.id}; its dispatch stays counted (latest session ${evidence.latestPhase ?? "none"}, ` +
        `so no record shows a dispatch that never finished)`,
    );
  } else if (evidence.orphanedBefore >= MAX_ORPHAN_REFUNDS) {
    await deps.workItemRepo.save(orphan, previousStatus);
    console.warn(
      `[startup-reconciler] requeued ${orphan.id}; its unfinished dispatch stays counted: ${evidence.orphanedBefore} earlier ` +
        `dispatch(es) of it were already orphaned by a dead process (bound ${MAX_ORPHAN_REFUNDS})`,
    );
  } else {
    // The requeue and its refund are one write: a fault under either leaves the item InProgress for
    // the next attempt of the settlement, never requeued with its unfinished dispatch charged.
    const dispatchCount = await deps.workItemRepo.saveRefunded(orphan, previousStatus);
    console.warn(`[startup-reconciler] requeued ${orphan.id}; its dispatch never finished (session non-terminal), refunded (dispatch count ${dispatchCount})`);
  }
  await publishBestEffort(deps.eventStore, takeEvents(orphan), orphan.id);
}

function isTerminalSessionPhase(phase: string): boolean {
  return TERMINAL_SESSION_PHASES.some((terminal) => terminal === phase);
}

function reconstructFailure(item: WorkItem): RawFailureContext {
  // Widen through the exhaustive seam — a new source variant in the
  // discriminated union is a compile error in blockedReasonToRecord,
  // not a silent pass-through.
  // contract-erasing: StoredBlockedReason widened via blockedReasonToRecord for duck-typed access
  const raw: Record<string, unknown> = item.blockedReason
    ? blockedReasonToRecord(item.blockedReason)
    : {};
  const reason = raw["reason"];
  const detail =
    typeof reason === "string" ? reason : "parked Failed item recovered by startup reconciler";
  return { detail, raw };
}

async function publishBestEffort(
  eventStore: Pick<EventStoreRepository, "publish">,
  events: DomainEvent[],
  itemId: string,
): Promise<void> {
  for (const event of events) {
    try {
      await eventStore.publish(event);
    } catch (error) {
      console.warn(
        `[startup-reconciler] failed to publish audit event for ${itemId} (transition already committed):`,
        error,
      );
    }
  }
}
