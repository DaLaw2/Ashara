import { eq } from "drizzle-orm";
import { projects } from "@ashara/db";
import type { Database, DbHandle } from "@ashara/db";
import { firstPlanned } from "@ashara/delivery/predicates";
import { parseProjectId, readEach, type ProjectId, type UnreadSubject } from "@ashara/shared";
import { MAX_ANSWER_ATTEMPTS } from "../answers.js";
import type { RevisionRecord } from "../vision-language/contract-op.js";
import type { StoredVision, VisionAppend } from "../vision.js";
import type { HoldCorrection } from "../ports.js";
import { affectedKeysOf } from "./client-change.js";
import { LockedStanding, consumeInbound, insertOutboundReport, openAnswerMessages, recordReadingFailure } from "./client-message.js";
import { VisionRepository } from "./vision.js";

// The client's answers to the Liaison's questions: each inbound
// 'answer' is consumed once, together with what it changes.

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
  /** Whether Delivery had the project halted when this answer was read. */
  readonly paused: boolean;
}

/**
 * Unconsumed inbound answers of active projects, those at work first, each oldest first, with its
 * project's current vision and whether it is halted. A halted project's answer is
 * read all the same (a halt pauses the work, not the reading), except under a
 * halt the reading cannot get past, and an answer at its cap of failed readings
 * waits out any halt, each as inboundDecision decides (clientMessageReadNow). A project with a stop awaiting the Liaison is not listed, as for tenders.
 * Each answer is read on its own (readEach): one whose rows do not read is its UnreadSubject.
 */
export async function listOpenAnswers(db: DbHandle): Promise<Array<OpenAnswerRow | UnreadSubject>> {
  const visions = new VisionRepository(db);
  return readEach(
    await openAnswerMessages(db, MAX_ANSWER_ATTEMPTS, null),
    (row) => ({ id: row.id, projectId: parseProjectId(row.projectId, "client_messages.project_id") }),
    (row) => openAnswerRow(visions, row),
  );
}

/**
 * One answer as listOpenAnswers lists it, read now with its project's current vision: what the
 * Liaison reads it against, so an answer read after another answer of its project wrote a vision
 * version sees that version. null when it is no longer listed (consumed, or its project stopped).
 */
export async function readOpenAnswer(db: DbHandle, answerId: string): Promise<OpenAnswerRow | null> {
  const [row] = await openAnswerMessages(db, MAX_ANSWER_ATTEMPTS, answerId);
  return row === undefined ? null : openAnswerRow(new VisionRepository(db), row);
}

type OpenAnswerMessage = Awaited<ReturnType<typeof openAnswerMessages>>[number];

/** One open answer's message, read with its project's current vision. */
async function openAnswerRow(visions: VisionRepository, row: OpenAnswerMessage): Promise<OpenAnswerRow> {
  const projectId = parseProjectId(row.projectId, "client_messages.project_id");
  return {
    id: row.id,
    projectId,
    body: row.body,
    questionId: row.questionId,
    intakeAttempts: row.intakeAttempts,
    intakeLastError: row.intakeLastError,
    intakeLastFailure: row.intakeLastFailure,
    planned: row.planned,
    vision: await visions.getCurrent(projectId),
    paused: row.halted,
  };
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
  const attempts = await recordReadingFailure(db, "answer", answerId, error, failure);
  if (attempts === null) throw new AnswerNotOpen(answerId, "record a failed attempt to read it");
  return attempts;
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
  /**
   * What the client is told of an answer that records nothing, posted to the project: not in reply to
   * the answer, whose replies each name the vision version recording it.
   */
  readonly notice: string | null;
  /** Whether the project was halted when the answer was composed. */
  readonly paused: boolean;
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
 * first, the first plan was written meanwhile, or the project no longer reads the
 * client's input or was halted or resumed, which the report states) is rolled back
 * whole and returned as "moved", for the Liaison to compose again against the current state.
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
    const standing = await LockedStanding.readNow(tx, write.projectId, "answer", write.paused);
    if (!(standing instanceof LockedStanding)) throw new AnswerContextMoved(write.answerId, write.projectId, standing.detail);
    // Read in its own statement after the lock, so a first plan committed while the lock waited is seen.
    const [project] = await tx
      .select({ planned: firstPlanned(projects.id).mapWith(Boolean) })
      .from(projects)
      .where(eq(projects.id, write.projectId));
    if (!project) throw new AnswerContextMoved(write.answerId, write.projectId, "the project does not exist");
    if (project.planned !== write.planned) {
      throw new AnswerContextMoved(
        write.answerId,
        write.projectId,
        `composed as ${write.planned ? "planned" : "not planned"}, but the project is ${write.planned ? "not planned" : "planned"}`,
      );
    }

    if ((await consumeInbound(standing, write.answerId)) === "not-open") return "already-consumed";

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
      await insertOutboundReport(tx, write.projectId, write.replanReport, write.answerId, `post the report on answer ${write.answerId}`);
    }
    if (write.notice !== null) await insertOutboundReport(tx, write.projectId, write.notice, null, `post the notice on answer ${write.answerId}`);
    return "recorded";
  });
}
