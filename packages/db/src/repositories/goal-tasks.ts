import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import type { DbHandle } from "../connection.js";
import { workItems } from "../schema/index.js";

/**
 * A goal task: a Task the plan's decomposition wrote (work_items.level 'Task', task_spec.origin
 * 'decomposition'). Its work kind is not part of the definition: the plan store derives it from
 * the origin, so it restates the origin and is null on a task planned before owners were assigned.
 * This is the one definition; SQL and in-memory readers both take it from here. It lives with the
 * work_items schema, beside the other predicates several contexts read the shared tables by
 * (pendingRepair, noOpenStop): Delivery, Engagement's delivered report and Quality's acceptance
 * readiness all read it, and only db is reachable from all three without crossing an ACL.
 */
const GOAL_TASK_LEVEL = "Task";
const GOAL_TASK_ORIGIN = "decomposition";

/** Whether a work item, as its row records its level and task_spec.origin, is a goal task. */
export function isGoalTask(item: { readonly level: string; readonly origin: string | null }): boolean {
  return item.level === GOAL_TASK_LEVEL && item.origin === GOAL_TASK_ORIGIN;
}

/** isGoalTask as a condition on a work_items row, for a query whose FROM names work_items unaliased. */
export const goalTaskSql: SQL = sql`(${workItems.level} = ${GOAL_TASK_LEVEL} AND ${workItems.taskSpec}->>'origin' = ${GOAL_TASK_ORIGIN})`;

/** The project's Completed goal tasks (isGoalTask), oldest completion first. */
export async function completedGoalTasks(db: DbHandle, projectId: string): Promise<Array<typeof workItems.$inferSelect>> {
  return db
    .select()
    .from(workItems)
    .where(
      and(
        eq(workItems.projectId, projectId),
        eq(workItems.status, "Completed"),
        goalTaskSql,
      ),
    )
    .orderBy(asc(workItems.updatedAt), asc(workItems.id));
}
