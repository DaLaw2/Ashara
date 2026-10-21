import { listUnconsumedChanges, readChangeImpact, readOpenChange, recordChangeFailure, recordCorrection, resetChangeAttempts } from "@ashara/engagement";
import type { createDb } from "@ashara/db";
import { ProjectHaltRepository, holdCorrection } from "@ashara/delivery";
import type { ClientChangeStore } from "@ashara/engagement";
import type { WorkBudgets } from "@ashara/finance";

/** Engagement's client-change store over client_messages, vision_documents, vision_revisions, work_items and the work ledger, with Delivery's hold on the work an applied correction touches. */
export function createClientChangeStore(db: ReturnType<typeof createDb>, budgets: WorkBudgets): ClientChangeStore {
  const projects = new ProjectHaltRepository(db);
  return {
    openChanges: () => listUnconsumedChanges(db),
    openChange: (changeId) => readOpenChange(db, changeId),
    impact: (projectId, ids) => readChangeImpact(db, projectId, ids, budgets),
    recordCorrection: (write) => recordCorrection(db, write, holdCorrection),
    recordFailedAttempt: (changeId, error, failure) => recordChangeFailure(db, changeId, error, failure),
    blockProject: (projectId, cause) => projects.block(projectId, cause),
    blockUnreadChange: (change, cause) =>
      db.transaction(async (tx) => {
        const blocked = await new ProjectHaltRepository(tx).block(change.projectId, cause);
        if (blocked === "blocked") await resetChangeAttempts(tx, change.id);
        return blocked;
      }),
  };
}
