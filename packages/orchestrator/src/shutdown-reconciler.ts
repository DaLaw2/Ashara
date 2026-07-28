import type { DomainEvent } from "@ashara/shared";
import { TERMINAL_STATUSES, RUN_SCOPE_AD_HOC, RUN_SCOPE_PRE_SCOPING } from "@ashara/shared";
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
  /** Pending/InProgress items created via the HTTP API, outside any run. */
  readonly skippedAdHoc: number;
  /** Pending/InProgress items predating the run_scope column. */
  readonly skippedPreScoping: number;
  /** Pending/InProgress items belonging to a different run. */
  readonly skippedOtherRun: number;
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
 * EXCLUDED (by status):
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
 * EXCLUDED (by scope — even when the status is Pending/InProgress):
 *  - `ad-hoc`      — items created deliberately through the HTTP API, outside
 *    any orchestrator run. A run did not create them; destroying them when a
 *    run ends would silently discard human-entered work. Left for the owner
 *    to manage explicitly.
 *  - `pre-scoping` — 27 historical rows predating the `run_scope` column.
 *    Their provenance is unknown; sweeping them risks abandoning items whose
 *    origin nobody can verify. Fail-closed: do not destroy what you cannot
 *    attribute.
 *  - Other run IDs — items belonging to a different run. A run that terminates
 *    should not destroy another run's work. These may be left behind by a
 *    SIGTERM'd predecessor; the dispatch gate will eventually pick up their
 *    Pending Tasks (it selects regardless of scope), but InProgress orphans
 *    from a killed run are requeued by the startup reconciler. See KNOWN GAP
 *    below for the Pending-on-SIGTERM limitation.
 *
 * Called ONLY when the runner stopped on its own termination verdict (not
 * SIGTERM): a clean termination means the run is over and no agent owns any of
 * these items. Items left non-terminal would be inherited by whatever runs next,
 * polluting its board and its summary — the exact failure in Runs 39, 40 and 41.
 *
 * SCOPE: the sweep is scoped to the ending run. `work_items.run_scope` records
 * which run created each item: a UUID from `openRun()`, `"ad-hoc"` for
 * HTTP-API-created items, or `"pre-scoping"` for migration backfill. Only items
 * whose `runScope` matches the provided `endingRunScope` are swept. Items from
 * other scopes are counted and logged but left untouched.
 *
 * SHUTDOWN vs STARTUP: the startup reconciler's requeueOrphan (InProgress →
 * Pending) runs at boot BEFORE the runner starts; this function runs at shutdown
 * AFTER the runner stops. They are sequential and cannot fight: requeueOrphan
 * handles crash-orphans from a killed process; this handles the clean-exit path.
 *
 * KNOWN GAP (widened by run-scoping): a SIGTERM kills the process before this
 * function runs, and the startup reconciler handles InProgress (requeue) and
 * Failed (FailureRouter) but not Pending. Before run-scoping, the next run's
 * whole-board sweep would accidentally clean up the killed run's Pending items
 * when it terminated. Run-scoping removed that accidental cleanup: the next
 * run's scoped sweep skips them (different scope), so they now accumulate
 * rather than being swept. Those items ARE reachable by the gate
 * (PlanningService.gate selects all Pending Tasks regardless of scope), so
 * they will eventually be dispatched — but items that are never dispatched
 * persist indefinitely. Closing this gap requires the startup reconciler to
 * query Pending items from the still-open (previous) run and terminalize them.
 *
 * Fail-soft per item: a single item's transition failure must not prevent the
 * rest from being terminalized, and must not crash the shutdown sequence. Items
 * that error are left in their current DB status: InProgress items will be
 * requeued by the startup reconciler on the next boot; Pending items will be
 * seen by the dispatch gate (which selects all Pending Tasks regardless of scope).
 */

const SWEEP_STATUSES = ["Pending", "InProgress"] as const;

export async function terminalizeOnRunEnd(
  deps: ShutdownReconcilerDeps,
  endingRunScope: string,
): Promise<ShutdownReconcileSummary> {
  let terminalized = 0;
  let errored = 0;
  let skippedAdHoc = 0;
  let skippedPreScoping = 0;
  let skippedOtherRun = 0;

  const allCandidates: WorkItem[] = [];
  for (const status of SWEEP_STATUSES) {
    const items = await deps.workItemRepo.findByStatus(status);
    allCandidates.push(...items);
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

  // Partition candidates by scope: only this run's items are swept.
  const sweepItems: WorkItem[] = [];
  for (const item of allCandidates) {
    if (item.runScope === endingRunScope) {
      sweepItems.push(item);
    } else if (item.runScope === RUN_SCOPE_AD_HOC) {
      skippedAdHoc += 1;
    } else if (item.runScope === RUN_SCOPE_PRE_SCOPING) {
      skippedPreScoping += 1;
    } else {
      skippedOtherRun += 1;
    }
  }

  const scopeExclusions = skippedAdHoc + skippedPreScoping + skippedOtherRun;

  if (sweepItems.length === 0) {
    if (skippedBlocked > 0 || skippedFailed > 0 || scopeExclusions > 0) {
      console.log(
        `[shutdown-reconciler] no Pending/InProgress items to terminalize for run ${endingRunScope}` +
          `; skipped ${skippedBlocked} Blocked (owner-parked), ${skippedFailed} Failed (startup-reconciler routes)` +
          (scopeExclusions > 0
            ? `; scope-excluded ${skippedAdHoc} ad-hoc, ${skippedPreScoping} pre-scoping, ${skippedOtherRun} other-run`
            : ""),
      );
    }
    return { terminalized: 0, errored: 0, skippedBlocked, skippedFailed, skippedAdHoc, skippedPreScoping, skippedOtherRun };
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
          "left in current DB status:",
        error,
      );
    }
  }

  console.log(
    `[shutdown-reconciler] terminalized ${terminalized} work item(s) (Pending/InProgress → Abandoned) for run ${endingRunScope}` +
      (errored > 0 ? `, ${errored} errored` : "") +
      (skippedBlocked > 0 || skippedFailed > 0
        ? `; skipped ${skippedBlocked} Blocked (owner-parked), ${skippedFailed} Failed (startup-reconciler routes)`
        : "") +
      (scopeExclusions > 0
        ? `; scope-excluded ${skippedAdHoc} ad-hoc, ${skippedPreScoping} pre-scoping, ${skippedOtherRun} other-run`
        : ""),
  );
  return { terminalized, errored, skippedBlocked, skippedFailed, skippedAdHoc, skippedPreScoping, skippedOtherRun };
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
