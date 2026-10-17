import { and, asc, eq, sql } from "drizzle-orm";
import type { DbHandle } from "../connection.js";
import { workItems } from "../schema/index.js";

/**
 * A goal task: a Task the plan's decomposition wrote (work_items.level 'Task', task_spec.origin
 * 'decomposition'). Its work kind is not part of the definition: the plan store derives it from
 * the origin, so it restates the origin and is null on a task planned before owners were assigned.
 * This is the one definition; SQL and in-memory readers both take it from here.
 */
const GOAL_TASK_LEVEL = "Task";
const GOAL_TASK_ORIGIN = "decomposition";

/** Whether a work item, as its row records its level and task_spec.origin, is a goal task. */
export function isGoalTask(item: { readonly level: string; readonly origin: string | null }): boolean {
  return item.level === GOAL_TASK_LEVEL && item.origin === GOAL_TASK_ORIGIN;
}

/** The project's Completed goal tasks (isGoalTask), oldest completion first. */
export async function completedGoalTasks(db: DbHandle, projectId: string): Promise<Array<typeof workItems.$inferSelect>> {
  return db
    .select()
    .from(workItems)
    .where(
      and(
        eq(workItems.projectId, projectId),
        eq(workItems.level, GOAL_TASK_LEVEL),
        eq(workItems.status, "Completed"),
        sql`${workItems.taskSpec}->>'origin' = ${GOAL_TASK_ORIGIN}`,
      ),
    )
    .orderBy(asc(workItems.updatedAt), asc(workItems.id));
}
