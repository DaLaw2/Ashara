import { desc, eq, isNull, or, sql } from "drizzle-orm";

import type { Database } from "../connection.js";
import { failedApproaches } from "../schema.js";

export class FailedApproachRepository {
  constructor(private readonly db: Database) {}

  async record(
    taskId: string | null,
    epicId: string | null,
    title: string,
    description: string,
    reason: string,
    learned: string,
    affectedArea: string,
  ) {
    await this.db.insert(failedApproaches).values({
      taskId,
      epicId,
      title,
      approachDescription: description,
      failureReason: reason,
      learned,
      affectedArea,
    });
  }

  /**
   * Task-scoped counterpart to `recentFindingsScoped` (kl-t2) — same epic-scope
   * + lexical-relevance combination, mirrored here because `failed_approaches`
   * is a separate table from `knowledge_entries`, not a shared query. See
   * `KnowledgeRepository.recentFindingsScoped` for the full rationale.
   */
  async failedApproachesScoped(epicId: string | null, queryText: string, limit: number) {
    const trimmedQuery = queryText.trim();
    const epicScope = epicId
      ? or(eq(failedApproaches.epicId, epicId), isNull(failedApproaches.epicId))
      : isNull(failedApproaches.epicId);
    // Cast, not a bare integer literal: a bare `0` in ORDER BY is SQL92
    // ordinal-position syntax ("column 0") and Postgres rejects it outright —
    // `0::real` is a real-typed constant instead, matching ts_rank's return type.
    const relevance =
      trimmedQuery.length > 0
        ? sql`ts_rank(to_tsvector('english', ${failedApproaches.title} || ' ' || ${failedApproaches.failureReason} || ' ' || ${failedApproaches.learned}), plainto_tsquery('english', ${trimmedQuery}))`
        : sql`0::real`;

    return this.db
      .select({
        title: failedApproaches.title,
        failureReason: failedApproaches.failureReason,
        learned: failedApproaches.learned,
        affectedArea: failedApproaches.affectedArea,
      })
      .from(failedApproaches)
      .where(epicScope)
      .orderBy(desc(relevance), desc(failedApproaches.recordedAt))
      .limit(limit);
  }
}
