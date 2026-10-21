import { Column, and, asc, eq, inArray, is, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { z } from "zod";
import { qualifiedColumn, taskChecks } from "@ashara/db";
import type { DbHandle } from "@ashara/db";

// Quality's published language for a task's stored checks (task_checks): which revision of them is
// in force and how a stored check records the vision items it decides. Each is spelled here once;
// a reader in another context imports it (`@ashara/quality/stored-checks`) instead of writing it
// again. This module imports nothing else of Quality, so a context Quality reads can import it
// without a cycle at load time.

/**
 * task_checks.decides: the ids of the vision items a stored check decides, never none; null on a
 * row written before the column existed, which decides nothing on record.
 */
export const StoredDecidesSchema = z.tuple([z.string().min(1)], z.string().min(1)).nullable();

/** A column named with its table, so a select list does not hand the subquery a bare name it would read as its own; an aliased reference as written. */
const named = (ref: AnyColumn | SQL): SQL => (is(ref, Column) ? qualifiedColumn(ref) : ref);

/** The latest stored revision of the checks of the task `taskId` names, a scalar subquery: null when none is stored. */
export const latestCheckRevision = (taskId: AnyColumn | SQL): SQL<number | null> =>
  sql<number | null>`(SELECT max(latest_checks.revision) FROM task_checks latest_checks WHERE latest_checks.task_id = ${named(taskId)})`;

/** A task_checks row, named by its revision and task references, belongs to its task's latest revision: the checks in force. */
export const inLatestCheckRevision = (revision: AnyColumn | SQL, taskId: AnyColumn | SQL): SQL => sql`${named(revision)} = ${latestCheckRevision(taskId)}`;

/** One stored check of the latest revision of its task's checks, with what it decides as stored (StoredDecidesSchema reads it). */
export interface LatestStoredCheck {
  readonly taskId: string;
  readonly checkTaskId: string;
  readonly name: string;
  readonly decides: unknown;
}

/** The stored checks in force of the project's tasks, or of the tasks `taskIds` names, by task and name. */
export async function latestStoredChecks(db: DbHandle, of: { readonly projectId: string } | { readonly taskIds: readonly string[] }): Promise<LatestStoredCheck[]> {
  if ("taskIds" in of && of.taskIds.length === 0) return [];
  return db
    .select({ taskId: taskChecks.taskId, checkTaskId: taskChecks.checkTaskId, name: taskChecks.name, decides: taskChecks.decides })
    .from(taskChecks)
    .where(and("taskIds" in of ? inArray(taskChecks.taskId, [...of.taskIds]) : eq(taskChecks.projectId, of.projectId), inLatestCheckRevision(taskChecks.revision, taskChecks.taskId)))
    .orderBy(asc(taskChecks.taskId), asc(taskChecks.name));
}
