import type { DbTransaction, createDb } from "@ashara/db";
import { ProjectHaltRepository, listDuePlanReports, listDuePlanRevisionReports, planRevisionToTell } from "@ashara/delivery";
import { postPlanReport, postPlanRevisionReport, readGuaranteeTable, readRiskRecords } from "@ashara/engagement";
import type { PlanReportStore } from "@ashara/engagement";

/**
 * Engagement's planning-report store: the planning outcomes and plan revisions Delivery publishes,
 * and Engagement's write of each report with its told record and guarantee verdicts. A report that
 * cannot be composed halts its project through Delivery's halt.
 */
export function createPlanReportStore(db: ReturnType<typeof createDb> | DbTransaction): PlanReportStore {
  const projects = new ProjectHaltRepository(db);
  return {
    dueReports: () => listDuePlanReports(db),
    postReport: (projectId, subject, body, revisionIds, verdicts) => postPlanReport(db, projectId, subject, body, revisionIds, verdicts),
    guaranteesWithoutSweep: (projectId) => readGuaranteeTable(db, { kind: "no-sweep", projectId }),
    dueRevisionReports: () => listDuePlanRevisionReports(db),
    postRevisionReport: async (revisionId, body) => postPlanRevisionReport(db, await planRevisionToTell(db, revisionId), body),
    blockProject: (projectId, cause) => projects.block(projectId, cause),
    riskRecords: (projectId) => readRiskRecords(db, projectId),
  };
}
