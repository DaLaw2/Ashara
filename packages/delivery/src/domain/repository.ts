import type { ProjectId, WorkItemId } from "@ashara/shared";
import type { MergeKind } from "../work-item-language/blocked-reason.js";
import type { WorkItemStatus } from "../work-item-language/work-item-status.js";
import type { ProjectBlockCause } from "../project-halt.js";
import type { CorrectionHoldOf, WorkItem } from "./work-item.js";

/** A Pending task a client correction holds, and that correction. */
interface CorrectionHeld {
  readonly taskId: WorkItemId;
  readonly hold: CorrectionHoldOf;
}

/** Which projects' work may be dispatched (active and not halted), and halting one. */
export interface ActiveProjects {
  listActiveIds(): Promise<ProjectId[]>;
  /**
   * Blocks an active project and records why; a project already
   * blocked keeps its first cause.
   */
  block(projectId: ProjectId, cause: ProjectBlockCause): Promise<"blocked" | "already-blocked">;
}

/**
 * The writes of a charge for a fault that is not a task's work, each in the transaction that holds
 * the task's project row and then its row locked: they commit with that lock's read of the task, or
 * not at all. The ledger exists only inside withItemLocked, and chargeInfrastructureFault is its one
 * user: no fault is counted on a task, nor its project halted for one, outside that lock.
 */
export interface LockedChargeLedger {
  /**
   * Counts one infrastructure fault on the item's dispatches and returns the count after it: the
   * durable bound of its uncharged requeues. Throws when the item does not exist.
   */
  recordInfrastructureFault(id: WorkItemId): Promise<number>;
  /** Blocks an active project and records why; a project already blocked keeps its first cause. */
  blockProject(projectId: ProjectId, cause: ProjectBlockCause): Promise<"blocked" | "already-blocked">;
}

/**
 * Reads of work items are per project: a row whose jsonb does not parse throws
 * WorkItemRowCorrupt naming its project, and fails that project's read only.
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
   * with InvalidStatusTransition. A move out of InProgress is a dispatch ending in
   * the process that started it, so the same write sets the item's count of startups in a row
   * found InProgress back to 0.
   */
  save(item: WorkItem, expectedPreviousStatus: WorkItemStatus): Promise<void>;
  /**
   * Atomically increments the item's dispatch counter and returns the new value.
   * A single `dispatch_count = dispatch_count + 1` UPDATE,
   * so it is crash-safe at the dispatch seam: it commits before the agent runs and
   * survives an agent crash, a discarded output, or any downstream throw. Distinct
   * from `save` — it does NOT transition status, so it never competes with the
   * state-machine pre-image guard.
   */
  incrementDispatchCount(id: WorkItemId): Promise<number>;
  /**
   * Persists a transition out of a dispatch (as `save`) and gives back the dispatch the seam counted,
   * in one transaction: the attempt was stopped before any work the retry bound should charge (a
   * refusal, a fault beneath it, a routing that sends it back to wait). Returns the count after
   * the refund. Throws, writing neither, when the save fails or no counted dispatch is there to
   * refund: a refund is never separable from the routing it belongs to, so no routing commits with
   * its attempt left charged.
   */
  saveRefunded(item: WorkItem, expectedPreviousStatus: WorkItemStatus): Promise<number>;
  /**
   * Counts one more startup in a row that found the item InProgress, left by a process that died
   * in a single UPDATE, and returns the count after it: the durable bound of its
   * re-dispatches after a crash. Throws when the item does not exist.
   */
  recordCrashOrphan(id: WorkItemId): Promise<number>;
  /**
   * {@link saveRefunded}, raising in the same transaction the largest context window an attempt of
   * the item did not fit to `windowTokens`, never lowering it: the item is dispatched next only on
   * a model whose window is larger. Returns the dispatch count after the refund. Throws, writing
   * none of the three, when any fails: a requeue never commits without the window that sends it to
   * a wider model, nor the window without its requeue.
   */
  saveRefundedOverflow(item: WorkItem, expectedPreviousStatus: WorkItemStatus, windowTokens: number): Promise<number>;
  /**
   * The startup reconciler's move of a crash orphan out of InProgress: written as `save` writes it,
   * except that its count of startups in a row found InProgress is kept, since its dispatch did not
   * end in the process that started it (every other move out of InProgress sets the count back to
   * 0 in its own write). With "refund", the dead process's counted dispatch is taken back in the
   * same transaction, as saveRefunded does.
   */
  saveOrphanExit(item: WorkItem, expectedPreviousStatus: WorkItemStatus, refund: "refund" | "keep-counted"): Promise<void>;
  /**
   * Records the merge commit Z0's merge step made on the target's main for the task:
   * the one record of what was merged, which reports to the client read. Throws when the
   * item does not exist; the caller writes it before completing the task, so a failed write
   * leaves the task not Completed. `kind` is how the commit closed it; null only
   * for a merge parked before its kind was recorded.
   */
  recordMergeCommit(id: WorkItemId, commit: string, kind: MergeKind | null): Promise<void>;
  /** Records that fromId depends on toId — fromId cannot start until toId completes. */
  addDependency(fromId: WorkItemId, toId: WorkItemId): Promise<void>;
  getDependencies(itemId: WorkItemId): Promise<WorkItemId[]>;
  findChildren(parentId: WorkItemId): Promise<WorkItem[]>;
  /** The edges whose dependent (from) item belongs to the project. */
  listDependenciesByProject(projectId: ProjectId): Promise<Array<{ fromId: WorkItemId; toId: WorkItemId }>>;
  /**
   * The project's Pending Tasks citing a key of a client correction that awaits its plan revision,
   * each with the earliest such correction, whatever the task's status was when it was recorded.
   */
  listCorrectionHeld(projectId: ProjectId): Promise<CorrectionHeld[]>;
  /**
   * Runs `fn` atomically. The repository handed to the callback is
   * transaction-scoped: creating a batch of work items AND their dependency
   * edges commits or rolls back as one unit. Callers wrap
   * create-then-addDependency loops in this so a mid-loop failure never leaves
   * an item persisted without its declared edges.
   */
  withTransaction<T>(fn: (repo: WorkItemRepository) => Promise<T>): Promise<T>;
  /**
   * Runs `fn` in one transaction that holds the item's project row and then the item's row locked,
   * handing it the item as read under that lock (null when it is gone) and the ledger whose writes
   * commit with it. An owner's transition of the item either commits before the read, which sees
   * it, or waits for this transaction's commit.
   */
  withItemLocked<T>(item: Pick<WorkItem, "id" | "projectId">, fn: (locked: WorkItem | null, ledger: LockedChargeLedger) => Promise<T>): Promise<T>;
}
