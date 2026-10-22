import { intakeReadings } from "@ashara/db/schema/engagement";
import type { Database, DbHandle } from "@ashara/db";
import type { ProjectId } from "@ashara/shared";
import type { IntakeReading } from "../intake.js";
import { REPORT_SUBJECT } from "../report-subjects.js";
import type { FirstVision } from "../vision.js";
import { ClientMessageNotConsumable, ClientMessageRepository, LockedStanding, consumeInbound, postOnSubject, type StandingMoved } from "./client-message.js";
import { VisionRepository } from "./vision.js";

/** The first vision version a tender's intake writes did not come out as version 1. */
class IntakeVisionNotFirst extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly tenderId: string,
    readonly version: number,
  ) {
    super(
      `intake of tender ${tenderId} wrote vision version ${version} for project ${projectId}; ` +
        `intake writes only version 1`,
    );
    this.name = "IntakeVisionNotFirst";
  }
}

interface TenderIntakeWrite {
  readonly tenderId: string;
  readonly projectId: ProjectId;
  /** Outbound question bodies, posted with their positions in this order. */
  readonly questions: readonly string[];
  /** The contract draft, posted after the questions as the project's one 'contract-draft' report. */
  readonly contractDraft: string;
  /** The report of how a reading that asked nothing was confirmed, posted after the contract draft; null when there is none. */
  readonly readingReport: string | null;
  /** The tender's reading, recorded in intake_readings. */
  readonly reading: IntakeReading;
  /** The vision v1 document, given the ids of the posted questions in the same order. */
  readonly vision: (questionIds: readonly string[]) => FirstVision;
}

async function consumeTender(standing: LockedStanding, tenderId: string): Promise<void> {
  if ((await consumeInbound(standing, tenderId)) === "not-open") throw new ClientMessageNotConsumable(tenderId);
}

/**
 * A tender of a project that already has a vision, consumed with nothing else written: under the
 * project row's lock and only while inboundDecision still reads it now, as its intake is. A project
 * halted, stopped or delivered since the tender was listed gets nothing ("moved").
 */
export async function consumeTenderWithoutIntake(
  db: Database,
  tender: { readonly id: string; readonly projectId: ProjectId },
): Promise<{ readonly kind: "consumed" } | StandingMoved> {
  return db.transaction(async (tx) => {
    const standing = await LockedStanding.readNow(tx, tender.projectId, "tender", false);
    if (!(standing instanceof LockedStanding)) return { kind: "moved", detail: `tender ${tender.id}: ${standing.detail}; nothing was written` };
    await consumeTender(standing, tender.id);
    return { kind: "consumed" };
  });
}

/** One intake_readings row, written with vision v1; its CHECKs hold it consistent. */
async function insertIntakeReading(db: DbHandle, write: TenderIntakeWrite): Promise<void> {
  const { reading } = write;
  const { confirmation } = reading;
  const second = confirmation.kind === "confirmed" || confirmation.kind === "questions-raised" ? confirmation.second : null;
  await db.insert(intakeReadings).values({
    projectId: write.projectId,
    tenderId: write.tenderId,
    firstProvider: reading.first.provider,
    firstModel: reading.first.model,
    firstQuestions: reading.firstQuestions,
    confirmation: confirmation.kind,
    secondStrength: second === null ? null : second.strength,
    secondProvider: second === null ? null : second.model.provider,
    secondModel: second === null ? null : second.model.model,
    secondQuestions: second === null ? null : second.questions.length,
    judgedTier: reading.first.grade,
    judgeTier: second === null ? null : second.model.grade,
    passedOver: confirmation.kind === "not-needed" ? [] : confirmation.passedOver,
  });
}

type TenderIntakeCommit =
  | { readonly kind: "recorded"; readonly visionId: string; readonly questionIds: readonly string[] }
  | { readonly kind: "vision-exists"; readonly visionVersion: number }
  | { readonly kind: "moved"; readonly detail: string };

/**
 * One tender's intake, in one transaction: the tender consumed, its questions, its contract draft
 * and its reading report posted, its reading recorded, vision v1 written. The project row is locked
 * first and the tender's intake writes only while inboundDecision still reads it now: a project
 * halted, stopped or delivered while the tender was read gets nothing ("moved"), the tender left for
 * the reading the decision gives it then. A tender is read only while its project is at work. The
 * tender is consumed next so its row lock serialises two intakes of it; a project that already has a
 * vision gets only the consumption and nothing new.
 */
export async function recordTenderIntake(db: Database, write: TenderIntakeWrite): Promise<TenderIntakeCommit> {
  return db.transaction(async (tx) => {
    const standing = await LockedStanding.readNow(tx, write.projectId, "tender", false);
    if (!(standing instanceof LockedStanding)) return { kind: "moved", detail: `tender ${write.tenderId}: ${standing.detail}; nothing was written` };
    const messages = new ClientMessageRepository(tx);
    const visions = new VisionRepository(tx);
    await consumeTender(standing, write.tenderId);

    const existing = await visions.getCurrent(write.projectId);
    if (existing) return { kind: "vision-exists", visionVersion: existing.version };

    const questions = await messages.insertQuestions(write.projectId, write.tenderId, write.questions);
    const questionIds = questions.map((q) => q.id);
    // A second contract draft for the project fails the unique index on (project_id, reports_on) and
    // rolls the intake back: vision v1 and its draft are written once, together.
    await postOnSubject(tx, { projectId: write.projectId, body: write.contractDraft, inReplyTo: write.tenderId, reportsOn: REPORT_SUBJECT.contractDraft }, "fail");
    // Once per project with no reports_on subject of its own: it commits only with vision v1, which
    // UNIQUE (project_id, version) lets exactly one intake write.
    if (write.readingReport !== null) {
      await messages.insertOutbound({ projectId: write.projectId, kind: "report", body: write.readingReport, inReplyTo: write.tenderId });
    }
    await insertIntakeReading(tx, write);
    const vision = await visions.create(write.projectId, write.vision(questionIds));
    if (vision.version !== 1) throw new IntakeVisionNotFirst(write.projectId, write.tenderId, vision.version);
    return { kind: "recorded", visionId: vision.id, questionIds };
  });
}
