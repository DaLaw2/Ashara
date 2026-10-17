import { describeErrorChain } from "@ashara/shared";
import type { Logger } from "@ashara/shared";
import type { StoredBlockedReason } from "../work-item-language/blocked-reason.js";
import type { ActiveProjects, WorkItem, WorkItemRepository } from "../domain/index.js";
import { PlanningService, replanWorkItem, abandonWorkItem, takeEvents } from "../domain/index.js";
import type { FailureRouter, FailureDecision, RawFailureContext } from "../failure-router.js";
import type { FailureVerdict } from "../acl/quality-acl.js";
import { WORK_FAILED } from "../acl/quality-acl.js";
import { WorkItemNotFound } from "../work-item-language/transitions.js";
import { projectBlockCause } from "../project-halt.js";
import type { EventPublisher } from "./ports.js";

export interface FailureRecoveryDeps {
  readonly workItemRepo: WorkItemRepository;
  readonly eventPublisher: EventPublisher;
  readonly failureRouter: Pick<FailureRouter, "route">;
  readonly logger: Logger;
}

/** The verdict stored with a Failed item's transition does not parse. */
class StoredFailureVerdictCorrupt extends Error {
  constructor(
    readonly workItemId: string,
    readonly projectId: string,
    readonly detail: string,
  ) {
    super(`work item ${workItemId} (project ${projectId}): the failure_verdict stored with its Failed transition does not parse: ${detail}`);
    this.name = "StoredFailureVerdictCorrupt";
  }
}

export interface ParkedFailureDeps extends FailureRecoveryDeps {
  /** Blocks the project of an item whose stored verdict does not parse, for the operator to repair. */
  readonly projects: Pick<ActiveProjects, "block">;
}

/**
 * Routes a parked Failed item, one whose routing a dead process or an orchestrator error cut off
 * after its Failed transition was saved, by the verdict saved with that transition:
 * a non-retryable failure is given up and spends no retry, a retryable one is replanned within the
 * bound. A row that failed before 058 holds no verdict and is routed as retryable work within the
 * bound. A stored verdict that does not parse is read as neither: replanning could spend a retry
 * the verdict forbids, and abandoning could throw away work another attempt would finish and open a
 * plan repair on a guess. Its project is blocked as Ashara's own fault, the policy for a work item
 * row that does not parse, and the item is left Failed: `held`.
 */
export async function recoverParkedFailedItem(
  deps: ParkedFailureDeps,
  item: WorkItem,
  failure: RawFailureContext,
): Promise<FailureDecision["action"] | "held"> {
  const stored = item.failureVerdict;
  switch (stored.kind) {
    case "recorded":
      return recoverFailedItem(deps, item, failure, stored.verdict);
    case "none":
      return recoverFailedItem(deps, item, failure, WORK_FAILED);
    case "unreadable": {
      const corrupt = new StoredFailureVerdictCorrupt(item.id, item.projectId, stored.detail);
      const result = await deps.projects.block(item.projectId, projectBlockCause(corrupt));
      deps.logger.error("delivery.failure-verdict-corrupt", `left Failed, not routed; project ${item.projectId} ${result}: ${corrupt.message}`, {
        taskId: item.id,
        projectId: item.projectId,
        result,
      }, corrupt);
      return "held";
    }
  }
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
    const decision = routeDecision(deps, item, failure, priorAttempts, verdict);

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
  deps: Pick<FailureRecoveryDeps, "failureRouter" | "logger">,
  item: WorkItem,
  failure: RawFailureContext,
  priorAttempts: number,
  verdict: FailureVerdict,
): FailureDecision {
  try {
    return deps.failureRouter.route({ item: { id: item.id }, failure, priorAttempts, verdict });
  } catch (error) {
    deps.logger.error("delivery.failure-route-failed", "FailureRouter.route failed; abandoning fail-closed so dependents do not deadlock", { taskId: item.id }, error);
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
  deps.logger.error(
    "delivery.failure-recovery-failed",
    "recovery internals failed (route/save); abandoning fail-closed so the item does not strand at Failed",
    { taskId: item.id },
    error,
  );
  const fresh = await deps.workItemRepo.findById(item.id);
  if (fresh === null) throw new WorkItemNotFound(item.id);
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
  replanWorkItem(item, { attempt, detail: failure.detail, raw: failure.raw });
  await PlanningService.saveWorkItem(deps.workItemRepo, item, previousStatus);
  await publishEvents(deps, item);
}

async function applyAbandon(
  deps: Pick<FailureRecoveryDeps, "workItemRepo" | "eventPublisher" | "logger">,
  item: WorkItem,
  reason: StoredBlockedReason,
): Promise<void> {
  const previousStatus = item.status;
  abandonWorkItem(item, reason);
  await PlanningService.saveWorkItem(deps.workItemRepo, item, previousStatus);
  await publishEvents(deps, item);
}

async function publishEvents(deps: Pick<FailureRecoveryDeps, "eventPublisher" | "logger">, item: WorkItem): Promise<void> {
  const events = takeEvents(item);
  for (const event of events) {
    try {
      await deps.eventPublisher.publish(event);
    } catch (publishError) {
      // eslint-disable-next-line ashara/catch-continue -- best effort: the status transition is committed before its events are published; domain_events is an operator audit log (GET /events is the bearer route) that no verdict, counter, charge or client text reads
      deps.logger.warn(
        "delivery.event-publish-failed",
        `failed to publish audit event for ${item.id} (status transition already committed)`,
        { taskId: item.id, site: "failure-recovery.publishEvents", eventType: event.eventType },
        publishError,
      );
    }
  }
}
