import type { MergeKind, ProjectBlockCause, ProjectId, WorkItemId, WorkItemStatus } from "@ashara/shared";
import type { WorkItem } from "./work-item.js";

/** Which projects' work may be dispatched (projects.status = 'active'), and blocking one. */
export interface ActiveProjects {
  listActiveIds(): Promise<ProjectId[]>;
  /**
   * Blocks an active project and records why (migration 025); a project already
   * blocked keeps its first cause.
   */
  block(projectId: ProjectId, cause: ProjectBlockCause): Promise<"blocked" | "already-blocked">;
}

/**
 * Reads of work items are per project: a row whose jsonb does not parse throws
 * WorkItemRowCorrupt naming its project, and fails that project's read only
 * (story s-loop-never-stop-m1).
 */
export interface WorkItemRepository {
  create(item: WorkItem): Promise<WorkItem>;
  findById(id: WorkItemId): Promise<WorkItem | null>;
  /** One project's work items, oldest first. */
  listByProject(projectId: ProjectId): Promise<WorkItem[]>;
  /** One project's work items in `status`. */
  findByProjectAndStatus(projectId: ProjectId, status: WorkItemStatus): Promise<WorkItem[]>;
  /** The projects holding at least one item in `status`; reads no jsonb column. */
  projectIdsWithStatus(status: WorkItemStatus): Promise<ProjectId[]>;
  /** Ids of every item in one of `statuses`; reads no jsonb column. */
  listIdsByStatus(statuses: readonly WorkItemStatus[]): Promise<WorkItemId[]>;
  /**
   * Persists a status/metadata change. `expectedPreviousStatus` is the pre-image
   * the caller believes the row currently holds (typically the status the item was
   * loaded with, before a domain mutation). The physical writer validates the
   * transition against the state machine and against the live row, failing closed
   * with InvalidStatusTransition (ADR-029).
   */
  save(item: WorkItem, expectedPreviousStatus: WorkItemStatus): Promise<void>;
  /**
   * Atomically increments the item's dispatch counter and returns the new value
   * (migration 018, r9f-t1). A single `dispatch_count = dispatch_count + 1` UPDATE,
   * so it is crash-safe at the dispatch seam: it commits before the agent runs and
   * survives an agent crash, a discarded output, or any downstream throw. Distinct
   * from `save` — it does NOT transition status, so it never competes with the
   * state-machine pre-image guard.
   */
  incrementDispatchCount(id: WorkItemId): Promise<number>;
  /**
   * Gives back the dispatch the seam counted when the attempt was refused a model
   * call before doing any work the retry bound should charge (a spend-cap refusal).
   * A single `dispatch_count = dispatch_count - 1` UPDATE guarded on a positive
   * count; returns the new value and throws when no counted dispatch is there to refund.
   */
  refundDispatchCount(id: WorkItemId): Promise<number>;
  /**
   * Counts one infrastructure fault on the item's dispatches (migration 048) in a single UPDATE and
   * returns the count after it: the durable bound of its uncharged requeues. Throws when the item
   * does not exist.
   */
  recordInfrastructureFault(id: WorkItemId): Promise<number>;
  /**
   * Records the merge commit Z0's merge step made on the target's main for the task (migration
   * 041): the one record of what was merged, which reports to the client read. Throws when the
   * item does not exist; the caller writes it before completing the task, so a failed write
   * leaves the task not Completed. `kind` is how the commit closed it (migration 049); null only
   * for a merge whose kind was parked before 049 and so never recorded.
   */
  recordMergeCommit(id: WorkItemId, commit: string, kind: MergeKind | null): Promise<void>;
  /** Records that fromId depends on toId — fromId cannot start until toId completes. */
  addDependency(fromId: WorkItemId, toId: WorkItemId): Promise<void>;
  getDependencies(itemId: WorkItemId): Promise<WorkItemId[]>;
  findChildren(parentId: WorkItemId): Promise<WorkItem[]>;
  /** The edges whose dependent (from) item belongs to the project. */
  listDependenciesByProject(projectId: ProjectId): Promise<Array<{ fromId: WorkItemId; toId: WorkItemId }>>;
  /**
   * Runs `fn` atomically. The repository handed to the callback is
   * transaction-scoped: creating a batch of work items AND their dependency
   * edges commits or rolls back as one unit (ADR-029). Callers wrap
   * create-then-addDependency loops in this so a mid-loop failure never leaves
   * an item persisted without its declared edges.
   */
  withTransaction<T>(fn: (repo: WorkItemRepository) => Promise<T>): Promise<T>;
}
