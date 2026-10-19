import { listUnconsumedChanges, readChangeImpact, readOpenChange, recordChangeFailure, recordCorrection } from "@ashara/engagement";
import type { createDb } from "@ashara/db";
import { ProjectHaltRepository } from "@ashara/delivery";
import type { ClientChangeStore } from "@ashara/engagement";
import type { WorkBudgets } from "@ashara/finance";

/** Engagement's client-change store over client_messages, vision_documents, vision_revisions, work_items and the work ledger. */
export function createClientChangeStore(db: ReturnType<typeof createDb>, budgets: WorkBudgets): ClientChangeStore {
  const projects = new ProjectHaltRepository(db);
  return {
    openChanges: () => listUnconsumedChanges(db),
    openChange: (changeId) => readOpenChange(db, changeId),
    impact: (projectId, ids) => readChangeImpact(db, projectId, ids, budgets),
    recordCorrection: (write) => recordCorrection(db, write),
    recordFailedAttempt: (changeId, error, failure) => recordChangeFailure(db, changeId, error, failure),
    blockProject: (projectId, cause) => projects.block(projectId, cause),
  };
}
