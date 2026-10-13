import type { ProjectId } from "@ashara/shared";
import type { Database } from "../connection.js";
import { ClientMessageRepository } from "./client-message.js";
import { VisionRepository, type VisionInput } from "./vision.js";

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
  /** The vision v1 document, given the ids of the posted questions in the same order. */
  readonly vision: (questionIds: readonly string[]) => VisionInput;
}

type TenderIntakeCommit =
  | { readonly kind: "recorded"; readonly visionId: string; readonly questionIds: readonly string[] }
  | { readonly kind: "vision-exists"; readonly visionVersion: number };

/**
 * One tender's intake, in one transaction: the tender consumed, its questions
 * posted, vision v1 written. The tender is consumed first so its row lock
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
