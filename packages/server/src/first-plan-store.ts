import {
  ProjectRepository,
  latestRosterRoles,
  listDuePlanReports,
  listDuePlanRevisionReports,
  listProjectsAwaitingFirstPlan,
  postPlanReport,
  postPlanRevisionReport,
  recordFirstPlanFailure,
  stopFirstPlanning,
  withFirstPlanTransaction,
} from "@ashara/db";
import type { DbTransaction, createDb } from "@ashara/db";
import type { PlanReportStore } from "@ashara/engagement";
import { createBulkPlan } from "@ashara/planning";
import type { FirstPlanStore } from "@ashara/planning";
import { RUN_SCOPE_AD_HOC, type ProjectId } from "@ashara/shared";
import { adaptWorkItemRepo } from "./work-item-adapter.js";

/** An owner was named for a temp id the plan did not write. */
class OwnedTaskNotPlanned extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly tempId: string,
  ) {
    super(`first plan of project ${projectId}: an owner names "${tempId}", which is not an item of the plan`);
    this.name = "OwnedTaskNotPlanned";
  }
}

/** Delivery's first-plan store over projects, vision_documents, roster_roles and work_items. */
export function createFirstPlanStore(db: ReturnType<typeof createDb>): FirstPlanStore {
  const projects = new ProjectRepository(db);
  return {
    async projectsAwaitingPlan() {
      const rows = await listProjectsAwaitingFirstPlan(db);
      return Promise.all(rows.map(async (row) => ({
        projectId: row.projectId,
        projectName: row.projectName,
        visionVersion: row.vision.version,
        visionText: row.vision.visionText,
        summary: row.vision.summary,
        scopeBoundaries: row.vision.scopeBoundaries,
        inferences: row.vision.inferences,
        planAttempts: row.planAttempts,
        planLastError: row.planLastError,
        rosterRows: await latestRosterRoles(db, row.projectId),
      })));
    },
    async writeFirstPlan(write) {
      // The bulk-plan path runs inside the locked first-plan transaction, so the
      // items, their edges, their owners and the planned stamp with the dropped
      // ordering hints commit together.
      const result = await withFirstPlanTransaction(
        db,
        write.projectId,
        write.droppedDependencies,
        async (workItemRepo) => {
          const plan = await createBulkPlan(
            {
              workItemRepo: adaptWorkItemRepo(workItemRepo),
              // The loop's run id is not handed to planning, so the first plan is written
              // under RUN_SCOPE_AD_HOC. This is the only work-item writer, and nothing
              // reads run_scope beyond parsing it.
              runScope: RUN_SCOPE_AD_HOC,
              projectId: write.projectId,
            },
            write.items,
            write.edges,
          );
          for (const owner of write.owners) {
            const id = plan.tempIdToId[owner.tempId];
            if (id === undefined) throw new OwnedTaskNotPlanned(write.projectId, owner.tempId);
            await workItemRepo.assignOwner(id, owner.workKind, owner.ownerRoleId);
          }
          return plan;
        },
      );
      return result.kind === "written" ? { kind: "written", created: result.value.created } : result;
    },
    recordFailedAttempt: (projectId, error) => recordFirstPlanFailure(db, projectId, error),
    stopPlanning: (projectId) => stopFirstPlanning(db, projectId),
    blockProject: (projectId, cause) => projects.block(projectId, cause),
  };
}

/** Engagement's planning-report store over projects, work_items, plan_revisions and client_messages. */
export function createPlanReportStore(db: ReturnType<typeof createDb> | DbTransaction): PlanReportStore {
  const projects = new ProjectRepository(db);
  return {
    dueReports: () => listDuePlanReports(db),
    postReport: (projectId, subject, body, revisionIds) => postPlanReport(db, projectId, subject, body, revisionIds),
    dueRevisionReports: () => listDuePlanRevisionReports(db),
    postRevisionReport: (revisionId, body) => postPlanRevisionReport(db, revisionId, body),
    blockProject: (projectId, cause) => projects.block(projectId, cause),
  };
}
