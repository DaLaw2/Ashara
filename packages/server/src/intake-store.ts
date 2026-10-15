import { ClientMessageRepository, VisionRepository, closeTenderAfterFailedIntake, recordTenderIntake } from "@ashara/engagement";
import type { createDb } from "@ashara/db";
import { ProjectHaltRepository } from "@ashara/delivery";
import type { IntakeStore } from "@ashara/engagement";
import { parseProjectId } from "@ashara/shared";

/** Engagement's intake store over client_messages and vision_documents. */
export function createIntakeStore(db: ReturnType<typeof createDb>): IntakeStore {
  const messages = new ClientMessageRepository(db);
  const visions = new VisionRepository(db);
  const projects = new ProjectHaltRepository(db);
  return {
    async openTenders() {
      const rows = await messages.listUnconsumedTenders();
      return rows.map((row) => ({
        id: row.id,
        projectId: parseProjectId(row.projectId, "client_messages.project_id"),
        body: row.body,
        intakeAttempts: row.intakeAttempts,
        intakeLastError: row.intakeLastError,
      }));
    },
    async currentVisionVersion(projectId) {
      const vision = await visions.getCurrent(projectId);
      return vision ? vision.version : null;
    },
    async recordIntake(write) {
      const commit = await recordTenderIntake(db, {
        tenderId: write.tender.id,
        projectId: write.tender.projectId,
        questions: write.questions,
        assumptionsReport: write.assumptionsReport,
        vision: (questionIds) => {
          const vision = write.vision(questionIds);
          return {
            visionText: vision.visionText,
            summary: vision.summary,
            scopeBoundaries: vision.scopeBoundaries,
            inferences: vision.inferences,
            openQuestions: vision.openQuestions,
          };
        },
      });
      return commit.kind === "recorded"
        ? { kind: "recorded", questionIds: commit.questionIds }
        : commit;
    },
    async consumeTender(tenderId) {
      await messages.markConsumed(tenderId);
    },
    recordFailedAttempt: (tenderId, error) => messages.recordIntakeFailure(tenderId, error),
    closeFailedTender: (tender, report) =>
      closeTenderAfterFailedIntake(db, { tenderId: tender.id, projectId: tender.projectId }, report),
    blockProject: (projectId, cause) => projects.block(projectId, cause),
  };
}
