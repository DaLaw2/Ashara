import fs from "node:fs/promises";
import path from "node:path";
import type { DomainEvent, ProjectId, StoredBlockedReason, WorkItemStatus } from "@ashara/shared";
import { blockedReasonToRecord, describeErrorChain, projectBlockCause, TERMINAL_SESSION_PHASES, WorkItemRowCorrupt } from "@ashara/shared";
import type { DevSessionRepository, EventStoreRepository, ProjectRepository } from "@ashara/db";
import type { WorkItem, WorkItemRepository, FailureRouter, RawFailureContext, FailureRecoveryDeps } from "./acl/planning-acl.js";
import { blockWorkItem, PlanningService, requeueWorkItem, takeEvents, recoverFailedItem } from "./acl/planning-acl.js";
import { mergeOnMainOf, OrphanUnreconciled } from "./orphan-merge.js";
import type { TargetPathSource } from "./orphan-merge.js";

export interface StartupReconcilerDeps {
  readonly workItemRepo: WorkItemRepository;
  /**
   * Blocks a project one of whose rows does not parse (migration 025), or whose crash orphan could
   * not be settled; `get` names the target whose main an orphan's merge is read from.
   */
  readonly projects: Pick<ProjectRepository, "block"> & TargetPathSource;
  readonly eventStore: Pick<EventStoreRepository, "publish">;
  readonly failureRouter: FailureRouter;
  /**
   * REQUIRED, not optional: dev_sessions is a stateful resource with a
   * non-terminal phase, so leaving it unreconciled is the same leak this pass
   * exists to close. An optional dependency here would just be the leak with a
   * question mark on it.
   */
  readonly devSessionStore: Pick<DevSessionRepository, "failStale" | "dispatchEvidence">;
  readonly workdirBase: string;
}

export interface ReconcileSummary {
  readonly orphansRequeued: number;
  /** Orphans whose merge was found on main: recorded and Completed, never re-dispatched. */
  readonly orphansCompleted: number;
  /** Orphans not settled within the bound: Blocked under a typed cause, never left InProgress. */
  readonly orphansBlocked: number;
  readonly failedReplanned: number;
  readonly failedAbandoned: number;
  readonly failedErrored: number;
  /** Projects blocked because one of their rows does not parse; their items are not reconciled. */
  readonly projectsBlocked: number;
  readonly worktreesCleaned: number;
  readonly sessionsTerminalized: number;
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

export async function reconcileOnStartup(deps: StartupReconcilerDeps): Promise<ReconcileSummary> {
  let orphansRequeued = 0;
  let orphansCompleted = 0;
  let orphansBlocked = 0;
  let failedReplanned = 0;
  let failedAbandoned = 0;
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

  const recoveryDeps: FailureRecoveryDeps = {
    workItemRepo: deps.workItemRepo,
    eventPublisher: deps.eventStore,
    failureRouter: deps.failureRouter,
  };

  for await (const parkedFailed of itemsByProject(deps, "Failed", blockedProjects)) {
    for (const failed of parkedFailed) {
      failedRouted += 1;
      try {
        const action = await recoverFailedItem(recoveryDeps, failed, reconstructFailure(failed));
        if (action === "replan") failedReplanned += 1;
        else failedAbandoned += 1;
      } catch (error) {
        failedErrored += 1;
        console.warn(
          `[startup-reconciler] failed to route parked Failed item ${failed.id}; left Failed for the next reconcile:`,
          error,
        );
      }
    }
  }

  const sessionsTerminalized = await terminalizeOrphanedSessions(deps);

  const worktreesCleaned = await cleanOrphanedWorktrees(deps.workdirBase, deps.workItemRepo);

  const summary: ReconcileSummary = {
    orphansRequeued,
    orphansCompleted,
    orphansBlocked,
    failedReplanned,
    failedAbandoned,
    failedErrored,
    projectsBlocked: blockedProjects.size,
    worktreesCleaned,
    sessionsTerminalized,
  };
  console.log(
    `[startup-reconciler] orphans requeued=${orphansRequeued} completed=${orphansCompleted} blocked=${orphansBlocked}; ` +
      `parked Failed routed=${failedRouted} (replan=${failedReplanned} abandon=${failedAbandoned} ` +
      `errored=${failedErrored}); ` +
      `projects blocked on a corrupt row=${blockedProjects.size}; ` +
      `sessions terminalized=${sessionsTerminalized}; ` +
      `worktrees cleaned=${worktreesCleaned}`,
  );
  return summary;
}

/**
 * Closes every dev_session a crash left in a non-terminal phase. The server is
 * single-process (ADR-022), so at boot NO session can legitimately be in flight —
 * this is an exact classification, not a heuristic timeout. Without it a killed
 * process leaves rows that `listActive()` reports as live agents forever (E2E Run
 * 39: 6 rows, against 1 real dispatch).
 *
 * Fail-soft on its own error: a DB failure here must not block boot, and the next
 * reconcile pass will retry — the rows are already stranded, so retrying is
 * strictly better than refusing to start.
 */
async function terminalizeOrphanedSessions(deps: StartupReconcilerDeps): Promise<number> {
  try {
    const count = await deps.devSessionStore.failStale({
      outcome: "abandoned",
      detail: "session was still non-terminal at process start; its agent did not survive the previous process",
      resolvedBy: RESOLVED_BY,
      resolvedAt: new Date().toISOString(),
    });
    if (count > 0) {
      console.warn(
        `[startup-reconciler] terminalized ${count} crash-orphaned dev_session(s) left non-terminal by a previous process`,
      );
    }
    return count;
  } catch (error) {
    console.warn(
      "[startup-reconciler] dev_session reconciliation failed; leaked sessions stay non-terminal until the next start:",
      error,
    );
    return 0;
  }
}

/** The name failStale records as `resolvedBy`; dispatchEvidence counts earlier orphans by it. */
const RESOLVED_BY = "startup-reconciler";

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
 * dead process may have committed the task's merge and died before its record (B5), and a requeue
 * would redo merged work. A merge found is recorded and the task Completed through the path a
 * finished dispatch takes (recordMergeCommit, then PlanningService.route); none found, the task is
 * requeued (requeueOrphan). Each attempt re-reads the item, so a partial write of the one before
 * is never built on. Past the bound the task is blocked, never left InProgress (B3): with its merge
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
      if (merge === undefined) merge = await mergeOnMainOf(deps.projects, item);
      if (merge === null) {
        step = "requeue the task";
        await requeueOrphan(deps, item);
        return "requeued";
      }
      step = `record the merge ${merge}`;
      await deps.workItemRepo.recordMergeCommit(item.id, merge, "merged");
      step = `complete the task merged as ${merge}`;
      const events = await PlanningService.route(deps.workItemRepo, item.id, true);
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
  const evidence = await deps.devSessionStore.dispatchEvidence(orphan.id, RESOLVED_BY);
  const previousStatus = orphan.status;
  requeueWorkItem(orphan);
  await deps.workItemRepo.save(orphan, previousStatus);
  await publishBestEffort(deps.eventStore, takeEvents(orphan), orphan.id);

  const unfinished = evidence.latestPhase !== null && !isTerminalSessionPhase(evidence.latestPhase);
  if (!unfinished) {
    console.warn(
      `[startup-reconciler] requeued ${orphan.id}; its dispatch stays counted (latest session ${evidence.latestPhase ?? "none"}, ` +
        `so no record shows a dispatch that never finished)`,
    );
    return;
  }
  if (evidence.orphanedBefore >= MAX_ORPHAN_REFUNDS) {
    console.warn(
      `[startup-reconciler] requeued ${orphan.id}; its unfinished dispatch stays counted: ${evidence.orphanedBefore} earlier ` +
        `dispatch(es) of it were already orphaned by a dead process (bound ${MAX_ORPHAN_REFUNDS})`,
    );
    return;
  }
  try {
    const dispatchCount = await deps.workItemRepo.refundDispatchCount(orphan.id);
    console.warn(`[startup-reconciler] requeued ${orphan.id}; its dispatch never finished (session non-terminal), refunded (dispatch count ${dispatchCount})`);
  } catch (error) {
    console.warn(`[startup-reconciler] requeued ${orphan.id}; the refund of its unfinished dispatch failed, it stays counted:`, error);
  }
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

/**
 * Worktree naming convention: `createWorkdir` names every worktree directory
 * `task-<taskId>` (via `taskBranchName(id).replace(/\//g, "-")`). Only
 * directories matching this prefix are ours to delete.
 *
 * The prior version deleted everything it did NOT recognise — fail-open in the
 * Discipline A sense: an unrecognised entry (projects/, records/, any future
 * sibling) got the destructive default. Inverted here: delete only entries the
 * sweep can positively identify as a task worktree it owns. Everything else is
 * left alone by construction, not by being remembered on a reserved-name list.
 */
const TASK_WORKTREE_PREFIX = "task-";

async function cleanOrphanedWorktrees(
  workdirBase: string,
  workItemRepo: WorkItemRepository,
): Promise<number> {
  let cleaned = 0;
  try {
    const entries = await fs.readdir(workdirBase, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    if (dirs.length === 0) return 0;

    // Only consider directories matching the task worktree naming convention.
    const taskDirs = dirs
      .filter((d) => d.startsWith(TASK_WORKTREE_PREFIX))
      .map((d) => ({ dirName: d, taskId: d.slice(TASK_WORKTREE_PREFIX.length) }));
    if (taskDirs.length === 0) return 0;

    // Ids only: a row whose jsonb does not parse still keeps its worktree.
    const activeIds = new Set<string>(await workItemRepo.listIdsByStatus(["Pending", "InProgress", "Blocked"]));

    for (const { dirName, taskId } of taskDirs) {
      if (activeIds.has(taskId)) continue;
      try {
        await fs.rm(path.join(workdirBase, dirName), { recursive: true, force: true });
        cleaned += 1;
      } catch (err) {
        console.warn(
          `[startup-reconciler] failed to remove orphaned worktree ${dirName}:`,
          err,
        );
      }
    }
  } catch (err) {
    console.warn("[startup-reconciler] worktree cleanup skipped:", err);
  }
  return cleaned;
}
