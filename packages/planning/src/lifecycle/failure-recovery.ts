import { describeErrorChain } from "@ashara/shared";
import type { StoredBlockedReason } from "@ashara/shared";
import type { WorkItem, WorkItemRepository } from "../domain/index.js";
import { PlanningService, replanWorkItem, abandonWorkItem, takeEvents } from "../domain/index.js";
import type { FailureRouter, FailureDecision, RawFailureContext } from "../failure-router.js";
import { classifyFailure, tryParseEnvelope } from "../failure-classifier.js";
import type { FailureCategory } from "../failure-classifier.js";
import type { EventPublisher } from "./ports.js";

export interface FailureRecoveryDeps {
  readonly workItemRepo: WorkItemRepository;
  readonly eventPublisher: EventPublisher;
  readonly failureRouter: Pick<FailureRouter, "route">;
}

export async function recoverFailedItem(
  deps: FailureRecoveryDeps,
  item: WorkItem,
  failure: RawFailureContext,
): Promise<FailureDecision["action"]> {
  const priorAttempts = item.dispatchCount;

  try {
    // Classify the failure so the router can short-circuit categories that
    // must not consume the replan bound (e.g. TREE_REGRESSION — the merged
    // tree is broken, not the task's own changes). Always returns a category
    // (VERIFICATION_GAP for unparseable envelopes) because the router's
    // category field is required.
    const category = classifyFromRaw(failure);

    const decision = routeDecision(
      deps.failureRouter,
      item,
      failure,
      priorAttempts,
      category,
    );

    switch (decision.action) {
      case "replan":
        await applyReplan(deps, item, decision.attempt, decision.failure);
        return "replan";

      case "abandon":
        await applyAbandon(deps, item, {
          reason: decision.reason,
          attempts: decision.attempts,
          lastFailure: decision.failure,
          source: "failure_router",
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
  category: FailureCategory,
): FailureDecision {
  try {
    return failureRouter.route({
      item: { id: item.id },
      failure,
      priorAttempts,
      category,
    });
  } catch (error) {
    console.warn(
      `[${item.id}] FailureRouter.route failed; abandoning fail-closed so dependents do not deadlock:`,
      error,
    );
    return { action: "abandon", reason: "failure_router_error", attempts: priorAttempts, failure };
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
    reason: "failure_router_error",
    detail: describeErrorChain(error),
    attempts: priorAttempts,
    lastFailure: failure,
    source: "failure_router",
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

/**
 * Derives the FailureCategory from the raw failure context. Always returns a
 * category — never undefined — because the FailureRouter's category field is
 * required: an absent category would silently bypass the category-specific
 * routing (e.g. the zero-replan bound for TREE_REGRESSION). When the raw
 * payload is not a valid ErrorEnvelope, returns VERIFICATION_GAP — the same
 * fail-closed default classifyFailure itself uses for unknown operations.
 * This means an unparseable envelope replans normally (bounded), which is
 * conservative: replanning costs money but does not silently pass.
 */
function classifyFromRaw(failure: RawFailureContext): FailureCategory {
  // RawFailureContext.raw is Record<string, unknown> — tryParseEnvelope
  // validates whether it conforms to the ErrorEnvelope shape.
  const envelope = tryParseEnvelope(failure.raw);
  return envelope ? classifyFailure(envelope) : "VERIFICATION_GAP";
}
