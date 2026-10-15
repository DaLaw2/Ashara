import { and, asc, eq, sql } from "drizzle-orm";
import type { DbHandle } from "../connection.js";
import { workItems } from "../schema/index.js";

/** The project's Completed goal tasks (decomposition), oldest completion first. */
export async function completedGoalTasks(db: DbHandle, projectId: string): Promise<Array<typeof workItems.$inferSelect>> {
  return db
    .select()
    .from(workItems)
    .where(
      and(
        eq(workItems.projectId, projectId),
        eq(workItems.level, "Task"),
        eq(workItems.status, "Completed"),
        sql`${workItems.taskSpec}->>'origin' = 'decomposition'`,
      ),
    )
    .orderBy(asc(workItems.updatedAt), asc(workItems.id));
}
