import type { WorkItemId, WorkItemLevel, WorkItemStatus } from "@ashara/shared";

import type { WorkItem } from "./work-item.js";

export interface WorkItemRepository {
  create(item: WorkItem): Promise<WorkItem>;
  findById(id: WorkItemId): Promise<WorkItem | null>;
  findByStatus(status: WorkItemStatus): Promise<WorkItem[]>;
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
  listAll(): Promise<WorkItem[]>;
  /** Records that fromId depends on toId — fromId cannot start until toId completes. */
  addDependency(fromId: WorkItemId, toId: WorkItemId): Promise<void>;
  getDependencies(itemId: WorkItemId): Promise<WorkItemId[]>;
  findChildren(parentId: WorkItemId): Promise<WorkItem[]>;
  findDuplicate(level: WorkItemLevel, title: string, parentId?: WorkItemId): Promise<WorkItem | null>;
  listAllDependencies(): Promise<Array<{ fromId: WorkItemId; toId: WorkItemId }>>;
  /**
   * Runs `fn` atomically. The repository handed to the callback is
   * transaction-scoped: creating a batch of work items AND their dependency
   * edges commits or rolls back as one unit (ADR-029). Callers wrap
   * create-then-addDependency loops in this so a mid-loop failure never leaves
   * an item persisted without its declared edges.
   */
  withTransaction<T>(fn: (repo: WorkItemRepository) => Promise<T>): Promise<T>;
}
