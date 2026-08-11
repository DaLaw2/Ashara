import type { WorkItemStatus, ProjectContract, StoredTaskSpec, StoredBlockedReason } from "@ashara/shared";
import type { WorkItem, WorkItemRepository } from "../domain/index.js";
import { PlanningService, replanWorkItem, abandonWorkItem, takeEvents } from "../domain/index.js";
import type { FailureRouter, FailureDecision, RawFailureContext } from "../failure-router.js";
import { classifyFailure, tryParseEnvelope } from "../failure-classifier.js";
import type { FailureCategory } from "../failure-classifier.js";
import type { EventPublisher } from "./ports.js";
import { deriveRetryChecks, deriveRetryDeliverables } from "./derive-retry-checks.js";

export interface ContractRegistryLookup {
  loadForItem(item: { id: string; parentId?: string }): Promise<ProjectContract | null>;
}

export interface FailureRecoveryDeps {
  readonly workItemRepo: WorkItemRepository;
  readonly eventPublisher: EventPublisher;
  readonly failureRouter: FailureRouter;
  readonly contractLookup?: ContractRegistryLookup;
}

function buildContractKeyMap(contract: ProjectContract): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const add = (owner: string, key: string): void => {
    const keys = map.get(owner);
    if (keys) keys.push(key);
    else map.set(owner, [key]);
  };
  for (const module of contract.modules) {
    if (module.providerWorkItem) add(module.providerWorkItem, `module:${module.path}`);
  }
  for (const endpoint of contract.endpoints) {
    if (endpoint.declaredBy) add(endpoint.declaredBy, `endpoint:${endpoint.ref}`);
  }
  return map;
}

function deliverableModuleKeys(
  taskSpec: StoredTaskSpec | undefined,
): string[] {
  const raw = taskSpec?.deliverables;
  if (!Array.isArray(raw)) return [];
  const paths = raw.filter((entry): entry is string => typeof entry === "string");
  return paths.map((path) => `module:${path}`);
}

function registryKeysFor(
  item: { id: string; taskSpec?: StoredTaskSpec },
  contractKeys: Map<string, string[]> | null,
): string[] {
  if (contractKeys === null) return [];
  return [...new Set([...(contractKeys.get(item.id) ?? []), ...deliverableModuleKeys(item.taskSpec)])];
}

async function loadContractKeyMap(
  deps: FailureRecoveryDeps,
  item: WorkItem,
): Promise<Map<string, string[]> | null> {
  if (!deps.contractLookup) return null;
  try {
    const contract = await deps.contractLookup.loadForItem({ id: item.id, parentId: item.parentId });
    return contract ? buildContractKeyMap(contract) : null;
  } catch (error) {
    console.warn(
      `[${item.id}] contract registry lookup failed; falling back to title equivalence:`,
      error,
    );
    return null;
  }
}

export async function recoverFailedItem(
  deps: FailureRecoveryDeps,
  item: WorkItem,
  failure: RawFailureContext,
): Promise<FailureDecision["action"]> {
  const priorAttempts = item.dispatchCount;

  try {
    const contractKeys = await loadContractKeyMap(deps, item);
    const siblings = item.parentId ? await deps.workItemRepo.findChildren(item.parentId) : [];
    const candidates = siblings
      .filter((sibling) => sibling.id !== item.id)
      .map((sibling) => ({
        id: sibling.id,
        title: sibling.title,
        status: sibling.status,
        registryKeys: registryKeysFor(sibling, contractKeys),
      }));

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
      candidates,
      registryKeysFor(item, contractKeys),
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

      case "substitute":
        console.log(
          `[${item.id}] FailureRouter: substitute via ${decision.equivalentId} — gate semantics land in mig6-t3; abandoning failed duplicate for now`,
        );
        await applyAbandon(deps, item, {
          reason: decision.reason,
          substitutedBy: decision.equivalentId,
          attempts: priorAttempts,
          lastFailure: decision.failure,
          source: "failure_router",
        });
        return "substitute";
    }
  } catch (error) {
    return abandonFailClosed(deps, item, failure, priorAttempts, error);
  }
}

function routeDecision(
  failureRouter: FailureRouter,
  item: WorkItem,
  failure: RawFailureContext,
  priorAttempts: number,
  candidates: ReadonlyArray<{ id: string; title: string; status: WorkItemStatus; registryKeys: readonly string[] }>,
  itemRegistryKeys: readonly string[],
  category: FailureCategory,
): FailureDecision {
  try {
    return failureRouter.route({
      item: { id: item.id, title: item.title, parentId: item.parentId, registryKeys: itemRegistryKeys },
      failure,
      priorAttempts,
      planState: { candidates },
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
    `[${item.id}] recovery internals failed (findChildren/route/save); abandoning fail-closed so the item does not strand at Failed:`,
    error,
  );
  const fresh = (await deps.workItemRepo.findById(item.id)) ?? item;
  if (fresh.status !== "Failed") {
    return "abandon";
  }
  await applyAbandon(deps, fresh, {
    reason: "failure_router_error",
    detail: error instanceof Error ? error.message : String(error),
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

  const spec = item.taskSpec ?? {};
  const existingChecks = spec.checks ?? [];
  const existingDeliverables = spec.deliverables ?? [];

  const mergedChecks = deriveRetryChecks(failure, existingChecks);
  const mergedDeliverables = deriveRetryDeliverables(failure, existingDeliverables);

  if (mergedChecks.length !== existingChecks.length || mergedDeliverables.length !== existingDeliverables.length) {
    item.taskSpec = { ...spec, checks: mergedChecks, deliverables: mergedDeliverables };
  }

  item.blockedReason = {
    source: "replan",
    replanContext: { attempt, detail: failure.detail, raw: failure.raw },
  };
  await PlanningService.saveWorkItem(deps.workItemRepo, item, previousStatus);
  await publishEvents(deps, item);
}

export async function applyAbandon(
  deps: Pick<FailureRecoveryDeps, "workItemRepo" | "eventPublisher">,
  item: WorkItem,
  reason: StoredBlockedReason,
): Promise<void> {
  const previousStatus = item.status;
  abandonWorkItem(item, reason);
  await PlanningService.saveWorkItem(deps.workItemRepo, item, previousStatus);
  await publishEvents(deps, item);
}

export async function publishEvents(deps: Pick<FailureRecoveryDeps, "eventPublisher">, item: WorkItem): Promise<void> {
  const events = takeEvents(item);
  for (const event of events) {
    try {
      await deps.eventPublisher.publish(event, "Internal");
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
