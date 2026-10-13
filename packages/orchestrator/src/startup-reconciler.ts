import fs from "node:fs/promises";
import path from "node:path";
import type { DomainEvent, ProjectId, WorkItemStatus } from "@ashara/shared";
import { blockedReasonToRecord, projectBlockCause, TERMINAL_SESSION_PHASES, WorkItemRowCorrupt } from "@ashara/shared";
import type { DevSessionRepository, EventStoreRepository, ProjectRepository } from "@ashara/db";
import type { WorkItem, WorkItemRepository, FailureRouter, RawFailureContext, FailureRecoveryDeps } from "./acl/planning-acl.js";
import { requeueWorkItem, takeEvents, recoverFailedItem } from "./acl/planning-acl.js";

export interface StartupReconcilerDeps {
  readonly workItemRepo: WorkItemRepository;
  /** Blocks a project one of whose rows does not parse (migration 025). */
  readonly projects: Pick<ProjectRepository, "block">;
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
  readonly orphansErrored: number;
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
  let orphansErrored = 0;
  let failedReplanned = 0;
  let failedAbandoned = 0;
  let failedErrored = 0;
  let failedRouted = 0;
  const blockedProjects = new Set<ProjectId>();

  for await (const orphans of itemsByProject(deps, "InProgress", blockedProjects)) {
    for (const orphan of orphans) {
      try {
        await requeueOrphan(deps, orphan);
        orphansRequeued += 1;
      } catch (error) {
        orphansErrored += 1;
        console.warn(
          `[startup-reconciler] failed to requeue crash-orphaned InProgress item ${orphan.id}; left InProgress for the next reconcile:`,
          error,
        );
      }
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
    orphansErrored,
    failedReplanned,
    failedAbandoned,
    failedErrored,
    projectsBlocked: blockedProjects.size,
    worktreesCleaned,
    sessionsTerminalized,
  };
  console.log(
    `[startup-reconciler] orphans requeued=${orphansRequeued} errored=${orphansErrored}; ` +
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
