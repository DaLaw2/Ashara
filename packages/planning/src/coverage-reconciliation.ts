import type {
  ProjectId,
  ProjectContract,
  ContractDelta,
  Endpoint,
  WorkItemId,
  WorkItemStatus,
  StoredTaskSpec,
  ContractRepository,
} from "@ashara/shared";
import { parseProjectId, TERMINAL_STATUSES } from "@ashara/shared";
import type { EndpointCoverageGap } from "./run-summary.js";
import type { WorkItem, WorkItemRepository, CoverageHold } from "./domain/index.js";
import {
  PlanningService,
  createPendingWorkItem,
  COVERAGE_TASK_ORIGIN,
} from "./domain/index.js";
import {
  deriveEndpointFeatureKey,
  deriveEndpointResourceKey,
  endpointHasGroupingPrefix,
} from "./contract-derivation.js";
import { amendContractWithRetry } from "./contract-retry.js";

/**
 * Plan reconciliation (mig9-t2, ADR-032 §2, register-gap closer half 2). A
 * DETERMINISTIC check — zero LLM calls, reads only the persisted ProjectContract
 * plus the work-item statuses — that answers "does the plan actually produce
 * every endpoint the contract declares?". The Run-9 failure it closes: the
 * "User Registration" story rolled up Completed while POST /api/register was
 * never built, because nothing reconciled the declared endpoint (t1's
 * spec-derivation) against the plan.
 *
 * Coverage predicate (both signals counted, per the design guidance):
 *  - an endpoint is COVERED when its `sourceModule` is set (a completed task's
 *    contract amend recorded a serving module — the mig9-t4 completion signal),
 *    OR when its `declaredBy` names a work item that is `Completed` (the task
 *    that planned it actually produced it).
 *  - otherwise it is an OPEN gap: `unplanned` when no work item declares it at
 *    all (declaredBy unset — the reconciler proposes a task), or `planned-unbuilt`
 *    when a task declares it but has not completed.
 * Interim note: until mig9-t4 lands its completion amend, `sourceModule` is
 * rarely set, so the live signal is "a completed declaring task". An endpoint
 * whose declaring task FAILED/Abandoned stays an open gap here but is the
 * FailureRouter's concern to replan (t4) — the reconciler only proposes tasks
 * for genuinely UNPLANNED endpoints, never re-plans a failed one.
 */

/**
 * What reconciliation decides about a single contract endpoint (Run-11 schism +
 * out-of-scope fix). Only `planned-unbuilt` and `unplanned` are BLOCKING gaps
 * (they keep the run cycling and hold parent rollup); `duplicate` and
 * `out-of-scope` are NOT blocking:
 *  - `covered` — a completed task or a recorded serving module produced it.
 *  - `planned-unbuilt` — a task declares it but has not completed (blocking gap).
 *  - `unplanned` — no task plans it AND it is a genuine new feature grounded in the
 *    plan/vision (blocking gap; reconciliation proposes a task for it).
 *  - `duplicate` — an unplanned endpoint whose FEATURE identity (grouping-prefix-
 *    collapsed, see deriveEndpointFeatureKey) matches a planned/built endpoint, or
 *    another unplanned twin chosen as canonical. It is the Run-11 dual-namespace
 *    schism (POST /api/auth/login re-declaring POST /api/login) — collapsed onto
 *    its twin, never tasked, never a gap.
 *  - `out-of-scope` — a spec-derivation invention whose resource appears in NEITHER
 *    the plan NOR the vision (Run-11's logout/refresh/me class). Surfaced as an
 *    owner-visible gap (kind "out-of-scope") carrying its reason, but NOT auto-tasked
 *    and NOT counted as a blocking gap, so it can neither burn budget as a dispatched
 *    duplicate nor deadlock the run as a never-closing hole. `needsMarker` is true
 *    when this verdict was freshly derived from the corpus and must be PERSISTED onto
 *    the contract endpoint (`outOfScope: true`), so the corpus-less readers — the
 *    rollup guard and the termination completeness check — can honor it without
 *    re-deriving scope they cannot compute.
 */
type EndpointDisposition =
  | { readonly kind: "covered" }
  | { readonly kind: "planned-unbuilt"; readonly gap: EndpointCoverageGap }
  | { readonly kind: "unplanned"; readonly gap: EndpointCoverageGap }
  | { readonly kind: "duplicate" }
  | { readonly kind: "out-of-scope"; readonly gap: EndpointCoverageGap; readonly needsMarker: boolean };

const MIN_GROUNDING_TOKEN_LENGTH = 3;
const MIN_STEM_MATCH_LENGTH = 4;

/** Lowercased alphanumeric tokens of length ≥ MIN_GROUNDING_TOKEN_LENGTH. */
function tokenizeScope(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length >= MIN_GROUNDING_TOKEN_LENGTH) out.add(raw);
  }
  return out;
}

/**
 * Whether a resource key is grounded in the scope corpus (vision + plan text
 * tokens). A segment matches a token exactly, or as a stem where the shorter of
 * the two is ≥ MIN_STEM_MATCH_LENGTH and one is a prefix of the other — so
 * "register" grounds against "registration" but "logout" never grounds against a
 * bare "log"/"login" token (min-length + no shared prefix). Total.
 */
function corpusGrounds(resource: string, tokens: ReadonlySet<string>): boolean {
  for (const seg of resource.split(".")) {
    if (seg.length === 0) continue;
    for (const token of tokens) {
      if (seg === token) return true;
      if (
        Math.min(seg.length, token.length) >= MIN_STEM_MATCH_LENGTH &&
        (seg.startsWith(token) || token.startsWith(seg))
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Chooses the ONE canonical endpoint among unplanned twins of the same feature
 * (neither of which is anchored by a task/build): prefer a decomposition-sourced
 * declaration over a spec-derivation one, then the shorter path (the un-prefixed
 * namespace, e.g. /api/login over /api/auth/login), then lexical order. Total.
 */
function pickCanonicalTwin(bucket: readonly Endpoint[]): Endpoint {
  return [...bucket].sort((a, b) => {
    const aSpec = a.source === "spec-derivation" ? 1 : 0;
    const bSpec = b.source === "spec-derivation" ? 1 : 0;
    if (aSpec !== bSpec) return aSpec - bSpec;
    const aSeg = a.path.split("/").filter((s) => s.length > 0).length;
    const bSeg = b.path.split("/").filter((s) => s.length > 0).length;
    if (aSeg !== bSeg) return aSeg - bSeg;
    return a.path.localeCompare(b.path);
  })[0]!;
}

/**
 * Classifies every contract endpoint in one pass (Run-11 schism + out-of-scope
 * fix). Pure and total. `scopeTokens` is the vision+plan corpus used to decide
 * whether a GROUPED spec-derivation endpoint is out-of-scope; `undefined` means
 * "cannot judge scope" (the read-only termination/rollup path), under which no
 * endpoint is ever demoted to out-of-scope — genuine unplanned endpoints stay
 * blocking gaps, exactly as before this change.
 */
function classifyEndpoints(
  contract: ProjectContract,
  statusById: ReadonlyMap<string, WorkItemStatus>,
  scopeTokens: ReadonlySet<string> | undefined,
): Map<string, EndpointDisposition> {
  const anchoredFeatureKeys = new Set<string>();
  const groundedResources = new Set<string>();
  for (const e of contract.endpoints) {
    const anchored = e.declaredBy !== undefined || e.sourceModule !== undefined;
    if (anchored) anchoredFeatureKeys.add(deriveEndpointFeatureKey(e.method, e.path));
    // A resource is grounded when a decomposition-planned endpoint (source is not
    // spec-derivation) names it, or when any endpoint has actually been built/planned
    // — spec-derivation's own inventions never ground themselves.
    if (e.source !== "spec-derivation" || anchored) {
      groundedResources.add(deriveEndpointResourceKey(e.path));
    }
  }

  // Among unplanned endpoints with NO anchored twin, keep one canonical per feature
  // so two unplanned namespaces of the same feature still collapse to a single task.
  const unplannedByFeature = new Map<string, Endpoint[]>();
  for (const e of contract.endpoints) {
    if (e.declaredBy !== undefined || e.sourceModule !== undefined) continue;
    const fk = deriveEndpointFeatureKey(e.method, e.path);
    if (anchoredFeatureKeys.has(fk)) continue;
    const bucket = unplannedByFeature.get(fk);
    if (bucket) bucket.push(e);
    else unplannedByFeature.set(fk, [e]);
  }
  const canonicalRefs = new Set<string>();
  for (const bucket of unplannedByFeature.values()) canonicalRefs.add(pickCanonicalTwin(bucket).ref);

  const dispositions = new Map<string, EndpointDisposition>();
  for (const e of contract.endpoints) {
    if (e.sourceModule !== undefined) {
      dispositions.set(e.ref, { kind: "covered" });
      continue;
    }
    if (e.declaredBy !== undefined) {
      const status = statusById.get(e.declaredBy);
      dispositions.set(
        e.ref,
        status === "Completed"
          ? { kind: "covered" }
          : {
              kind: "planned-unbuilt",
              gap: {
                ref: e.ref,
                method: e.method,
                path: e.path,
                purpose: e.purpose,
                kind: "planned-unbuilt",
                reason:
                  `Endpoint ${e.method} ${e.path} is declared by work item ${e.declaredBy}, ` +
                  `but that task is ${status ?? "missing"} (not Completed) — the endpoint is not yet produced.`,
              },
            },
      );
      continue;
    }
    const fk = deriveEndpointFeatureKey(e.method, e.path);
    if (anchoredFeatureKeys.has(fk) || !canonicalRefs.has(e.ref)) {
      dispositions.set(e.ref, { kind: "duplicate" }); // namespace twin of planned/built or canonical work
      continue;
    }
    const resource = deriveEndpointResourceKey(e.path);
    // A DURABLE verdict already persisted on the endpoint is honored directly, so the
    // corpus-less readers (rollup guard, termination) agree with reconciliation
    // without recomputing scope. Otherwise the verdict is derived FRESH from the
    // corpus (criterion 2): only when we can judge scope (scopeTokens present) AND the
    // endpoint is a spec-derivation invention under a grouping prefix (the /api/auth/*
    // class) whose resource is grounded in neither the plan's endpoints nor the
    // vision/plan text. A top-level spec-derived endpoint (e.g. /api/register
    // recovering the Run-9 gap) is never gated. A freshly-derived verdict sets
    // needsMarker so reconcileCoverage persists it.
    const alreadyMarked = e.outOfScope === true;
    const freshlyOutOfScope =
      scopeTokens !== undefined &&
      e.source === "spec-derivation" &&
      endpointHasGroupingPrefix(e.path) &&
      !groundedResources.has(resource) &&
      !corpusGrounds(resource, scopeTokens);
    if (alreadyMarked || freshlyOutOfScope) {
      dispositions.set(e.ref, {
        kind: "out-of-scope",
        needsMarker: !alreadyMarked,
        gap: {
          ref: e.ref,
          method: e.method,
          path: e.path,
          purpose: e.purpose,
          kind: "out-of-scope",
          reason:
            `Endpoint ${e.method} ${e.path} was introduced by spec-derivation but its resource ` +
            `appears in neither the plan nor the vision — recorded OUT-OF-SCOPE for owner review; ` +
            `no task is auto-created (ADR-032 §2).`,
        },
      });
    } else {
      dispositions.set(e.ref, {
        kind: "unplanned",
        gap: {
          ref: e.ref,
          method: e.method,
          path: e.path,
          purpose: e.purpose,
          kind: "unplanned",
          reason: `Endpoint ${e.method} ${e.path} is declared in the contract but no work item plans it.`,
        },
      });
    }
  }
  return dispositions;
}

/**
 * Whether a coverage gap BLOCKS the run — keeps it from completing and holds parent
 * rollup. `unplanned` and `planned-unbuilt` block; `out-of-scope` is informational
 * (owner-visible but never counted). The single definition of "blocking", shared by
 * the rollup guard here and the orchestrator's completeness check, so the two can
 * never disagree.
 */
export function isBlockingCoverageGap(gap: EndpointCoverageGap): boolean {
  return gap.kind !== "out-of-scope";
}

/**
 * Computes the coverage gaps for a project from its contract and work-item statuses.
 * Emits every gap-bearing endpoint — `planned-unbuilt`, genuine `unplanned`, AND
 * durably-marked `out-of-scope` (kind "out-of-scope", so consumers can tell it apart
 * and treat it as non-blocking). Duplicates (dual-namespace twins) are excluded
 * entirely. Pure and total; returns [] when there is no contract. This read-only
 * path has no vision/plan corpus, so it NEVER derives a NEW out-of-scope verdict — it
 * only honors the DURABLE `outOfScope` marker reconciliation already persisted; an
 * unmarked unplanned endpoint stays a blocking gap exactly as before.
 */
export function computeCoverageGaps(
  contract: ProjectContract | null,
  workItems: readonly Pick<WorkItem, "id" | "status">[],
): EndpointCoverageGap[] {
  if (!contract) return [];
  const statusById = new Map<string, WorkItemStatus>(workItems.map((w) => [w.id, w.status]));
  const dispositions = classifyEndpoints(contract, statusById, undefined);
  const gaps: EndpointCoverageGap[] = [];
  for (const d of dispositions.values()) {
    if (d.kind === "planned-unbuilt" || d.kind === "unplanned" || d.kind === "out-of-scope") gaps.push(d.gap);
  }
  return gaps;
}

export interface CoverageRollupGuardDeps {
  readonly workItemRepo: WorkItemRepository;
  readonly contractRepo: ContractRepository;
  /** When false the guard is disabled entirely (observe-only mode) — returns undefined. */
  readonly enforcing: boolean;
}

/**
 * Builds the rollup HOLD predicate (criterion 2): a parent (story/feature/epic)
 * must NOT settle Completed while its PROJECT has an open coverage gap. Returns
 * `undefined` in observe-only mode, which `LifecycleRouter.cascadeCompletion`
 * treats as "no hold" — the rollback path. Endpoints are project-scoped (the
 * contract is keyed by the project root), so the guard resolves the parent's root
 * and checks that one contract; reads run against committed state, which is what
 * the declaredBy-task statuses live in. Holds ONLY on BLOCKING gaps — an
 * out-of-scope endpoint the run deliberately will not build never freezes rollup
 * (r12-t1: the deadlock the durable marker closes).
 */
export function createCoverageRollupGuard(deps: CoverageRollupGuardDeps): CoverageHold | undefined {
  if (!deps.enforcing) return undefined;
  return async (parent: WorkItem): Promise<boolean> => {
    const rootId = await resolveProjectRootId(deps.workItemRepo, parent);
    const contract = await deps.contractRepo.getLatest(parseProjectId(rootId));
    if (!contract) return false;
    const items = await deps.workItemRepo.listAll();
    return computeCoverageGaps(contract, items).some(isBlockingCoverageGap);
  };
}

export interface CoverageReconciliationDeps {
  readonly workItemRepo: WorkItemRepository;
  readonly contractRepo: ContractRepository;
  /**
   * Shares one transaction between the coverage-task creation and the contract
   * amend that links it (declaredBy), so a proposal never persists without its
   * link. Absent (or observe-only) ⇒ no proposals are created; gaps are still
   * computed and returned for logging + the run summary.
   */
  readonly withPlanningTransaction?: <T>(
    fn: (repos: { workItemRepo: WorkItemRepository; contractRepo: ContractRepository }) => Promise<T>,
  ) => Promise<T>;
  /** ENFORCING creates task proposals for unplanned endpoints; observe-only logs+reports only. */
  readonly enforcing: boolean;
  readonly runScope: string;
}

/**
 * The per-cycle reconciliation pass (criterion 1). For every project with a
 * contract it computes the open coverage gaps; in ENFORCING mode it routes each
 * UNPLANNED endpoint to planning as a proposed Task (child of the project root)
 * and amends the contract to link that task via `declaredBy` — the same
 * seed-once-then-amend protocol decomposition uses, and idempotent because a
 * linked endpoint is no longer unplanned. Returns every open gap found (both
 * modes) so the caller can log them and surface them in the run summary. Zero
 * LLM calls.
 */
export async function reconcileCoverage(deps: CoverageReconciliationDeps): Promise<EndpointCoverageGap[]> {
  const allItems = await deps.workItemRepo.listAll();
  const roots = allItems.filter((item) => item.parentId === undefined && !TERMINAL_STATUSES.has(item.status));
  const statusById = new Map<string, WorkItemStatus>(allItems.map((w) => [w.id, w.status]));
  const parentById = new Map<string, string | undefined>(allItems.map((w) => [w.id, w.parentId]));

  const allGaps: EndpointCoverageGap[] = [];
  for (const root of roots) {
    const projectId = parseProjectId(root.id);
    const contract = await deps.contractRepo.getLatest(projectId);
    if (!contract) continue;

    // Scope corpus: the project root's OWN intent (vision) plus every planned work
    // item's text under it, so a grouped spec-derivation endpoint the vision or the
    // plan genuinely names is not mislabeled out-of-scope.
    const projectItems = allItems.filter((item) => rootOf(item.id, parentById) === root.id);
    const corpusText = [
      root.northStar ?? "",
      ...projectItems.flatMap((item) => [item.title, item.description ?? ""]),
    ].join(" ");
    const scopeTokens = tokenizeScope(corpusText);
    const dispositions = classifyEndpoints(contract, statusById, scopeTokens);

    const toPropose: Endpoint[] = [];
    const toMarkOutOfScope: Endpoint[] = [];
    for (const endpoint of contract.endpoints) {
      const disposition = dispositions.get(endpoint.ref);
      if (!disposition) continue;
      // Surface blocking gaps AND out-of-scope inventions to the caller (the owner-
      // visible run summary + reconciliation log) — out-of-scope endpoints are
      // recorded here rather than silently minted as tasks (criterion 2).
      if (
        disposition.kind === "planned-unbuilt" ||
        disposition.kind === "unplanned" ||
        disposition.kind === "out-of-scope"
      ) {
        allGaps.push(disposition.gap);
      }
      if (disposition.kind === "unplanned") toPropose.push(endpoint);
      if (disposition.kind === "out-of-scope" && disposition.needsMarker) toMarkOutOfScope.push(endpoint);
    }

    if (!deps.enforcing || !deps.withPlanningTransaction) continue; // observe-only: report, do not create

    // Persist the freshly-derived out-of-scope verdict onto the contract FIRST, so the
    // corpus-less rollup guard + termination check honor it this very cycle — the
    // durable fix for the deadlock (an out-of-scope endpoint that is neither tasked
    // nor demotable would otherwise block completeness forever).
    for (const endpoint of toMarkOutOfScope) {
      await markEndpointOutOfScope(deps, projectId, endpoint);
    }

    // Only GENUINE unplanned endpoints become tasks — duplicates (dual-namespace
    // twins) and out-of-scope inventions are deliberately not proposed.
    for (const endpoint of toPropose) {
      await proposeCoverageTask(deps, root.id, projectId, endpoint);
    }
  }
  return allGaps;
}

/**
 * Creates ONE coverage Task for an unplanned endpoint and links it into the
 * contract, atomically. Re-checks inside the transaction so a concurrent
 * reconciler (or a completion amend) that already claimed the endpoint short-
 * circuits — no duplicate proposal per ref.
 */
async function proposeCoverageTask(
  deps: CoverageReconciliationDeps,
  rootId: WorkItemId,
  projectId: ProjectId,
  endpoint: Endpoint,
): Promise<void> {
  await deps.withPlanningTransaction!(async ({ workItemRepo, contractRepo }) => {
    const latest = await contractRepo.getLatest(projectId);
    const current = latest?.endpoints.find((e) => e.ref === endpoint.ref);
    if (!current || current.declaredBy !== undefined || current.sourceModule !== undefined) {
      return; // already planned or built between the read and here
    }

    const task = createPendingWorkItem(
      "Task",
      `Create ${endpoint.method} ${endpoint.path} endpoint`,
      deps.runScope,
      rootId,
      `Implement the ${endpoint.method} ${endpoint.path} endpoint (${endpoint.purpose}). ` +
        `Declared in the project contract but not covered by any planned task ` +
        `(coverage reconciliation, ADR-032 §2).`,
      buildCoverageTaskSpec(endpoint),
    );
    const created = await PlanningService.createWorkItem(workItemRepo, task);

    const delta: ContractDelta = { endpoints: [{ ...current, declaredBy: created.id }] };
    await amendContractWithRetry(contractRepo, projectId, delta);
  });
}

/**
 * Persists the durable `outOfScope` marker onto ONE contract endpoint, atomically.
 * Re-checks inside the transaction: skips if the endpoint got planned/built (a task
 * arrived) or is already marked between the read and here, so the write is
 * idempotent and never overrides a now-legitimate endpoint.
 */
async function markEndpointOutOfScope(
  deps: CoverageReconciliationDeps,
  projectId: ProjectId,
  endpoint: Endpoint,
): Promise<void> {
  await deps.withPlanningTransaction!(async ({ contractRepo }) => {
    const latest = await contractRepo.getLatest(projectId);
    const current = latest?.endpoints.find((e) => e.ref === endpoint.ref);
    if (!current || current.declaredBy !== undefined || current.sourceModule !== undefined) return;
    if (current.outOfScope === true) return; // already marked

    const delta: ContractDelta = { endpoints: [{ ...current, outOfScope: true }] };
    await amendContractWithRetry(contractRepo, projectId, delta);
  });
}

/** Walks the parent chain to the project root (the ancestor with no parent). Total. */
function rootOf(id: string, parentById: ReadonlyMap<string, string | undefined>): string {
  const seen = new Set<string>();
  let current = id;
  for (;;) {
    if (seen.has(current)) return current; // cycle guard (fail-closed)
    seen.add(current);
    const parent = parentById.get(current);
    if (parent === undefined) return current;
    current = parent;
  }
}

function buildCoverageTaskSpec(endpoint: Endpoint): StoredTaskSpec {
  return {
    goal: `Implement the ${endpoint.method} ${endpoint.path} endpoint`,
    endState: `${endpoint.method} ${endpoint.path} responds with the correct status and body`,
    checks: [`${endpoint.method} ${endpoint.path} is reachable and returns the expected response`],
    deliverables: [],
    // Marks this as a backstop gap-fill so dispatch (TaskSelector) ranks it below
    // primary decomposition work — a Run-11 core endpoint never starves behind it.
    origin: COVERAGE_TASK_ORIGIN,
  };
}

async function resolveProjectRootId(repo: WorkItemRepository, item: WorkItem): Promise<WorkItemId> {
  let current = item;
  while (current.parentId) {
    const parent = await repo.findById(current.parentId);
    if (!parent) break;
    current = parent;
  }
  return current.id;
}
