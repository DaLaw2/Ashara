import { WorkItemRepository as DbWorkItemRepository } from "@ashara/db";
import type { WorkItemId } from "@ashara/shared";
import {
  parseWorkItemLevel,
  parseWorkItemStatus,
  parseStoredTaskSpec,
  parseStoredBlockedReason,
  parseStoredSuccessCriteria,
  parseRunScope,
} from "@ashara/shared";
import type { WorkItem, WorkItemRepository } from "@ashara/planning";

/**
 * Bridges the db persistence repository (Drizzle row shape, nullable columns) to
 * the planning domain WorkItemRepository port (domain WorkItem shape, optional
 * fields). Extracted from the composition root so both the server wiring and the
 * bulk-plan facade wiring in tests share ONE adapter (mig9-t5) rather than
 * duplicating the row↔domain mapping.
 */

type DbRow = Awaited<ReturnType<DbWorkItemRepository["findById"]>>;

export function rowToWorkItem(row: NonNullable<DbRow>): WorkItem {
  return {
    id: row.id as WorkItemId,
    level: parseWorkItemLevel(row.level),
    status: parseWorkItemStatus(row.status),
    parentId: (row.parentId as WorkItemId) ?? undefined,
    title: row.title,
    description: row.description ?? undefined,
    taskSpec: parseStoredTaskSpec(row.taskSpec),
    northStar: row.northStar ?? undefined,
    successCriteria: parseStoredSuccessCriteria(row.successCriteria),
    blockedReason: parseStoredBlockedReason(row.blockedReason),
    runScope: parseRunScope(row.runScope),
    dispatchCount: row.dispatchCount,
    createdAt: row.createdAt ?? new Date(),
    updatedAt: row.updatedAt ?? new Date(),
    events: [],
  };
}

export function adaptWorkItemRepo(db: DbWorkItemRepository): WorkItemRepository {
  return {
    async create(item) {
      const row = await db.create({
        id: item.id,
        level: item.level,
        status: item.status,
        parentId: item.parentId ?? null,
        title: item.title,
        description: item.description ?? null,
        taskSpec: item.taskSpec ?? null,
        northStar: item.northStar ?? null,
        successCriteria: item.successCriteria ?? null,
        runScope: item.runScope,
      });
      return rowToWorkItem(row);
    },
    async findById(id) {
      const row = await db.findById(id);
      return row ? rowToWorkItem(row) : null;
    },
    async findByStatus(status) {
      const rows = await db.findByStatus(status);
      return rows.map(rowToWorkItem);
    },
    async save(item, expectedPreviousStatus) {
      await db.save(
        {
          id: item.id,
          status: item.status,
          blockedReason: item.blockedReason ?? null,
          updatedAt: item.updatedAt,
        },
        expectedPreviousStatus,
      );
    },
    async incrementDispatchCount(id) {
      return db.incrementDispatchCount(id);
    },
    async listAll() {
      const rows = await db.listAll();
      return rows.map(rowToWorkItem);
    },
    async addDependency(fromId, toId) {
      await db.addDependency(fromId, toId);
    },
    async getDependencies(itemId) {
      const ids = await db.getDependencies(itemId);
      return ids as WorkItemId[];
    },
    async findChildren(parentId) {
      const rows = await db.findChildren(parentId);
      return rows.map(rowToWorkItem);
    },
    async findDuplicate(level, title, parentId) {
      const row = await db.findDuplicate(level, title, parentId ?? null);
      return row ? rowToWorkItem(row) : null;
    },
    async listAllDependencies() {
      const rows = await db.listAllDependencies();
      return rows as Array<{ fromId: WorkItemId; toId: WorkItemId }>;
    },
    async withTransaction(fn) {
      return db.withTransaction((txDb) => fn(adaptWorkItemRepo(txDb)));
    },
  };
}
