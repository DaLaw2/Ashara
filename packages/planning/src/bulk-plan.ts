import type { ProjectId, WorkItemId, ProjectKnowledge, StoredTaskSpec, ContractRepository } from "@ashara/shared";
import { parseWorkItemLevel } from "@ashara/shared";
import type { WorkItemRepository } from "./domain/index.js";
import {
  PlanningService,
  createPendingWorkItem,
  ContractAlreadyExists,
} from "./domain/index.js";
import { amendContractWithRetry } from "./contract-retry.js";

/**
 * Bulk plan creation WITH contract population (mig9-t5, ADR-028/ADR-029). A
 * project's first plan (FirstPlanner, through the server's first-plan store) is
 * a whole hierarchy (epic/task + edges); in the SAME transaction as item creation
 * this seeds or amends the project's knowledge graph. Fail-closed: a
 * contract-write failure (or any DB failure) rolls the whole batch back — no
 * partial hierarchy.
 */

export interface BulkPlanItem {
  readonly tempId: string;
  readonly level: string;
  readonly title: string;
  readonly description?: string;
  readonly parentId?: string;
  readonly taskSpec?: StoredTaskSpec;
  readonly northStar?: string;
}

export interface BulkPlanEdge {
  readonly from: string;
  readonly to: string;
}

/** A batch reference (parentId or edge endpoint) that names no item in the same batch. */
class BulkReferenceError extends Error {
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
  readonly runScope: string;
  /** The project every created item belongs to, and the key its contract is written under. */
  readonly projectId: ProjectId;
}

/**
 * Creates the whole bulk hierarchy and its dependency edges, then writes the
 * ProjectContract knowledge, all in one transaction. Reference resolution runs
 * inside the transaction so an unresolved parent/edge fails closed with nothing
 * persisted.
 *
 * `knowledge` is a REQUIRED POSITIONAL (ADR-052, following ADR-051's `unchecked`).
 * It was an optional field on `CreateBulkPlanDeps` with zero suppliers, defaulted
 * to `{nodes:[],edges:[]}` one line before use — so every project this path
 * created got a contract that stated nothing about its own stack. An optional
 * dependency is how an unwired producer still compiles; a positional cannot be
 * forgotten at the call site.
 */
export async function createBulkPlanWithContract(
  deps: CreateBulkPlanDeps,
  items: readonly BulkPlanItem[],
  edges: readonly BulkPlanEdge[],
  knowledge: ProjectKnowledge,
): Promise<BulkPlanResult> {
  return deps.withPlanningTransaction(async ({ workItemRepo, contractRepo }) => {
    const tempIdToId = new Map<string, WorkItemId>();

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
        deps.runScope,
        deps.projectId,
        parentRealId,
        spec.description,
        spec.taskSpec,
        spec.northStar,
      );
      const createdItem = await PlanningService.createWorkItem(workItemRepo, item);
      tempIdToId.set(spec.tempId, createdItem.id);
    }

    for (const edge of edges) {
      const fromId = tempIdToId.get(edge.from);
      if (fromId === undefined) throw new BulkReferenceError(edge.from, "edge_from");
      const toId = tempIdToId.get(edge.to);
      if (toId === undefined) throw new BulkReferenceError(edge.to, "edge_to");
      await workItemRepo.addDependency(fromId, toId);
    }

    await deriveAndWriteContract(contractRepo, deps.projectId, knowledge);

    const tempIdToIdRecord: Record<string, string> = {};
    for (const [tempId, id] of tempIdToId) tempIdToIdRecord[tempId] = id;
    return { tempIdToId: tempIdToIdRecord, created: tempIdToId.size };
  });
}

/**
 * Seeds the knowledge graph (writeContract) if the project has no contract, else
 * merges it (amendContract) — the seed-once-then-amend protocol. Keyed by the
 * project (projects.id, migration 014). The write is gated on what this call
 * actually adds: knowledge merges by KIND (applyContractDelta), so a delta
 * carrying only kinds already present is a no-op and must not mint a contract
 * version (ADR-046).
 */
async function deriveAndWriteContract(
  contractRepo: ContractRepository,
  projectId: ProjectId,
  knowledge: ProjectKnowledge,
): Promise<void> {
  const existing = await contractRepo.getLatest(projectId);
  if (!existing) {
    if (knowledge.nodes.length === 0) return;
    try {
      await PlanningService.writeContract(contractRepo, projectId, { knowledge });
      return;
    } catch (e) {
      if (!(e instanceof ContractAlreadyExists)) throw e;
    }
  }

  const establishedKinds = new Set((existing?.knowledge.nodes ?? []).map((n) => n.kind));
  if (!knowledge.nodes.some((n) => !establishedKinds.has(n.kind))) return;

  await amendContractWithRetry(contractRepo, projectId, { knowledge });
}
