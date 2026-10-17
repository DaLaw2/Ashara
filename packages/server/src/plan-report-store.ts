import type { DbTransaction, createDb } from "@ashara/db";
import {
  ProjectHaltRepository,
  listDuePlanReports,
  listDuePlanRevisionReports,
  postPlanReport,
  postPlanRevisionReport,
} from "@ashara/delivery";
import type { PlanReportStore } from "@ashara/engagement";

/**
 * Engagement's planning-report store over projects, work_items, plan_revisions and client_messages.
 * A report that cannot be composed halts its project through Delivery's halt.
 */
export function createPlanReportStore(db: ReturnType<typeof createDb> | DbTransaction): PlanReportStore {
  const projects = new ProjectHaltRepository(db);
  return {
    dueReports: () => listDuePlanReports(db),
    postReport: (projectId, subject, body, revisionIds) => postPlanReport(db, projectId, subject, body, revisionIds),
    dueRevisionReports: () => listDuePlanRevisionReports(db),
    postRevisionReport: (revisionId, body) => postPlanRevisionReport(db, revisionId, body),
    blockProject: (projectId, cause) => projects.block(projectId, cause),
  };
}
