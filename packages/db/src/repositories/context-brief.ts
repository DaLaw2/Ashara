import { and, eq, ne, asc, desc, sql } from "drizzle-orm";

import type { Database } from "../connection.js";
import { workItems } from "../schema.js";

export class ContextBriefRepository {
  constructor(private readonly db: Database) {}

  async getExistingItems() {
    return this.db
      .select({
        id: workItems.id,
        level: workItems.level,
        title: workItems.title,
        status: workItems.status,
        description: sql<string>`COALESCE(${workItems.description}, '')`,
      })
      .from(workItems)
      .where(
        and(
          ne(workItems.status, "Archived"),
          sql`(${workItems.status} <> 'Abandoned' OR ${workItems.blockedReason} ->> 'substitutedBy' IS NOT NULL)`,
        ),
      )
      .orderBy(asc(workItems.createdAt));
  }

  async getRecentCompletions(limit: number) {
    return this.db
      .select({
        title: workItems.title,
        summary: sql<string>`COALESCE(${workItems.description}, '')`,
      })
      .from(workItems)
      .where(
        and(eq(workItems.level, "Task"), eq(workItems.status, "Completed")),
      )
      .orderBy(desc(workItems.updatedAt))
      .limit(limit);
  }
}
