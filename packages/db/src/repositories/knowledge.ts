import { and, eq, isNull, ne, or, desc, sql } from "drizzle-orm";

import type { Database } from "../connection.js";
import { knowledgeEntries } from "../schema.js";

export class KnowledgeRepository {
  constructor(private readonly db: Database) {}

  async storeKnowledgeFinding(
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
      epicId,
      sourceTaskId: taskId,
      eventTime: new Date(),
      tags,
    });
  }

  async storeKnowledgeInsight(taskId: string | null, epicId: string | null, title: string, content: string) {
    await this.db.insert(knowledgeEntries).values({
      kind: "insight",
      title,
      content,
      source: taskId ? `task:${taskId}` : `task:insight`,
      epicId,
      sourceTaskId: taskId,
      eventTime: new Date(),
    });
  }

  async getDecisionsByEpic(epicId: string | null, limit: number) {
    return this.db
      .select({
        id: knowledgeEntries.id,
        kind: knowledgeEntries.kind,
        title: knowledgeEntries.title,
        contentSnippet: sql<string>`LEFT(${knowledgeEntries.content}, 200)`,
        sourceTaskId: knowledgeEntries.sourceTaskId,
      })
      .from(knowledgeEntries)
      .where(
        and(
          epicId ? eq(knowledgeEntries.epicId, epicId) : sql`TRUE`,
          eq(knowledgeEntries.kind, "decision"),
          ne(knowledgeEntries.freshness, "archived"),
        ),
      )
      .orderBy(desc(knowledgeEntries.eventTime))
      .limit(limit);
  }

  async getFindingsByStory(storyId: string, limit: number) {
    return this.db
      .select({
        id: knowledgeEntries.id,
        kind: knowledgeEntries.kind,
        title: knowledgeEntries.title,
        contentSnippet: sql<string>`LEFT(${knowledgeEntries.content}, 200)`,
        sourceTaskId: knowledgeEntries.sourceTaskId,
      })
      .from(knowledgeEntries)
      .where(
        and(
          sql`${knowledgeEntries.sourceTaskId} IN (SELECT id FROM work_items WHERE parent_id = ${storyId})`,
          ne(knowledgeEntries.freshness, "archived"),
        ),
      )
      .orderBy(desc(knowledgeEntries.eventTime))
      .limit(limit);
  }

  /**
   * Task-scoped knowledge injection (kl-t2, investigation Q3/Q5). Replaces the
   * unscoped `recentFindings(limit)` — every one of Run 10's 29 tasks got the
   * same byte-identical global top-10 because that query carried no epic or
   * relevance predicate at all. This combines both embedder-free levers the
   * investigation confirmed available:
   *   - epic scope (Q3a): `epic_id = epicId`, so a task in epic B never cites
   *     epic A's findings (the cross-project leak Q5 identified — `epic_id`
   *     had no predicate before). Rows with `epic_id IS NULL` are treated as
   *     explicitly global — they were never written into any epic's scope in
   *     the first place, so surfacing them everywhere is not a leak of
   *     someone else's project, just an unscoped note. A task with no epic
   *     ancestor (`epicId === null`) matches only that same explicitly-global
   *     set, never another task's epic-scoped rows (fail-closed).
   *   - lexical relevance (Q3b): `ts_rank` over `plainto_tsquery` ranks
   *     epic-scope matches by relevance to the task's own spec text instead of
   *     recency alone, so two tasks in the same epic no longer see an
   *     identical ordering either. An empty/blank `queryText` (or a query with
   *     no lexical overlap at all) falls back to recency via the `eventTime`
   *     tiebreak — never an empty result and never a crash.
   */
  async recentFindingsScoped(epicId: string | null, queryText: string, limit: number) {
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
          ne(knowledgeEntries.freshness, "archived"),
          ne(knowledgeEntries.kind, "decision"),
          epicScope,
        ),
      )
      .orderBy(desc(relevance), desc(knowledgeEntries.eventTime))
      .limit(limit);
  }
}
