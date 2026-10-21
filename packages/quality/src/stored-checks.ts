import { Column, is, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { z } from "zod";
import { qualifiedColumn } from "@ashara/db";

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
