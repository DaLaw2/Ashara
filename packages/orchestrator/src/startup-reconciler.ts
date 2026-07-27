import fs from "node:fs/promises";
import path from "node:path";
import type { DomainEvent } from "@ashara/shared";
import type { DevSessionRepository, EventStoreRepository } from "@ashara/db";
import type { WorkItem, WorkItemRepository, FailureRouter, RawFailureContext, FailureRecoveryDeps } from "./acl/planning-acl.js";
import { requeueWorkItem, takeEvents, recoverFailedItem } from "./acl/planning-acl.js";

export interface StartupReconcilerDeps {
  readonly workItemRepo: WorkItemRepository;
  readonly eventStore: Pick<EventStoreRepository, "publish">;
  readonly failureRouter: FailureRouter;
  /**
   * REQUIRED, not optional: dev_sessions is a stateful resource with a
   * non-terminal phase, so leaving it unreconciled is the same leak this pass
   * exists to close. An optional dependency here would just be the leak with a
   * question mark on it.
   */
  readonly devSessionStore: Pick<DevSessionRepository, "failStale">;
  readonly workdirBase: string;
}

export interface ReconcileSummary {
  readonly orphansRequeued: number;
  readonly orphansErrored: number;
  readonly failedReplanned: number;
  readonly failedAbandoned: number;
  readonly failedSubstituted: number;
  readonly failedErrored: number;
  readonly worktreesCleaned: number;
  readonly sessionsTerminalized: number;
}

export async function reconcileOnStartup(deps: StartupReconcilerDeps): Promise<ReconcileSummary> {
  let orphansRequeued = 0;
  let orphansErrored = 0;
  let failedReplanned = 0;
  let failedAbandoned = 0;
  let failedSubstituted = 0;
  let failedErrored = 0;

  const orphans = await deps.workItemRepo.findByStatus("InProgress");
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

  const recoveryDeps: FailureRecoveryDeps = {
    workItemRepo: deps.workItemRepo,
    eventPublisher: deps.eventStore,
    failureRouter: deps.failureRouter,
  };

  const parkedFailed = await deps.workItemRepo.findByStatus("Failed");
  for (const failed of parkedFailed) {
    try {
      const action = await recoverFailedItem(recoveryDeps, failed, reconstructFailure(failed));
      if (action === "replan") failedReplanned += 1;
      else if (action === "substitute") failedSubstituted += 1;
      else failedAbandoned += 1;
    } catch (error) {
      failedErrored += 1;
      console.warn(
        `[startup-reconciler] failed to route parked Failed item ${failed.id}; left Failed for the next reconcile:`,
        error,
      );
    }
  }

  const sessionsTerminalized = await terminalizeOrphanedSessions(deps);

  const worktreesCleaned = await cleanOrphanedWorktrees(deps.workdirBase, deps.workItemRepo);

  const summary: ReconcileSummary = {
    orphansRequeued,
    orphansErrored,
    failedReplanned,
    failedAbandoned,
    failedSubstituted,
    failedErrored,
    worktreesCleaned,
    sessionsTerminalized,
  };
  console.log(
    `[startup-reconciler] orphans requeued=${orphansRequeued} errored=${orphansErrored}; ` +
      `parked Failed routed=${parkedFailed.length} (replan=${failedReplanned} abandon=${failedAbandoned} ` +
      `substitute=${failedSubstituted} errored=${failedErrored}); sessions terminalized=${sessionsTerminalized}; ` +
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
      passed: false,
      outcome: "abandoned",
      detail: "session was still non-terminal at process start; its agent did not survive the previous process",
      resolvedBy: "startup-reconciler",
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

async function requeueOrphan(deps: StartupReconcilerDeps, orphan: WorkItem): Promise<void> {
  const previousStatus = orphan.status;
  requeueWorkItem(orphan);
  await deps.workItemRepo.save(orphan, previousStatus);
  await publishBestEffort(deps.eventStore, takeEvents(orphan), orphan.id);
}

function reconstructFailure(item: WorkItem): RawFailureContext {
  const raw = item.blockedReason ?? {};
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
      await eventStore.publish(event, "Internal");
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

    const [pending, inProgress, blocked] = await Promise.all([
      workItemRepo.findByStatus("Pending"),
      workItemRepo.findByStatus("InProgress"),
      workItemRepo.findByStatus("Blocked"),
    ]);
    const activeIds = new Set<string>(
      [...pending, ...inProgress, ...blocked].map((item) => String(item.id)),
    );

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
