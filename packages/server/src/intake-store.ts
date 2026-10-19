import { ClientMessageRepository, VisionRepository, recordTenderIntake } from "@ashara/engagement";
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
        contractDraft: write.contractDraft,
        readingReport: write.readingReport,
        reading: write.reading,
        vision: write.vision,
      });
      return commit.kind === "recorded"
        ? { kind: "recorded", questionIds: commit.questionIds }
        : commit;
    },
    async consumeTender(tenderId) {
      await messages.markConsumed(tenderId);
    },
    recordFailedAttempt: (tenderId, error) => messages.recordIntakeFailure(tenderId, error),
    blockUnreadTender: (tender, cause) =>
      db.transaction(async (tx) => {
        const blocked = await new ProjectHaltRepository(tx).block(tender.projectId, cause);
        await new ClientMessageRepository(tx).resetIntakeAttempts(tender.id);
        return blocked;
      }),
    blockProject: (projectId, cause) => projects.block(projectId, cause),
  };
}
