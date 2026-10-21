import { and, asc, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { devSessions } from "@ashara/db";
import type { DbHandle } from "@ashara/db";
import { attemptGrade } from "@ashara/finance";

// Workplace's published reads of its attempt log (dev_sessions) for the contexts that judge or plan
// by the models a task's attempts ran on, each graded in Finance's catalog grade (attemptGrade). The
// grade is as the query returns it; the reader parses it in Finance's capability vocabulary.

/** An attempt's recorded model and provider, with its catalog grade as read: null when the catalog holds no such model under that provider. */
export interface GradedAttempt {
  readonly taskId: string;
  readonly model: string | null;
  readonly provider: string | null;
  readonly grade: unknown;
}

/** The last completed attempt that names its model, of each task `taskIds` names that has one. */
export async function lastCompletedAttempts(db: DbHandle, taskIds: readonly string[]): Promise<GradedAttempt[]> {
  if (taskIds.length === 0) return [];
  return db
    .selectDistinctOn([devSessions.taskId], {
      taskId: devSessions.taskId,
      model: devSessions.attemptModel,
      provider: devSessions.attemptProvider,
      grade: attemptGrade(devSessions.attemptModel, devSessions.attemptProvider),
    })
    .from(devSessions)
    .where(and(inArray(devSessions.taskId, [...taskIds]), eq(devSessions.phase, "Completed"), isNotNull(devSessions.attemptModel)))
    .orderBy(asc(devSessions.taskId), desc(devSessions.updatedAt), desc(devSessions.id));
}

/** Every attempt that names its model, of each task `taskIds` names, oldest first. */
export async function attemptsWithModel(db: DbHandle, taskIds: readonly string[]): Promise<GradedAttempt[]> {
  if (taskIds.length === 0) return [];
  return db
    .select({
      taskId: devSessions.taskId,
      model: devSessions.attemptModel,
      provider: devSessions.attemptProvider,
      grade: attemptGrade(devSessions.attemptModel, devSessions.attemptProvider),
    })
    .from(devSessions)
    .where(and(inArray(devSessions.taskId, [...taskIds]), isNotNull(devSessions.attemptModel)))
    .orderBy(asc(devSessions.createdAt), asc(devSessions.id));
}
