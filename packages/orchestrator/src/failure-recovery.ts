import type { WorkItemStatus, ProjectContract } from "@ashara/shared";
import type { EventStoreRepository } from "@ashara/db";
import type { WorkItem, WorkItemRepository } from "@ashara/planning-domain";
import { PlanningService, replanWorkItem, abandonWorkItem, takeEvents } from "@ashara/planning-domain";
import type { FailureRouter, FailureDecision, RawFailureContext } from "@ashara/planning";
import { selectModulePaths } from "@ashara/development";

/**
 * Loads the ProjectContract for the project a failed item belongs to (mig9-t4), so
 * the FailureRouter can find a substitute by the contract module/endpoint registry
 * rather than title alone. Injected (composition root resolves item → project root
 * → latest contract); absent, recovery keeps the title-only equivalence unchanged.
 */
export interface ContractRegistryLookup {
  loadForItem(item: { id: string; parentId?: string }): Promise<ProjectContract | null>;
}

export interface FailureRecoveryDeps {
  readonly workItemRepo: WorkItemRepository;
  readonly eventStore: Pick<EventStoreRepository, "publish">;
  readonly failureRouter: FailureRouter;
  readonly contractLookup?: ContractRegistryLookup;
}

/**
 * Maps each work item to the contract-registry keys ATTRIBUTED to it: module paths
 * it provides (providerWorkItem) and endpoint refs it declared (declaredBy),
 * namespaced so a module path can never collide with an endpoint ref. This is the
 * contract side of the equivalence signal the router matches on.
 */
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

/**
 * The module-path keys a work item's OWN declared deliverables imply — the item's
 * assigned share of the module registry, read from its taskSpec. Included alongside
 * the contract-attributed keys so two siblings assigned the SAME module (duplicate
 * work) are recognised as equivalent even when their titles differ and neither has
 * yet been recorded as the contract's provider of that path.
 *
 * Filtered through `selectModulePaths` (the SAME rule the completion amend uses):
 * entry points, tests, and .d.ts files are dropped so those known-noise paths never
 * inflate the key set. Shared aggregators like src/routes/index.ts intentionally
 * STAY — the router's superset requirement, not this filter, is what stops a shared
 * aggregator from producing a false substitute.
 */
function deliverableModuleKeys(taskSpec: Record<string, unknown> | undefined): string[] {
  const raw = taskSpec?.deliverables;
  if (!Array.isArray(raw)) return [];
  const paths = raw.filter((entry): entry is string => typeof entry === "string");
  return selectModulePaths(paths, null).map((path) => `module:${path}`);
}

/**
 * The full registry-key set for an item: contract-attributed keys ∪ its own
 * declared deliverables. Gated on contract presence — when `contractKeys` is null
 * (a contract-less project) the item carries NO registry keys, so the router falls
 * back to title equivalence exactly as the criterion requires.
 */
function registryKeysFor(
  item: { id: string; taskSpec?: Record<string, unknown> },
  contractKeys: Map<string, string[]> | null,
): string[] {
  if (contractKeys === null) return [];
  return [...new Set([...(contractKeys.get(item.id) ?? []), ...deliverableModuleKeys(item.taskSpec)])];
}

/**
 * Loads the contract-attributed key map fail-soft, returning null when there is no
 * contract (or the lookup is absent / errors) so recovery proceeds on title
 * equivalence. A contract read must never break the recovery that stops dependents
 * deadlocking.
 */
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

/**
 * Turns a permanently-failed work item into an executed recovery (migration
 * Phase 6, ADR-029). The FailureRouter (Planning BC) decides; this orchestrator
 * seam ACTS on the decision via domain transitions and publishes the resulting
 * events — so a failure stops deadlocking its dependents (Run-8 C2 defect).
 *
 * `item` must be in `Failed` status. Returns the executed action.
 *
 * Fail-closed (Discipline A): if the router cannot produce a decision, the item
 * is abandoned rather than left Failed — a stuck item blocks its dependents
 * forever, which is the exact failure mode being fixed.
 */
export async function recoverFailedItem(
  deps: FailureRecoveryDeps,
  item: WorkItem,
  failure: RawFailureContext,
): Promise<FailureDecision["action"]> {
  // Prior attempts come straight off the loaded WorkItem's dispatch counter
  // (migration 018, r9f-t1): it is incremented at the dispatch seam, so by the time
  // an item is Failed it already counts the dispatch that just failed. No I/O, no
  // throw — the same source the termination seam and startup reconciler read, so the
  // three can never drift on "how many attempts has this had?".
  const priorAttempts = item.dispatchCount;

  // FAIL-CLOSED REGION (Discipline A + the L3 defect). findChildren and the
  // applyReplan/applyAbandon writes below all sit INSIDE this guard: a throw from any
  // of them (a rejected read, a stale-preimage save) must NOT escape and re-enter the
  // caller's generic catch — which would leave the item stranded at Failed
  // (handleTaskError's Failed->Failed guard no-ops) and deadlock dependents. On any
  // such throw we abandon-with-reason (failure_router_error) so the item reaches a
  // terminal state rather than a silent strand.
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

    const decision = routeDecision(
      deps.failureRouter,
      item,
      failure,
      priorAttempts,
      candidates,
      registryKeysFor(item, contractKeys),
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
        // Plumbing for Phase 6 task 2: the gate.ts/dependenciesMet semantics that
        // let a dependent be satisfied by the equivalent land in task 3. Until then
        // the failed duplicate is terminated (its twin already delivers the work),
        // recording the equivalent id so task 3 can route dependents to it.
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

/**
 * Routes the failure to a decision, catching a FailureRouter throw in-band: an
 * undecidable input (e.g. malformed raw context) abandons with `failure_router_error`
 * rather than propagating, so the switch above always acts on a concrete decision.
 */
function routeDecision(
  failureRouter: FailureRouter,
  item: WorkItem,
  failure: RawFailureContext,
  priorAttempts: number,
  candidates: ReadonlyArray<{ id: string; title: string; status: WorkItemStatus; registryKeys: readonly string[] }>,
  itemRegistryKeys: readonly string[],
): FailureDecision {
  try {
    return failureRouter.route({
      item: { id: item.id, title: item.title, parentId: item.parentId, registryKeys: itemRegistryKeys },
      failure,
      priorAttempts,
      planState: { candidates },
    });
  } catch (error) {
    console.warn(
      `[${item.id}] FailureRouter.route failed; abandoning fail-closed so dependents do not deadlock:`,
      error,
    );
    return { action: "abandon", reason: "failure_router_error", attempts: priorAttempts, failure };
  }
}

/**
 * Last-resort terminal transition when a recovery internal (a repository read such
 * as findChildren, or a status save) threw. Re-fetches the item so it abandons the
 * true persisted state (a failed applyReplan may have mutated the in-memory copy to
 * Pending while the row stayed Failed); if the fresh row is no longer Failed there
 * is nothing to strand. Extends the existing `failure_router_error` reason with the
 * captured error detail (Discipline C). If the abandon write itself throws, the
 * error propagates — the caller (core-loop generic catch / startup reconciler) logs
 * it and leaves the item Failed for the next startup reconcile: fail-closed, not
 * silent.
 */
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
    // A partial success already moved it off Failed (or a concurrent cycle did);
    // it is no longer stranded. Report abandon as the intended terminal outcome
    // without forcing an illegal transition on an item that has already advanced.
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
  // Carry the raw failure context into the re-planned record (Discipline C): the
  // next attempt's dispatch can read WHY the previous attempt failed. blockedReason
  // is the only field the physical writer persists on a status write, so the
  // context rides there rather than being dropped.
  item.blockedReason = {
    replanContext: { attempt, detail: failure.detail, raw: failure.raw },
  };
  await PlanningService.saveWorkItem(deps.workItemRepo, item, previousStatus);
  await publishEvents(deps, item);
}

/**
 * Exported so task-split.ts (the split-on-failure escape hatch, granularity-debate.md
 * §5 File 6) can abandon an oversized task via the SAME transition + audit-publish
 * path a FailureRouter substitute uses, tagged with its own `source` so
 * RunSummary.classifyAbandon's provenance discrimination still holds.
 */
export async function applyAbandon(
  deps: Pick<FailureRecoveryDeps, "workItemRepo" | "eventStore">,
  item: WorkItem,
  reason: Record<string, unknown> & { readonly source: string },
): Promise<void> {
  const previousStatus = item.status;
  abandonWorkItem(item, reason);
  await PlanningService.saveWorkItem(deps.workItemRepo, item, previousStatus);
  await publishEvents(deps, item);
}

async function publishEvents(deps: Pick<FailureRecoveryDeps, "eventStore">, item: WorkItem): Promise<void> {
  // Best-effort audit publish: the recovery transition is already committed, so a
  // publish failure must be logged-and-swallowed, never propagated. If it escaped,
  // runCycle's generic per-task catch would mislabel it as an orchestrator error,
  // skip cost recording, and spuriously record a failed approach for a task that in
  // fact recovered (ADR-029; mirrors execution.ts publishBestEffort).
  const events = takeEvents(item);
  for (const event of events) {
    try {
      await deps.eventStore.publish(event, "Internal");
    } catch (publishError) {
      console.warn(
        `[failure-recovery.publishEvents] failed to publish audit event for ${item.id} (status transition already committed):`,
        publishError,
      );
    }
  }
}
