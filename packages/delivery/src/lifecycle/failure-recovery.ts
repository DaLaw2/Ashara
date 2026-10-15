import { describeErrorChain } from "@ashara/shared";
import type { StoredBlockedReason } from "../work-item-language/blocked-reason.js";
import type { WorkItem, WorkItemRepository } from "../domain/index.js";
import { PlanningService, replanWorkItem, abandonWorkItem, takeEvents } from "../domain/index.js";
import type { FailureRouter, FailureDecision, RawFailureContext } from "../failure-router.js";
import type { FailureVerdict } from "../acl/quality-acl.js";
import type { EventPublisher } from "./ports.js";

export interface FailureRecoveryDeps {
  readonly workItemRepo: WorkItemRepository;
  readonly eventPublisher: EventPublisher;
  readonly failureRouter: Pick<FailureRouter, "route">;
}

/**
 * Routes a Failed item by Quality's verdict on its last attempt (G4): replanned for another attempt
 * or abandoned. The verdict is required, so no failure picks a route by default.
 */
export async function recoverFailedItem(
  deps: FailureRecoveryDeps,
  item: WorkItem,
  failure: RawFailureContext,
  verdict: FailureVerdict,
): Promise<FailureDecision["action"]> {
  const priorAttempts = item.dispatchCount;

  try {
    const decision = routeDecision(deps.failureRouter, item, failure, priorAttempts, verdict);

    switch (decision.action) {
      case "replan":
        await applyReplan(deps, item, decision.attempt, decision.failure);
        return "replan";

      case "abandon":
        await applyAbandon(deps, item, {
          reason: decision.reason,
          attempts: decision.attempts,
          lastFailure: decision.failure,
          source: "failure_given_up",
        });
        return "abandon";
    }
  } catch (error) {
    return abandonFailClosed(deps, item, failure, priorAttempts, error);
  }
}

function routeDecision(
  failureRouter: Pick<FailureRouter, "route">,
  item: WorkItem,
  failure: RawFailureContext,
  priorAttempts: number,
  verdict: FailureVerdict,
): FailureDecision {
  try {
    return failureRouter.route({ item: { id: item.id }, failure, priorAttempts, verdict });
  } catch (error) {
    console.warn(
      `[${item.id}] FailureRouter.route failed; abandoning fail-closed so dependents do not deadlock:`,
      error,
    );
    return { action: "abandon", reason: "routing_fault", attempts: priorAttempts, failure };
  }
}

async function abandonFailClosed(
  deps: FailureRecoveryDeps,
  item: WorkItem,
  failure: RawFailureContext,
  priorAttempts: number,
  error: unknown,
): Promise<FailureDecision["action"]> {
  console.warn(
    `[${item.id}] recovery internals failed (route/save); abandoning fail-closed so the item does not strand at Failed:`,
    error,
  );
  const fresh = (await deps.workItemRepo.findById(item.id)) ?? item;
  if (fresh.status !== "Failed") {
    return "abandon";
  }
  await applyAbandon(deps, fresh, {
    reason: "routing_fault",
    detail: describeErrorChain(error),
    attempts: priorAttempts,
    lastFailure: failure,
    source: "failure_given_up",
  });
  return "abandon";
}

async function applyReplan(
  deps: FailureRecoveryDeps,
  item: WorkItem,
  attempt: number,
  failure: RawFailureContext,
): Promise<void> {
  const previousStatus = item.status;
  replanWorkItem(item);

  item.blockedReason = {
    source: "replan",
    replanContext: { attempt, detail: failure.detail, raw: failure.raw },
  };
  await PlanningService.saveWorkItem(deps.workItemRepo, item, previousStatus);
  await publishEvents(deps, item);
}

async function applyAbandon(
  deps: Pick<FailureRecoveryDeps, "workItemRepo" | "eventPublisher">,
  item: WorkItem,
  reason: StoredBlockedReason,
): Promise<void> {
  const previousStatus = item.status;
  abandonWorkItem(item, reason);
  await PlanningService.saveWorkItem(deps.workItemRepo, item, previousStatus);
  await publishEvents(deps, item);
}

async function publishEvents(deps: Pick<FailureRecoveryDeps, "eventPublisher">, item: WorkItem): Promise<void> {
  const events = takeEvents(item);
  for (const event of events) {
    try {
      await deps.eventPublisher.publish(event);
    } catch (publishError) {
      console.warn(
        `[failure-recovery.publishEvents] failed to publish audit event for ${item.id} (status transition already committed):`,
        publishError,
      );
    }
  }
}
