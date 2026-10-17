import { and, eq, isNull, ne, or, desc, sql } from "drizzle-orm";
import { knowledgeEntries } from "@ashara/db";
import type { Database } from "@ashara/db";

export class KnowledgeRepository {
  constructor(private readonly db: Database) {}

  async storeKnowledgeFinding(
    projectId: string,
    taskId: string,
    epicId: string | null,
    title: string,
    content: string,
    tags: string[],
  ) {
    await this.db.insert(knowledgeEntries).values({
      kind: "finding",
      title,
      content,
      source: `task:${taskId}`,
      projectId,
      epicId,
      sourceTaskId: taskId,
      eventTime: new Date(),
      tags,
    });
  }

  /**
   * Task-scoped knowledge injection. Combines:
   *   - project scope: only `projectId`'s rows, so two
   *     projects on one database never see each other's findings.
   *   - epic scope: within the project, `epic_id = epicId` or a row written
   *     outside any epic (`epic_id IS NULL`, a project-wide note). A task with no epic
   *     ancestor (`epicId === null`) matches only the project-wide rows.
   *   - lexical relevance: `ts_rank` over `plainto_tsquery` ranks matches by
   *     relevance to the task's own spec text; a blank query or no lexical overlap
   *     falls back to recency via the `eventTime` tiebreak.
   */
  async recentFindingsScoped(projectId: string, epicId: string | null, queryText: string, limit: number) {
    const trimmedQuery = queryText.trim();
    const epicScope = epicId
      ? or(eq(knowledgeEntries.epicId, epicId), isNull(knowledgeEntries.epicId))
      : isNull(knowledgeEntries.epicId);
    // Cast, not a bare integer literal: a bare `0` in ORDER BY is SQL92
    // ordinal-position syntax ("column 0") and Postgres rejects it outright —
    // `0::real` is a real-typed constant instead, matching ts_rank's return type.
    const relevance =
      trimmedQuery.length > 0
        ? sql`ts_rank(to_tsvector('english', ${knowledgeEntries.title} || ' ' || ${knowledgeEntries.content}), plainto_tsquery('english', ${trimmedQuery}))`
        : sql`0::real`;

    return this.db
      .select({
        title: knowledgeEntries.title,
        contentSnippet: sql<string>`LEFT(${knowledgeEntries.content}, 200)`,
        source: knowledgeEntries.source,
      })
      .from(knowledgeEntries)
      .where(
        and(
          eq(knowledgeEntries.projectId, projectId),
          ne(knowledgeEntries.freshness, "archived"),
          ne(knowledgeEntries.kind, "decision"),
          epicScope,
        ),
      )
      .orderBy(desc(relevance), desc(knowledgeEntries.eventTime))
      .limit(limit);
  }
}
