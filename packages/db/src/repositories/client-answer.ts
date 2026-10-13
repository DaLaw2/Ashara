import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { parseProjectId, type ProjectId } from "@ashara/shared";
import type { Database, DbHandle } from "../connection.js";
import { clientMessages, projects, visionDocuments } from "../schema.js";
import { noOpenStop } from "./project.js";

// The client's answers to the Liaison's questions (migration 038): each inbound
// 'answer' is consumed once, together with what it changes.

const questions = alias(clientMessages, "question");

/** The project's current vision, as stored; Engagement parses its jsonb. */
interface StoredVision {
  readonly version: number;
  readonly inferences: unknown;
  readonly openQuestions: unknown;
}

interface OpenAnswerRow {
  readonly id: string;
  readonly projectId: ProjectId;
  readonly body: string;
  readonly questionId: string;
  readonly intakeAttempts: number;
  readonly intakeLastError: string | null;
  /** Whether the project's first plan was written when this answer was read. */
  readonly planned: boolean;
  /** The project's current vision, or null when it has none. */
  readonly vision: StoredVision | null;
}

/**
 * Unconsumed inbound answers of active projects, oldest first, each with its
 * project's current vision. A project with a stop awaiting the Liaison is not
 * listed, as for tenders.
 */
export async function listOpenAnswers(db: DbHandle): Promise<OpenAnswerRow[]> {
  const rows = await db
    .select({
      id: clientMessages.id,
      projectId: clientMessages.projectId,
      body: clientMessages.body,
      questionId: questions.id,
      intakeAttempts: clientMessages.intakeAttempts,
      intakeLastError: clientMessages.intakeLastError,
      firstPlannedAt: projects.firstPlannedAt,
    })
    .from(clientMessages)
    .innerJoin(questions, eq(questions.id, clientMessages.inReplyTo))
    .innerJoin(projects, eq(projects.id, clientMessages.projectId))
    .where(
      and(
        eq(clientMessages.direction, "inbound"),
        eq(clientMessages.kind, "answer"),
        isNull(clientMessages.consumedAt),
        eq(projects.status, "active"),
        noOpenStop(clientMessages.projectId),
      ),
    )
    .orderBy(asc(clientMessages.createdAt), asc(clientMessages.id));

  const open: OpenAnswerRow[] = [];
  for (const row of rows) {
    const [vision] = await db
      .select({
        version: visionDocuments.version,
        inferences: visionDocuments.inferences,
        openQuestions: visionDocuments.openQuestions,
      })
      .from(visionDocuments)
      .where(eq(visionDocuments.projectId, row.projectId))
      .orderBy(desc(visionDocuments.version))
      .limit(1);
    open.push({
      id: row.id,
      projectId: parseProjectId(row.projectId),
      body: row.body,
      questionId: row.questionId,
      intakeAttempts: row.intakeAttempts,
      intakeLastError: row.intakeLastError,
      planned: row.firstPlannedAt !== null,
      vision: vision ?? null,
    });
  }
  return open;
}

/** An unconsumed inbound answer with this id was needed, and none was found. */
class AnswerNotOpen extends Error {
  constructor(
    readonly answerId: string,
    readonly operation: string,
  ) {
    super(`cannot ${operation}: client message ${answerId} is not an unconsumed inbound answer`);
    this.name = "AnswerNotOpen";
  }
}

/** Counts one failed attempt to read an unconsumed answer with its error; returns the count after it. */
export async function recordAnswerFailure(db: DbHandle, answerId: string, error: string): Promise<number> {
  const [row] = await db
    .update(clientMessages)
    .set({ intakeAttempts: sql`${clientMessages.intakeAttempts} + 1`, intakeLastError: error })
    .where(
      and(
        eq(clientMessages.id, answerId),
        eq(clientMessages.direction, "inbound"),
        eq(clientMessages.kind, "answer"),
        isNull(clientMessages.consumedAt),
      ),
    )
    .returning({ intakeAttempts: clientMessages.intakeAttempts });
  if (!row) throw new AnswerNotOpen(answerId, "record a failed attempt to read it");
  return row.intakeAttempts;
}

/** What was composed against no longer holds when the write's transaction reads it: nothing was written. */
class AnswerContextMoved extends Error {
  constructor(
    readonly answerId: string,
    readonly projectId: ProjectId,
    readonly detail: string,
  ) {
    super(`answer ${answerId} of project ${projectId} was composed against a state that moved: ${detail}; nothing was written`);
    this.name = "AnswerContextMoved";
  }
}

interface AnswerWrite {
  readonly answerId: string;
  readonly projectId: ProjectId;
  /** Whether the project's first plan existed when the answer was composed. */
  readonly planned: boolean;
  /** The vision version to append after `basedOnVersion`; every other field is copied from it. */
  readonly vision: {
    readonly basedOnVersion: number;
    readonly inferences: unknown;
    readonly openQuestions: unknown;
    readonly changeReason: string;
  } | null;
  /** A planned project's replanning request: the flag set and the report posted, in reply to the answer. */
  readonly replanReport: string | null;
}

/**
 * In one transaction, with the project row locked (the first-plan transaction
 * locks it too): the answer consumed, the vision version appended, and for a
 * replanning request the project flagged and the report posted. An answer
 * already consumed gets nothing new ("already-consumed").
 */
export async function recordClientAnswer(db: Database, write: AnswerWrite): Promise<"recorded" | "already-consumed"> {
  return db.transaction(async (tx) => {
    const [project] = await tx
      .select({ firstPlannedAt: projects.firstPlannedAt })
      .from(projects)
      .where(eq(projects.id, write.projectId))
      .for("update");
    if (!project) throw new AnswerContextMoved(write.answerId, write.projectId, "the project does not exist");
    if ((project.firstPlannedAt !== null) !== write.planned) {
      throw new AnswerContextMoved(
        write.answerId,
        write.projectId,
        `composed as ${write.planned ? "planned" : "not planned"}, but the project is ${write.planned ? "not planned" : "planned"}`,
      );
    }

    const consumed = await tx
      .update(clientMessages)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(clientMessages.id, write.answerId),
          eq(clientMessages.projectId, write.projectId),
          eq(clientMessages.direction, "inbound"),
          eq(clientMessages.kind, "answer"),
          isNull(clientMessages.consumedAt),
        ),
      )
      .returning({ id: clientMessages.id });
    if (consumed.length === 0) return "already-consumed";

    if (write.vision !== null) {
      const [current] = await tx
        .select()
        .from(visionDocuments)
        .where(eq(visionDocuments.projectId, write.projectId))
        .orderBy(desc(visionDocuments.version))
        .limit(1);
      if (current === undefined || current.version !== write.vision.basedOnVersion) {
        throw new AnswerContextMoved(
          write.answerId,
          write.projectId,
          `composed against vision v${write.vision.basedOnVersion}, current is ${current === undefined ? "none" : `v${current.version}`}`,
        );
      }
      await tx.insert(visionDocuments).values({
        projectId: write.projectId,
        version: current.version + 1,
        visionText: current.visionText,
        summary: current.summary,
        inferences: write.vision.inferences,
        scopeBoundaries: current.scopeBoundaries,
        confirmedDirections: current.confirmedDirections,
        openQuestions: write.vision.openQuestions,
        changeReason: write.vision.changeReason,
      });
    }

    if (write.replanReport !== null) {
      // The first contradicting answer stays on record; a later one adds its report only.
      await tx
        .update(projects)
        .set({ replanRequestedBy: sql`COALESCE(${projects.replanRequestedBy}, ${write.answerId}::uuid)` })
        .where(eq(projects.id, write.projectId));
      await tx.insert(clientMessages).values({
        projectId: write.projectId,
        direction: "outbound",
        kind: "report",
        body: write.replanReport,
        inReplyTo: write.answerId,
      });
    }
    return "recorded";
  });
}
