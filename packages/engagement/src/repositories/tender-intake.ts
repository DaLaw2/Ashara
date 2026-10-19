import { intakeReadings } from "@ashara/db";
import type { Database, DbHandle } from "@ashara/db";
import type { ProjectId } from "@ashara/shared";
import type { IntakeReading } from "../intake.js";
import type { FirstVision } from "../vision.js";
import { ClientMessageRepository } from "./client-message.js";
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
  /** The report of the assumptions no question carries, posted after the questions; null when there is none. */
  readonly assumptionsReport: string | null;
  /** The report of how a reading that asked nothing was confirmed, posted after the assumptions report; null when there is none. */
  readonly readingReport: string | null;
  /** The tender's reading, recorded in intake_readings. */
  readonly reading: IntakeReading;
  /** The vision v1 document, given the ids of the posted questions in the same order. */
  readonly vision: (questionIds: readonly string[]) => FirstVision;
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
  | { readonly kind: "vision-exists"; readonly visionVersion: number };

/**
 * One tender's intake, in one transaction: the tender consumed, its questions, its assumptions report
 * and its reading report posted, its reading recorded, vision v1 written. The tender is consumed first so its row lock
 * serialises two intakes of it; a project that already has a vision gets only
 * the consumption and nothing new.
 */
export async function recordTenderIntake(db: Database, write: TenderIntakeWrite): Promise<TenderIntakeCommit> {
  return db.transaction(async (tx) => {
    const messages = new ClientMessageRepository(tx);
    const visions = new VisionRepository(tx);
    await messages.markConsumed(write.tenderId);

    const existing = await visions.getCurrent(write.projectId);
    if (existing) return { kind: "vision-exists", visionVersion: existing.version };

    const questions = await messages.insertQuestions(write.projectId, write.tenderId, write.questions);
    const questionIds = questions.map((q) => q.id);
    // Once per project with no reports_on subject of its own: it commits only with vision v1, which
    // UNIQUE (project_id, version) lets exactly one intake write.
    if (write.assumptionsReport !== null) {
      await messages.insertOutbound({ projectId: write.projectId, kind: "report", body: write.assumptionsReport, inReplyTo: write.tenderId });
    }
    if (write.readingReport !== null) {
      await messages.insertOutbound({ projectId: write.projectId, kind: "report", body: write.readingReport, inReplyTo: write.tenderId });
    }
    await insertIntakeReading(tx, write);
    const vision = await visions.create(write.projectId, write.vision(questionIds));
    if (vision.version !== 1) throw new IntakeVisionNotFirst(write.projectId, write.tenderId, vision.version);
    return { kind: "recorded", visionId: vision.id, questionIds };
  });
}

/** A tender whose intake was given up on: the report to the client posted and the tender consumed, together. */
export async function closeTenderAfterFailedIntake(
  db: Database,
  tender: { readonly tenderId: string; readonly projectId: ProjectId },
  report: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const messages = new ClientMessageRepository(tx);
    await messages.markConsumed(tender.tenderId);
    await messages.insertOutbound({
      projectId: tender.projectId,
      kind: "report",
      body: report,
      inReplyTo: tender.tenderId,
    });
  });
}
