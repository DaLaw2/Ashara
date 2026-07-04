import type { ContractInput, ProjectId, WorkItemId, ContractDelta, ProjectKnowledge } from "@ashara/shared";
import { parseProjectId, parseWorkItemLevel } from "@ashara/shared";
import type { WorkItem, WorkItemRepository, ContractRepository } from "@ashara/planning-domain";
import {
  PlanningService,
  createPendingWorkItem,
  ContractAlreadyExists,
  ContractVersionConflict,
} from "@ashara/planning-domain";

import {
  deriveContractFragment,
  toContractDelta,
  type DerivedTask,
  type DerivedTextSource,
} from "./contract-derivation.js";

/**
 * Bulk plan creation WITH contract population (mig9-t5, ADR-028/ADR-029). The CLI
 * `ashara vision` initial-epic path posts a whole hierarchy (epic/story/feature/
 * task + edges) to POST /work-items/bulk. Before this, that path created the work
 * items but wrote NO ProjectContract (the mig8-t2 first-decomposition coverage
 * hole), so a CLI-initiated project started contract-less until leaf-story
 * decomposition eventually fired.
 *
 * This moves the bulk logic behind a planning facade so the HTTP handler stays
 * thin, and — in the SAME transaction as item creation — derives the contract
 * fragment the explicit bulk items imply (endpoints/modules from task titles,
 * descriptions and deliverables; intent endpoints from story/feature text) via the
 * SAME deterministic machinery decomposition uses (contract-derivation.ts), then
 * seeds/merges it. No LLM call: the independent spec-derivation pass (mig9-t1)
 * stays in the planning loop where it fires once per project. Fail-closed: a
 * contract-write failure (or any DB failure) rolls the whole batch back — no
 * partial hierarchy, no work items without their contract.
 */

const MAX_CONTRACT_RETRY_ATTEMPTS = 3;

export interface BulkPlanItem {
  readonly tempId: string;
  readonly level: string;
  readonly title: string;
  readonly description?: string;
  readonly parentId?: string;
  readonly taskSpec?: Record<string, unknown>;
  readonly northStar?: string;
}

export interface BulkPlanEdge {
  readonly from: string;
  readonly to: string;
}

/** A batch reference (parentId or edge endpoint) that names no item in the same batch. */
export class BulkReferenceError extends Error {
  constructor(
    readonly reference: string,
    readonly context: "parent" | "edge_from" | "edge_to",
  ) {
    super(`unresolved ${context} reference: "${reference}" is not a tempId in this batch`);
    this.name = "BulkReferenceError";
  }
}

export interface BulkPlanResult {
  readonly tempIdToId: Record<string, string>;
  readonly created: number;
}

export interface CreateBulkPlanDeps {
  /**
   * Shares ONE transaction between item creation and the derived contract write
   * (the same fail-safe mig8-t2 gave decomposition): a contract failure rolls the
   * created items back. The work-item repo is the DOMAIN shape (adapted by the
   * composition root), so creation goes through PlanningService.
   */
  readonly withPlanningTransaction: <T>(
    fn: (repos: { workItemRepo: WorkItemRepository; contractRepo: ContractRepository }) => Promise<T>,
  ) => Promise<T>;
  readonly knowledge?: ProjectKnowledge;
}

/**
 * Creates the whole bulk hierarchy and its dependency edges, then derives and
 * writes the ProjectContract, all in one transaction. Reference resolution runs
 * inside the transaction so an unresolved parent/edge fails closed with nothing
 * persisted.
 */
export async function createBulkPlanWithContract(
  deps: CreateBulkPlanDeps,
  items: readonly BulkPlanItem[],
  edges: readonly BulkPlanEdge[],
): Promise<BulkPlanResult> {
  return deps.withPlanningTransaction(async ({ workItemRepo, contractRepo }) => {
    const tempIdToId = new Map<string, WorkItemId>();
    const created: WorkItem[] = [];

    for (const spec of items) {
      const level = parseWorkItemLevel(spec.level);
      let parentRealId: WorkItemId | undefined;
      if (spec.parentId !== undefined) {
        const resolved = tempIdToId.get(spec.parentId);
        if (resolved === undefined) throw new BulkReferenceError(spec.parentId, "parent");
        parentRealId = resolved;
      }

      const item = createPendingWorkItem(
        level,
        spec.title,
        parentRealId,
        spec.description,
        spec.taskSpec,
        spec.northStar,
      );
      const createdItem = await PlanningService.createWorkItem(workItemRepo, item);
      tempIdToId.set(spec.tempId, createdItem.id);
      created.push(createdItem);
    }

    for (const edge of edges) {
      const fromId = tempIdToId.get(edge.from);
      if (fromId === undefined) throw new BulkReferenceError(edge.from, "edge_from");
      const toId = tempIdToId.get(edge.to);
      if (toId === undefined) throw new BulkReferenceError(edge.to, "edge_to");
      await workItemRepo.addDependency(fromId, toId);
    }

    await deriveAndWriteContract(contractRepo, created, deps.knowledge ?? { nodes: [], edges: [] });

    const tempIdToIdRecord: Record<string, string> = {};
    for (const [tempId, id] of tempIdToId) tempIdToIdRecord[tempId] = id;
    return { tempIdToId: tempIdToIdRecord, created: tempIdToId.size };
  });
}

/**
 * Derives the contract fragment the created hierarchy implies and seeds it
 * (writeContract) if the project has no contract, else merges it (amendContract) —
 * the SAME seed-once-then-amend protocol decomposition uses. A no-op fragment
 * (nothing recognized) writes nothing, so an endpoint-less plan never seeds a
 * contentless contract. Keyed by the single project ROOT (the item with no
 * parent); a batch without exactly one root skips the contract (nothing else in
 * the system knows how to key it).
 */
async function deriveAndWriteContract(
  contractRepo: ContractRepository,
  created: readonly WorkItem[],
  knowledge: ProjectKnowledge,
): Promise<void> {
  const roots = created.filter((item) => item.parentId === undefined);
  if (roots.length !== 1) return;
  const root = roots[0]!;

  const tasks: DerivedTask[] = created
    .filter((item) => item.level === "Task")
    .map((item) => ({ id: item.id, title: item.title, description: derivationText(item) }));
  const intentSources: DerivedTextSource[] = created
    .filter((item) => item.level !== "Task")
    .map((item) => ({ title: item.title, description: item.description ?? "" }));

  const fragment = deriveContractFragment(intentSources, tasks);
  if (fragment.endpoints.length === 0 && fragment.modules.length === 0) return;

  const projectId = parseProjectId(root.id);
  const existing = await contractRepo.getLatest(projectId);
  if (!existing) {
    const body: ContractInput = {
      knowledge,
      endpoints: fragment.endpoints,
      modules: fragment.modules,
      mounts: [],
    };
    try {
      await PlanningService.writeContract(contractRepo, projectId, body);
      return;
    } catch (e) {
      if (!(e instanceof ContractAlreadyExists)) throw e;
    }
  }
  await amendContractWithRetry(contractRepo, projectId, toContractDelta(fragment));
}

/**
 * The text a task contributes to endpoint/module derivation: its description plus
 * the file paths its taskSpec.deliverables name (so "src/routes/register.ts" and
 * "POST /api/register endpoint" deliverables feed the derivation, matching the
 * mig9-t5 guidance that task specs/deliverables surface endpoints/modules).
 */
function derivationText(item: WorkItem): string {
  const parts: string[] = [item.description ?? ""];
  const deliverables = item.taskSpec?.["deliverables"];
  if (Array.isArray(deliverables)) {
    for (const entry of deliverables) {
      if (typeof entry === "string") parts.push(entry);
    }
  }
  return parts.join(" ");
}

async function amendContractWithRetry(
  contractRepo: ContractRepository,
  projectId: ProjectId,
  delta: ContractDelta,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_CONTRACT_RETRY_ATTEMPTS; attempt++) {
    try {
      await PlanningService.amendContract(contractRepo, projectId, delta);
      return;
    } catch (e) {
      lastError = e;
      if (!(e instanceof ContractVersionConflict)) throw e;
    }
  }
  throw lastError;
}
