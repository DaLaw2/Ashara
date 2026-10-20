import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { clientMessages, noOpenStop, projectAtWork, projects } from "@ashara/db";
import type { Database, DbHandle } from "@ashara/db";
import { parseProjectId, type ProjectId } from "@ashara/shared";
import type { RevisionRecord } from "../vision-language/contract-op.js";
import type { StoredVision, VisionAppend } from "../vision.js";
import { affectedKeysOf } from "./client-change.js";
import type { HoldCorrection } from "./client-change.js";
import { VisionRepository } from "./vision.js";

// The client's answers to the Liaison's questions: each inbound
// 'answer' is consumed once, together with what it changes.

const questions = alias(clientMessages, "question");

interface OpenAnswerRow {
  readonly id: string;
  readonly projectId: ProjectId;
  readonly body: string;
  readonly questionId: string;
  readonly intakeAttempts: number;
  readonly intakeLastError: string | null;
  /** Whose failure the last counted reading attempt was, as stored. */
  readonly intakeLastFailure: string | null;
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
  return openAnswerRows(db, null);
}

/**
 * One answer as listOpenAnswers lists it, read now with its project's current vision: what the
 * Liaison reads it against, so an answer read after another answer of its project wrote a vision
 * version sees that version. null when it is no longer listed (consumed, or its project stopped).
 */
export async function readOpenAnswer(db: DbHandle, answerId: string): Promise<OpenAnswerRow | null> {
  const [row] = await openAnswerRows(db, answerId);
  return row ?? null;
}

async function openAnswerRows(db: DbHandle, answerId: string | null): Promise<OpenAnswerRow[]> {
  const rows = await db
    .select({
      id: clientMessages.id,
      projectId: clientMessages.projectId,
      body: clientMessages.body,
      questionId: questions.id,
      intakeAttempts: clientMessages.intakeAttempts,
      intakeLastError: clientMessages.intakeLastError,
      intakeLastFailure: clientMessages.intakeLastFailure,
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
        projectAtWork(),
        noOpenStop(clientMessages.projectId),
        answerId === null ? undefined : eq(clientMessages.id, answerId),
      ),
    )
    .orderBy(asc(clientMessages.createdAt), asc(clientMessages.id));

  const visions = new VisionRepository(db);
  const open: OpenAnswerRow[] = [];
  for (const row of rows) {
    const projectId = parseProjectId(row.projectId, "client_messages.project_id");
    open.push({
      id: row.id,
      projectId,
      body: row.body,
      questionId: row.questionId,
      intakeAttempts: row.intakeAttempts,
      intakeLastError: row.intakeLastError,
      intakeLastFailure: row.intakeLastFailure,
      planned: row.firstPlannedAt !== null,
      vision: await visions.getCurrent(projectId),
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

/** Counts one failed attempt to read an unconsumed answer with its error and whose failure it was; returns the count after it. */
export async function recordAnswerFailure(db: DbHandle, answerId: string, error: string, failure: "model" | "provider"): Promise<number> {
  const [row] = await db
    .update(clientMessages)
    .set({ intakeAttempts: sql`${clientMessages.intakeAttempts} + 1`, intakeLastError: error, intakeLastFailure: failure })
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
  /** The vision version to append after `basedOnVersion` (every other field is copied from it), with its revision record. */
  readonly vision: { readonly append: VisionAppend; readonly revision: RevisionRecord } | null;
  /**
   * A planned project's correction: Delivery's hold on the work citing the assumption it changed,
   * and the report posted in reply to the answer.
   */
  readonly replanReport: string | null;
}

/** A write asks to hold the work an answer changed, but appends no vision version for the hold to name. */
class AnswerCorrectionUnversioned extends Error {
  constructor(
    readonly answerId: string,
    readonly projectId: ProjectId,
  ) {
    super(`answer ${answerId} of project ${projectId} was composed as a correction of the plan with no vision version to hold the work by; nothing was written`);
    this.name = "AnswerCorrectionUnversioned";
  }
}

/**
 * In one transaction, with the project row locked (the first-plan transaction
 * locks it too): the answer consumed, the vision version appended, and for a
 * correction of a planned project Delivery's hold on the work citing the
 * assumption it changed (`hold`) and the report posted. An answer
 * already consumed gets nothing new ("already-consumed"). One composed against a
 * state that no longer holds (another answer of the project wrote a vision version
 * first, or the first plan was written meanwhile) is rolled back whole and returned
 * as "moved", for the Liaison to compose again against the current state.
 */
export async function recordClientAnswer(db: Database, write: AnswerWrite, hold: HoldCorrection): Promise<AnswerRecording> {
  try {
    return { kind: await writeClientAnswer(db, write, hold) };
  } catch (err) {
    if (err instanceof AnswerContextMoved) return { kind: "moved", detail: err.message };
    throw err;
  }
}

/** What recording an answer did; "moved" wrote nothing, and `detail` says what moved. */
type AnswerRecording =
  | { readonly kind: "recorded" }
  | { readonly kind: "already-consumed" }
  | { readonly kind: "moved"; readonly detail: string };

function writeClientAnswer(db: Database, write: AnswerWrite, hold: HoldCorrection): Promise<"recorded" | "already-consumed"> {
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

    let applied: { readonly version: number; readonly revision: RevisionRecord } | null = null;
    if (write.vision !== null) {
      const appended = await new VisionRepository(tx).append(write.projectId, write.vision.append, write.vision.revision);
      if (appended.kind === "moved") {
        throw new AnswerContextMoved(
          write.answerId,
          write.projectId,
          `composed against vision v${write.vision.append.basedOnVersion}, current is ${appended.current === null ? "none" : `v${appended.current}`}`,
        );
      }
      applied = { version: appended.version, revision: write.vision.revision };
    }

    if (write.replanReport !== null) {
      if (applied === null) throw new AnswerCorrectionUnversioned(write.answerId, write.projectId);
      // Every changing answer is on record: the hold names it, the revision that takes it in records
      // itself on the hold, and its report says what it changed.
      await hold(tx, { projectId: write.projectId, visionVersion: applied.version, requestedBy: write.answerId, affected: await affectedKeysOf(tx, write.projectId, applied.version, applied.revision.ops) });
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
