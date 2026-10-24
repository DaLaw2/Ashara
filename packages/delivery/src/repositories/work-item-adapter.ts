import { parseProjectId, parseWorkItemId } from "@ashara/shared";
import { parseWorkItemLevel, parseWorkItemStatus } from "../work-item-language/work-item-status.js";
import { parseWorkItemJsonb } from "../work-item-language/work-item-row.js";
import { parseWorkKind } from "../acl/organization-acl.js";
import { failureVerdictSchema } from "../acl/quality-acl.js";
import type { FailureVerdict } from "../acl/quality-acl.js";
import { ProjectHaltRepository } from "./project-halt.js";
import type { WorkItemRowRepository } from "./work-item.js";
import type { StoredFailureVerdict, WorkItem, WorkItemRepository } from "../domain/index.js";

type DbRow = Awaited<ReturnType<WorkItemRowRepository["findById"]>>;

/**
 * The failure_verdict column read through Quality's schema. A value that does not
 * parse is kept as `unreadable` with its issues rather than thrown: only the routing of a Failed
 * item reads the verdict, and it takes that case's fail-closed path; every other read of the row
 * is unaffected.
 */
function storedFailureVerdictOf(raw: unknown): StoredFailureVerdict {
  if (raw === null) return { kind: "none" };
  const parsed = failureVerdictSchema.safeParse(raw);
  if (parsed.success) return { kind: "recorded", verdict: parsed.data };
  return { kind: "unreadable", detail: `${JSON.stringify(raw)}: ${JSON.stringify(parsed.error.issues)}` };
}

/** The columns `save` writes, from a domain WorkItem: the one mapping the adapter and the server's status route share. */
export function workItemSaveRow(item: WorkItem): {
  id: string;
  status: string;
  blockedReason: unknown;
  failureVerdict: FailureVerdict | null;
  updatedAt: Date;
} {
  return {
    id: item.id,
    status: item.status,
    // `undefined` means the domain method cleared it: Drizzle's `.set()` drops `undefined` keys
    // rather than writing SQL NULL, so it is normalized to `null` for the clear to clear.
    blockedReason: item.blockedReason ?? null,
    failureVerdict: item.failureVerdict.kind === "recorded" ? item.failureVerdict.verdict : null,
    updatedAt: item.updatedAt,
  };
}

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
    failureVerdict: storedFailureVerdictOf(row.failureVerdict),
    projectId: parseProjectId(row.projectId, "work_items.project_id"),
    dispatchCount: row.dispatchCount,
    workKind: row.workKind === null ? null : parseWorkKind(row.workKind),
    ...(row.ownerRoleId !== null ? { ownerRoleId: row.ownerRoleId } : {}),
    overflowedWindowTokens: row.overflowedWindowTokens,
    repairsTaskId: row.repairsTaskId === null ? null : parseWorkItemId(row.repairsTaskId, "work_items.repairs_task_id"),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    events: [],
  };
}

/**
 * Bridges the persistence repository (Drizzle row shape, nullable columns) to Delivery's
 * WorkItemRepository port (domain WorkItem shape, optional fields). The server's wiring and the
 * tests share this one adapter, so the row-to-domain mapping exists once.
 */
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
        repairsTaskId: item.repairsTaskId,
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
      await db.save(workItemSaveRow(item), expectedPreviousStatus);
    },
    async incrementDispatchCount(id) {
      return db.incrementDispatchCount(id);
    },
    async saveRefunded(item, expectedPreviousStatus) {
      return db.saveRefunded(workItemSaveRow(item), expectedPreviousStatus);
    },
    async recordCrashOrphan(id) {
      return db.recordCrashOrphan(id);
    },
    async saveRefundedOverflow(item, expectedPreviousStatus, windowTokens) {
      return db.saveRefundedOverflow(workItemSaveRow(item), expectedPreviousStatus, windowTokens);
    },
    async saveOrphanExit(item, expectedPreviousStatus, refund) {
      await db.saveOrphanExit(workItemSaveRow(item), expectedPreviousStatus, refund);
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
    async listCorrectionHeld(projectId) {
      const rows = await db.listCorrectionHeld(projectId);
      return rows.map(({ taskId, ...hold }) => ({ taskId: parseWorkItemId(taskId, "work_items.id"), hold }));
    },
    async withTransaction(fn) {
      return db.withTransaction((txDb) => fn(adaptWorkItemRepo(txDb)));
    },
    async withItemLocked(item, fn) {
      return db.withItemLocked(item.projectId, item.id, (row, txDb, tx) => {
        const projects = new ProjectHaltRepository(tx);
        return fn(row === null ? null : rowToWorkItem(row), {
          recordInfrastructureFault: (id) => txDb.recordInfrastructureFault(id),
          blockProject: (projectId, cause) => projects.block(projectId, cause),
        });
      });
    },
  };
}
