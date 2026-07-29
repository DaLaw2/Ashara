import fs from "node:fs/promises";
import path from "node:path";
import type { DomainEvent } from "@ashara/shared";
import { blockedReasonToRecord, RUN_SCOPE_AD_HOC, RUN_SCOPE_PRE_SCOPING } from "@ashara/shared";
import type { DevSessionRepository, EventStoreRepository } from "@ashara/db";
import type { WorkItem, WorkItemRepository, FailureRouter, RawFailureContext, FailureRecoveryDeps } from "./acl/planning-acl.js";
import { requeueWorkItem, abandonWorkItem, takeEvents, recoverFailedItem } from "./acl/planning-acl.js";
import type { RunStateStore } from "./run-state.js";

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
  readonly runStateStore: Pick<RunStateStore, "load">;
}

export interface ReconcileSummary {
  readonly orphansRequeued: number;
  readonly orphansErrored: number;
  readonly failedReplanned: number;
  readonly failedAbandoned: number;
  readonly failedSubstituted: number;
  readonly failedErrored: number;
  readonly pendingOrphansAbandoned: number;
  readonly pendingOrphansErrored: number;
  readonly pendingSkippedActiveRun: number;
  readonly pendingSkippedAdHoc: number;
  readonly pendingSkippedPreScoping: number;
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

  const pendingResult = await reconcilePendingOrphans(deps);

  const sessionsTerminalized = await terminalizeOrphanedSessions(deps);

  const worktreesCleaned = await cleanOrphanedWorktrees(deps.workdirBase, deps.workItemRepo);

  const summary: ReconcileSummary = {
    orphansRequeued,
    orphansErrored,
    failedReplanned,
    failedAbandoned,
    failedSubstituted,
    failedErrored,
    pendingOrphansAbandoned: pendingResult.abandoned,
    pendingOrphansErrored: pendingResult.errored,
    pendingSkippedActiveRun: pendingResult.skippedActiveRun,
    pendingSkippedAdHoc: pendingResult.skippedAdHoc,
    pendingSkippedPreScoping: pendingResult.skippedPreScoping,
    worktreesCleaned,
    sessionsTerminalized,
  };
  console.log(
    `[startup-reconciler] orphans requeued=${orphansRequeued} errored=${orphansErrored}; ` +
      `parked Failed routed=${parkedFailed.length} (replan=${failedReplanned} abandon=${failedAbandoned} ` +
      `substitute=${failedSubstituted} errored=${failedErrored}); ` +
      `pending orphans abandoned=${pendingResult.abandoned} errored=${pendingResult.errored}` +
      (pendingResult.skippedActiveRun > 0 ? ` active-run=${pendingResult.skippedActiveRun}` : "") +
      (pendingResult.skippedAdHoc > 0 ? ` ad-hoc=${pendingResult.skippedAdHoc}` : "") +
      (pendingResult.skippedPreScoping > 0 ? ` pre-scoping=${pendingResult.skippedPreScoping}` : "") +
      `; sessions terminalized=${sessionsTerminalized}; ` +
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

// ---------------------------------------------------------------------------
// Pending-orphan pass
// ---------------------------------------------------------------------------

interface PendingOrphanResult {
  readonly abandoned: number;
  readonly errored: number;
  readonly skippedActiveRun: number;
  readonly skippedAdHoc: number;
  readonly skippedPreScoping: number;
}

const EMPTY_PENDING_RESULT: PendingOrphanResult = {
  abandoned: 0,
  errored: 0,
  skippedActiveRun: 0,
  skippedAdHoc: 0,
  skippedPreScoping: 0,
};

/**
 * Abandons Pending items orphaned by a previous run that is no longer open.
 *
 * At boot, the process has not yet called `openRun()`, so no run is "current."
 * But the run-state record tells us which run WILL be resumed: if a record
 * exists and is not closed, `openRun()` will adopt it (SIGTERM leaves the
 * record open on purpose — see `closeRun()`). Items from that scope are
 * preserved; items from every other non-sentinel scope are orphaned.
 *
 * Before run-scoping, these orphans were swept accidentally: the next run's
 * whole-board `terminalizeOnRunEnd` caught them. Run-scoping removed that
 * accidental cleanup because the next run's scoped sweep skips items from a
 * different scope. This pass closes the gap that scoping widened.
 *
 * Scope partition (mirrors shutdown-reconciler):
 *  - active-run scope → preserved (will be resumed by openRun).
 *  - ad-hoc           → preserved (human-created, not ours to destroy).
 *  - pre-scoping      → preserved (provenance unknown, fail-closed).
 *  - everything else  → orphaned: abandoned with structured context.
 *
 * Fail-closed on the destructive path: if the run state cannot be loaded,
 * the entire pass is skipped — we cannot determine which scope to protect,
 * so we protect all of them. Per-item save errors are caught and logged;
 * the failed items are left Pending for the next startup reconcile.
 */
async function reconcilePendingOrphans(deps: StartupReconcilerDeps): Promise<PendingOrphanResult> {
  let activeScope: string | null;
  try {
    const runState = await deps.runStateStore.load();
    activeScope = runState && !runState.closed ? runState.runId : null;
  } catch (error) {
    console.warn(
      "[startup-reconciler] failed to load run state; skipping Pending-orphan pass " +
        "(fail-closed: cannot determine which scope to protect):",
      error,
    );
    return EMPTY_PENDING_RESULT;
  }

  let abandoned = 0;
  let errored = 0;
  let skippedActiveRun = 0;
  let skippedAdHoc = 0;
  let skippedPreScoping = 0;

  const pendingItems = await deps.workItemRepo.findByStatus("Pending");
  for (const item of pendingItems) {
    if (item.runScope === RUN_SCOPE_AD_HOC) {
      skippedAdHoc += 1;
    } else if (item.runScope === RUN_SCOPE_PRE_SCOPING) {
      skippedPreScoping += 1;
    } else if (activeScope !== null && item.runScope === activeScope) {
      skippedActiveRun += 1;
    } else {
      try {
        const previousStatus = item.status;
        abandonWorkItem(item, {
          reason: "orphaned by a previous run that is no longer open",
          source: "startup-reconciler",
          previousScope: item.runScope,
        });
        await deps.workItemRepo.save(item, previousStatus);
        await publishBestEffort(deps.eventStore, takeEvents(item), item.id);
        abandoned += 1;
      } catch (error) {
        errored += 1;
        console.warn(
          `[startup-reconciler] failed to abandon orphaned Pending item ${item.id} ` +
            `(scope=${item.runScope}); left Pending for the next reconcile:`,
          error,
        );
      }
    }
  }

  if (abandoned > 0 || errored > 0) {
    console.log(
      `[startup-reconciler] Pending-orphan pass: abandoned=${abandoned}` +
        (errored > 0 ? ` errored=${errored}` : "") +
        `; preserved ${skippedActiveRun} active-run, ` +
        `${skippedAdHoc} ad-hoc, ${skippedPreScoping} pre-scoping`,
    );
  }

  return { abandoned, errored, skippedActiveRun, skippedAdHoc, skippedPreScoping };
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
