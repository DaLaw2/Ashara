import type { DomainEvent } from "@ashara/shared";
import type { EventStoreRepository } from "@ashara/db";
import type { WorkItem, WorkItemRepository } from "@ashara/planning-domain";
import { requeueWorkItem, takeEvents } from "@ashara/planning-domain";
import type { FailureRouter, RawFailureContext } from "@ashara/planning";

import { recoverFailedItem, type FailureRecoveryDeps } from "./failure-recovery.js";

export interface StartupReconcilerDeps {
  readonly workItemRepo: WorkItemRepository;
  readonly eventStore: Pick<EventStoreRepository, "publish">;
  readonly failureRouter: FailureRouter;
}

/** Structured tally of what a single reconcile pass changed (logged for observability). */
export interface ReconcileSummary {
  /** InProgress crash-orphans reset to Pending. */
  readonly orphansRequeued: number;
  /** InProgress orphans whose reset threw (left InProgress for the next reconcile). */
  readonly orphansErrored: number;
  /** Parked Failed items the FailureRouter replanned back to Pending. */
  readonly failedReplanned: number;
  /** Parked Failed items the FailureRouter terminated (bound exhausted). */
  readonly failedAbandoned: number;
  /** Parked Failed items terminated in favour of a completed equivalent twin. */
  readonly failedSubstituted: number;
  /** Parked Failed items whose recovery threw (left Failed for the next reconcile). */
  readonly failedErrored: number;
}

/**
 * The single source of truth for "does a recovery path STILL exist for this Failed
 * item?" — shared by the startup reconciler (which acts on it) and the termination
 * seam (TerminationItemSnapshot.recoverable, mig7-t3, which reads it). Mirrors
 * FailureRouter's replan condition exactly: an item is recoverable iff it is Failed
 * and its prior attempts are still under the replan bound, so the reconciler will
 * replan it rather than abandon it. Pure — no I/O — so the two callers can never
 * drift apart in what "recoverable" means.
 *
 * The substitute path (a completed twin exists) is deliberately NOT counted here: it
 * requires sibling plan-state the pure predicate does not carry, and it TERMINATES
 * the duplicate rather than keeping it alive, so for liveness purposes it is not a
 * "still-advanceable" signal.
 */
export function isRecoverableFailed(
  item: Pick<WorkItem, "status">,
  priorAttempts: number,
  replanBound: number,
): boolean {
  return item.status === "Failed" && priorAttempts < replanBound;
}

/**
 * Startup reconciliation (Discipline B: stateful resources reconcile on boot and
 * survive restart). A prior process may have crashed mid-dispatch — this project's
 * history IS the serve+spawn crash — leaving items in two stranding traps that no
 * running cycle can clear on its own:
 *
 *   1. InProgress crash-orphans. A fresh process owns no in-flight agent, so every
 *      InProgress item is reset to Pending (the gate selects Pending only). There is
 *      no race: at boot, BEFORE the runner starts cycling, nothing is genuinely
 *      in-flight, so a fresh process rightfully owns nothing.
 *   2. Parked Failed items. handleTaskError commits Failed but a crash before the
 *      synchronous in-cycle recovery leaves the item Failed with no route out. Each
 *      is routed through the SAME FailureRouter policy as in-cycle recovery
 *      (recoverFailedItem — replan / abandon / substitute), never a forked policy.
 *
 * Must run BEFORE the runner's first cycle so the gate sees the recovered Pending
 * work. Fail-closed per item: a single item's failure is logged and skipped (it stays
 * in its stranding state for the next boot) rather than aborting the whole reconcile.
 *
 * IDEMPOTENT: after one pass no item is InProgress (all requeued to Pending) and no
 * item is Failed (each replanned to Pending or terminated to Abandoned). A second
 * pass finds zero InProgress and zero Failed, so it changes nothing.
 */
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
    eventStore: deps.eventStore,
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

  const summary: ReconcileSummary = {
    orphansRequeued,
    orphansErrored,
    failedReplanned,
    failedAbandoned,
    failedSubstituted,
    failedErrored,
  };
  console.log(
    `[startup-reconciler] orphans requeued=${orphansRequeued} errored=${orphansErrored}; ` +
      `parked Failed routed=${parkedFailed.length} (replan=${failedReplanned} abandon=${failedAbandoned} ` +
      `substitute=${failedSubstituted} errored=${failedErrored})`,
  );
  return summary;
}

async function requeueOrphan(deps: StartupReconcilerDeps, orphan: WorkItem): Promise<void> {
  const previousStatus = orphan.status;
  requeueWorkItem(orphan);
  await deps.workItemRepo.save(orphan, previousStatus);
  await publishBestEffort(deps.eventStore, takeEvents(orphan), orphan.id);
}

/**
 * Rebuilds a RawFailureContext for a parked Failed item from its persisted
 * blockedReason so the FailureRouter can carry the original failure forward into a
 * replan (Discipline C — the context is not invented, it rides the record).
 */
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
  // The status transition is already committed; a publish failure is logged and
  // swallowed (the event store is an audit log, not the source of truth) so a broken
  // sink never aborts reconciliation.
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
