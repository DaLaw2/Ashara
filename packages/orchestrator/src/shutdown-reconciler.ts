import type { DomainEvent } from "@ashara/shared";
import { TERMINAL_STATUSES } from "@ashara/shared";
import type { EventStoreRepository } from "@ashara/db";
import type { WorkItemRepository, WorkItem } from "./acl/planning-acl.js";
import { abandonWorkItem, takeEvents } from "./acl/planning-acl.js";

export interface ShutdownReconcilerDeps {
  readonly workItemRepo: WorkItemRepository;
  readonly eventStore: Pick<EventStoreRepository, "publish">;
}

export interface ShutdownReconcileSummary {
  readonly terminalized: number;
  readonly errored: number;
  readonly skippedBlocked: number;
  readonly skippedFailed: number;
}

/**
 * Which statuses the run-end sweep may terminalize, and why each is included
 * or excluded:
 *
 * INCLUDED:
 *  - `Pending`    — items the run decomposed but never dispatched. The run's
 *    termination verdict (completeness/economy/liveness) has decided no further
 *    dispatch will happen. Without this edge, Pending had no path to ANY terminal
 *    status at all — the mechanical root cause of the Runs 39/40/41 leak.
 *  - `InProgress` — parent items (Epics/Stories) activated when a child Task
 *    started. At clean termination no agent owns them and cascade-completion
 *    cannot fire because some children are stuck. They are structurally
 *    unreachable by any future cycle of this run.
 *
 * EXCLUDED:
 *  - `Blocked`    — the owner-parked state, reachable only via the HTTP PATCH
 *    path. A human deliberately put these items aside to come back to.
 *    Abandoning them silently destroys deliberate human decisions — a worse
 *    outcome than the leak. The owner has the Blocked → Abandoned edge to
 *    give up on them when they choose.
 *  - `Failed`     — the startup reconciler already routes Failed items on the
 *    next boot (replan/abandon/substitute via recoverFailedItem and the
 *    FailureRouter). Abandoning them here pre-empts a recovery path that
 *    already exists and that makes the typed decision between replan and
 *    abandon — that decision belongs to the FailureRouter, not to a sweep.
 *
 * Called ONLY when the runner stopped on its own termination verdict (not
 * SIGTERM): a clean termination means the run is over and no agent owns any of
 * these items. Items left non-terminal would be inherited by whatever runs next,
 * polluting its board and its summary — the exact failure in Runs 39, 40 and 41.
 *
 * SCOPE: the sweep operates on the whole board, not on a single Epic subtree.
 * `work_items.parentId` forms the Epic → Story → Task tree and CAN scope items
 * to a subtree, but nothing in the codebase records which Epic a run was working
 * on — no `run_id`/`vision_id` on work_items, no active-Epic in RunState. Every
 * existing path that touches items (GateKeeper.gate, assembleRunSummaryItems,
 * startup reconciler, worktree cleanup) selects by status across the entire
 * board; the termination verdict itself is computed from `listAll()`.
 *
 * TWO-EPIC CASE: if the board carries two Epics (e.g. a stale Epic from a
 * previous vision plus the current one), the sweep Abandons BOTH Epics'
 * Pending/InProgress items. This is correct for stale-orphan cleanup (the common
 * case: Runs 39/40/41, where the stale Epic contaminated the next run's summary
 * with "3 shipped" naming tasks from a different vision). It over-reaches in the
 * edge case where an owner deliberately prepared a second Epic for a future run —
 * but Pending items have NO other cleanup path (the startup reconciler handles
 * only InProgress and Failed), so leaving them means they persist indefinitely.
 * Epic-scoping the sweep requires a run-to-Epic association that does not exist;
 * adding one (e.g. recording active Epics in RunState on first dispatch) is a
 * distinct piece of work.
 *
 * SHUTDOWN vs STARTUP: the startup reconciler's requeueOrphan (InProgress →
 * Pending) runs at boot BEFORE the runner starts; this function runs at shutdown
 * AFTER the runner stops. They are sequential and cannot fight: requeueOrphan
 * handles crash-orphans from a killed process; this handles the clean-exit path.
 *
 * Fail-soft per item: a single item's transition failure must not prevent the
 * rest from being terminalized, and must not crash the shutdown sequence. Items
 * that error are left in their current status for the next startup reconciler to
 * handle.
 */

const SWEEP_STATUSES = ["Pending", "InProgress"] as const;

export async function terminalizeOnRunEnd(
  deps: ShutdownReconcilerDeps,
): Promise<ShutdownReconcileSummary> {
  let terminalized = 0;
  let errored = 0;

  const sweepItems: WorkItem[] = [];
  for (const status of SWEEP_STATUSES) {
    const items = await deps.workItemRepo.findByStatus(status);
    sweepItems.push(...items);
  }

  // Count the excluded statuses for observability — a sweep that reports
  // "terminalized 0" while 12 Failed items sit on the board looks like a
  // bug without this context.
  const [blockedItems, failedItems] = await Promise.all([
    deps.workItemRepo.findByStatus("Blocked"),
    deps.workItemRepo.findByStatus("Failed"),
  ]);
  const skippedBlocked = blockedItems.length;
  const skippedFailed = failedItems.length;

  if (sweepItems.length === 0) {
    if (skippedBlocked > 0 || skippedFailed > 0) {
      console.log(
        `[shutdown-reconciler] no Pending/InProgress items to terminalize` +
          `; skipped ${skippedBlocked} Blocked (owner-parked), ${skippedFailed} Failed (startup-reconciler routes)`,
      );
    }
    return { terminalized: 0, errored: 0, skippedBlocked, skippedFailed };
  }

  for (const item of sweepItems) {
    // Double-check: a concurrent transition could have moved the item to
    // terminal between the query and this loop iteration.
    if (TERMINAL_STATUSES.has(item.status)) continue;

    try {
      const previousStatus = item.status;
      abandonWorkItem(item, {
        reason: "run terminated",
        source: "shutdown-reconciler",
        previousStatus,
      });
      await deps.workItemRepo.save(item, previousStatus);
      await publishBestEffort(deps.eventStore, takeEvents(item), item.id);
      terminalized += 1;
    } catch (error) {
      errored += 1;
      console.warn(
        `[shutdown-reconciler] failed to terminalize ${item.id} (${item.status}); ` +
          "left for the next startup reconciler:",
        error,
      );
    }
  }

  console.log(
    `[shutdown-reconciler] terminalized ${terminalized} work item(s) (Pending/InProgress → Abandoned)` +
      (errored > 0 ? `, ${errored} errored` : "") +
      (skippedBlocked > 0 || skippedFailed > 0
        ? `; skipped ${skippedBlocked} Blocked (owner-parked), ${skippedFailed} Failed (startup-reconciler routes)`
        : ""),
  );
  return { terminalized, errored, skippedBlocked, skippedFailed };
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
        `[shutdown-reconciler] failed to publish audit event for ${itemId} (transition already committed):`,
        error,
      );
    }
  }
}
