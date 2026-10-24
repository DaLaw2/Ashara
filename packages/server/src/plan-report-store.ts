import type { Database, DbTransaction } from "@ashara/db";
import { ProjectHaltRepository, listDuePlanReports, listDuePlanRevisionReports, planRevisionToTell } from "@ashara/delivery";
import { postPlanReport, postPlanRevisionReport, readRiskRecords } from "@ashara/engagement";
import type { PlanReportStore } from "@ashara/engagement";

/**
 * Engagement's planning-report store: the first plans and plan revisions Delivery publishes, and
 * Engagement's write of each report with its told record. A report that cannot be composed halts its
 * project through Delivery's halt.
 */
export function createPlanReportStore(db: Database | DbTransaction): PlanReportStore {
  const projects = new ProjectHaltRepository(db);
  return {
    dueReports: () => listDuePlanReports(db),
    postReport: (projectId, subject, body, revisionIds) => postPlanReport(db, projectId, subject, body, revisionIds),
    dueRevisionReports: () => listDuePlanRevisionReports(db),
    postRevisionReport: async (revisionId, body) => postPlanRevisionReport(db, await planRevisionToTell(db, revisionId), body),
    blockProject: (projectId, cause) => projects.block(projectId, cause),
    riskRecords: (projectId) => readRiskRecords(db, projectId),
  };
}
