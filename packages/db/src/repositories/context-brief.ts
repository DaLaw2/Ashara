import { and, eq, ne, asc, desc, sql } from "drizzle-orm";

import type { Database } from "../connection.js";
import {
  visionDocuments,
  fileChanges,
  knowledgeEntries,
  failedApproaches,
  workItems,
} from "../schema.js";

export class ContextBriefRepository {
  constructor(private readonly db: Database) {}

  async getLatestVision() {
    const [row] = await this.db
      .select({
        visionText: visionDocuments.visionText,
        summary: visionDocuments.summary,
        inferences: visionDocuments.inferences,
        scopeBoundaries: visionDocuments.scopeBoundaries,
        confirmedDirections: visionDocuments.confirmedDirections,
        userAnswers: visionDocuments.userAnswers,
        openQuestions: visionDocuments.openQuestions,
        version: visionDocuments.version,
      })
      .from(visionDocuments)
      .orderBy(desc(visionDocuments.version))
      .limit(1);
    return row ?? null;
  }

  async getRecentFileChanges(limit: number) {
    return this.db
      .select({
        filePath: fileChanges.filePath,
        changeType: fileChanges.changeType,
        taskId: fileChanges.taskId,
      })
      .from(fileChanges)
      .orderBy(desc(fileChanges.changedAt))
      .limit(limit);
  }

  async getDecisionsByEpic(epicId: string | null) {
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
      .limit(10);
  }

  async getFindingsBySiblingTasks(storyId: string) {
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
      .limit(10);
  }

  async getFailedApproachesByEpic(epicId: string | null) {
    return this.db
      .select({
        title: failedApproaches.title,
        approachDescription: failedApproaches.approachDescription,
        failureReason: failedApproaches.failureReason,
        learned: failedApproaches.learned,
        affectedArea: failedApproaches.affectedArea,
      })
      .from(failedApproaches)
      .where(epicId ? eq(failedApproaches.epicId, epicId) : sql`TRUE`)
      .orderBy(desc(failedApproaches.recordedAt))
      .limit(5);
  }

  async getEpicProgress() {
    return this.db
      .select({
        title: workItems.title,
        northStar: sql<string>`COALESCE(${workItems.northStar}, '')`,
        status: workItems.status,
        totalStories: sql<number>`(SELECT COUNT(*)::int FROM work_items sub WHERE sub.parent_id = "work_items"."id" AND sub.level = 'Story')`,
        completedStories: sql<number>`(SELECT COUNT(*)::int FROM work_items sub WHERE sub.parent_id = "work_items"."id" AND sub.level = 'Story' AND sub.status = 'Completed')`,
      })
      .from(workItems)
      .where(
        and(eq(workItems.level, "Epic"), ne(workItems.status, "Archived")),
      );
  }

  async getStoryProgress(storyId: string) {
    const [row] = await this.db
      .select({
        title: workItems.title,
        northStar: sql<string>`COALESCE(${workItems.northStar}, '')`,
        totalTasks: sql<number>`(SELECT COUNT(*)::int FROM work_items WHERE parent_id = ${storyId} AND level = 'Task')`,
        completedTasks: sql<number>`(SELECT COUNT(*)::int FROM work_items WHERE parent_id = ${storyId} AND level = 'Task' AND status = 'Completed')`,
        inProgressTasks: sql<number>`(SELECT COUNT(*)::int FROM work_items WHERE parent_id = ${storyId} AND level = 'Task' AND status = 'InProgress')`,
      })
      .from(workItems)
      .where(eq(workItems.id, storyId))
      .limit(1);
    return row ?? null;
  }

  async getSiblingTasks(parentId: string, currentId: string) {
    return this.db
      .select({
        id: workItems.id,
        title: workItems.title,
        status: workItems.status,
      })
      .from(workItems)
      .where(
        and(eq(workItems.parentId, parentId), ne(workItems.id, currentId)),
      )
      .orderBy(asc(workItems.createdAt))
      .limit(10);
  }

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
          // Exhausted-abandon items (Abandoned, no substitute recorded) never
          // delivered their work and must stay re-proposable, not suppressed as
          // "already exists" (Run-9 redteam D2). Substitute-abandon items
          // (blockedReason.substitutedBy set) keep suppressing — the twin already
          // covers the work.
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
