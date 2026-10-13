import {
  listDuePlanReports,
  listProjectsAwaitingFirstPlan,
  postPlanReport,
  recordFirstPlanFailure,
  stopFirstPlanning,
  withFirstPlanTransaction,
} from "@ashara/db";
import type { createDb } from "@ashara/db";
import type { PlanReportStore } from "@ashara/engagement";
import { createBulkPlanWithContract } from "@ashara/planning";
import type { FirstPlanStore } from "@ashara/planning";
import { RUN_SCOPE_AD_HOC } from "@ashara/shared";
import { adaptWorkItemRepo } from "./work-item-adapter.js";

/** Delivery's first-plan store over projects, vision_documents and work_items. */
export function createFirstPlanStore(db: ReturnType<typeof createDb>): FirstPlanStore {
  return {
    async projectsAwaitingPlan() {
      const rows = await listProjectsAwaitingFirstPlan(db);
      return rows.map((row) => ({
        projectId: row.projectId,
        projectName: row.projectName,
        visionVersion: row.vision.version,
        visionText: row.vision.visionText,
        summary: row.vision.summary,
        scopeBoundaries: row.vision.scopeBoundaries,
        inferences: row.vision.inferences,
        userAnswers: row.vision.userAnswers,
        planAttempts: row.planAttempts,
        planLastError: row.planLastError,
      }));
    },
    async writeFirstPlan(write) {
      // The bulk-plan path runs inside the locked first-plan transaction, so the
      // items, their edges, the contract and the planned stamp commit together.
      const result = await withFirstPlanTransaction(db, write.projectId, ({ workItemRepo, contractRepo }) =>
        createBulkPlanWithContract(
          {
            withPlanningTransaction: (fn) => fn({ workItemRepo: adaptWorkItemRepo(workItemRepo), contractRepo }),
            // The loop's run id is not handed to planning, so the first plan is written
            // under RUN_SCOPE_AD_HOC. This is the only work-item writer, and nothing
            // reads run_scope beyond parsing it.
            runScope: RUN_SCOPE_AD_HOC,
            projectId: write.projectId,
          },
          write.items,
          write.edges,
          write.knowledge,
        ),
      );
      return result.kind === "written" ? { kind: "written", created: result.value.created } : result;
    },
    recordFailedAttempt: (projectId, error) => recordFirstPlanFailure(db, projectId, error),
    stopPlanning: (projectId) => stopFirstPlanning(db, projectId),
  };
}

/** Engagement's planning-report store over projects, work_items and client_messages. */
export function createPlanReportStore(db: ReturnType<typeof createDb>): PlanReportStore {
  return {
    dueReports: () => listDuePlanReports(db),
    postReport: (projectId, subject, body) => postPlanReport(db, projectId, subject, body),
  };
}
