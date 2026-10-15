import {
  parseWorkItemLevel,
  parseWorkItemStatus,
  parseWorkItemJsonb,
  parseProjectId,
  parseWorkKind,
  parseWorkItemId,
} from "@ashara/shared";
import type { WorkItemRowRepository } from "./work-item.js";
import type { WorkItem, WorkItemRepository } from "../domain/index.js";

/**
 * Bridges the db persistence repository (Drizzle row shape, nullable columns) to
 * the planning domain WorkItemRepository port (domain WorkItem shape, optional
 * fields). Extracted from the composition root so both the server wiring and the
 * bulk-plan facade wiring in tests share ONE adapter (mig9-t5) rather than
 * duplicating the row↔domain mapping.
 */

type DbRow = Awaited<ReturnType<WorkItemRowRepository["findById"]>>;

export function rowToWorkItem(row: NonNullable<DbRow>): WorkItem {
  const jsonb = parseWorkItemJsonb(row);
  return {
    id: parseWorkItemId(row.id, "work_items.id"),
    level: parseWorkItemLevel(row.level),
    status: parseWorkItemStatus(row.status),
    parentId: row.parentId === null ? undefined : parseWorkItemId(row.parentId, "work_items.parent_id"),
    title: row.title,
    description: row.description ?? undefined,
    taskSpec: jsonb.taskSpec,
    northStar: row.northStar ?? undefined,
    successCriteria: jsonb.successCriteria,
    blockedReason: jsonb.blockedReason,
    projectId: parseProjectId(row.projectId, "work_items.project_id"),
    dispatchCount: row.dispatchCount,
    workKind: row.workKind === null ? null : parseWorkKind(row.workKind),
    ...(row.ownerRoleId !== null ? { ownerRoleId: row.ownerRoleId } : {}),
    createdAt: row.createdAt ?? new Date(),
    updatedAt: row.updatedAt ?? new Date(),
    events: [],
  };
}

export function adaptWorkItemRepo(db: WorkItemRowRepository): WorkItemRepository {
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
        projectId: item.projectId,
        // Both or neither (work_items_owner_whole): a task created with its owner carries both.
        workKind: item.workKind,
        ownerRoleId: item.ownerRoleId ?? null,
      });
      return rowToWorkItem(row);
    },
    async findById(id) {
      const row = await db.findById(id);
      return row ? rowToWorkItem(row) : null;
    },
    async listByProject(projectId) {
      const rows = await db.listByProject(projectId);
      return rows.map(rowToWorkItem);
    },
    async findByProjectAndStatus(projectId, status) {
      const rows = await db.findByProjectAndStatus(projectId, status);
      return rows.map(rowToWorkItem);
    },
    async projectIdsWithStatus(status) {
      const ids = await db.projectIdsWithStatus(status);
      return ids.map((id) => parseProjectId(id, "work_items.project_id"));
    },
    async listIdsByStatus(statuses) {
      const ids = await db.listIdsByStatus(statuses);
      return ids.map((id) => parseWorkItemId(id, "work_items.id"));
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
    async refundDispatchCount(id) {
      return db.refundDispatchCount(id);
    },
    async recordInfrastructureFault(id) {
      return db.recordInfrastructureFault(id);
    },
    async recordMergeCommit(id, commit, kind) {
      await db.recordMergeCommit(id, commit, kind);
    },
    async addDependency(fromId, toId) {
      await db.addDependency(fromId, toId);
    },
    async getDependencies(itemId) {
      const ids = await db.getDependencies(itemId);
      return ids.map((id) => parseWorkItemId(id, "dependencies.to_id"));
    },
    async findChildren(parentId) {
      const rows = await db.findChildren(parentId);
      return rows.map(rowToWorkItem);
    },
    async listDependenciesByProject(projectId) {
      const rows = await db.listDependenciesByProject(projectId);
      return rows.map((row) => ({ fromId: parseWorkItemId(row.fromId, "dependencies.from_id"), toId: parseWorkItemId(row.toId, "dependencies.to_id") }));
    },
    async withTransaction(fn) {
      return db.withTransaction((txDb) => fn(adaptWorkItemRepo(txDb)));
    },
  };
}
