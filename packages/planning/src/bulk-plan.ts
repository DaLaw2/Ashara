import type { ProjectId, WorkItemId, StoredTaskSpec } from "@ashara/shared";
import { parseWorkItemLevel } from "@ashara/shared";
import type { WorkItemRepository } from "./domain/index.js";
import { PlanningService, createPendingWorkItem } from "./domain/index.js";

/**
 * Bulk plan creation (mig9-t5, ADR-029). A project's first plan or revision (through the
 * server's first-plan and replan stores) is a whole hierarchy (epic/task + edges), written
 * through a work-item repository bound to the caller's transaction. Fail-closed: any DB failure
 * or unresolved reference rolls the whole batch back, so no partial hierarchy is left.
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
    readonly context: "parent" | "edge_from" | "edge_to" | "checks_for",
  ) {
    super(`unresolved ${context} reference: "${reference}" is not a tempId in this batch`);
    this.name = "BulkReferenceError";
  }
}

/**
 * A check task's `checksFor` names the task it decides by temp id; it is stored as that task's
 * work item id. The task comes earlier in the batch, so the reference resolves when it is written.
 */
function resolveChecksFor(
  taskSpec: StoredTaskSpec | undefined,
  tempIdToId: ReadonlyMap<string, WorkItemId>,
): StoredTaskSpec | undefined {
  if (taskSpec?.checksFor === undefined) return taskSpec;
  const resolved = tempIdToId.get(taskSpec.checksFor);
  if (resolved === undefined) throw new BulkReferenceError(taskSpec.checksFor, "checks_for");
  return { ...taskSpec, checksFor: resolved };
}

export interface BulkPlanResult {
  readonly tempIdToId: Record<string, WorkItemId>;
  readonly created: number;
}

export interface CreateBulkPlanDeps {
  /**
   * The DOMAIN shape of the work-item repository (adapted by the composition root), bound to the
   * caller's transaction, so creation goes through PlanningService.
   */
  readonly workItemRepo: WorkItemRepository;
  /** The project every created item belongs to. */
  readonly projectId: ProjectId;
}

/**
 * Creates the whole bulk hierarchy and its dependency edges. Reference resolution runs inside the
 * caller's transaction, so an unresolved parent or edge fails closed with nothing persisted.
 */
export async function createBulkPlan(
  deps: CreateBulkPlanDeps,
  items: readonly BulkPlanItem[],
  edges: readonly BulkPlanEdge[],
): Promise<BulkPlanResult> {
  const { workItemRepo } = deps;
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
      deps.projectId,
      parentRealId,
      spec.description,
      resolveChecksFor(spec.taskSpec, tempIdToId),
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

  const tempIdToIdRecord: Record<string, WorkItemId> = {};
  for (const [tempId, id] of tempIdToId) tempIdToIdRecord[tempId] = id;
  return { tempIdToId: tempIdToIdRecord, created: tempIdToId.size };
}
