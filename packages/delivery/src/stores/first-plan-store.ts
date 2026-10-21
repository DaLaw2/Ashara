import { latestRosterRoles } from "@ashara/db";
import type { createDb } from "@ashara/db";
import { readEach } from "@ashara/shared";
import type { ProjectId } from "@ashara/shared";
import { parseStoredVision } from "../acl/engagement-vision-acl.js";
import { createBulkPlan } from "../bulk-plan.js";
import type { FirstPlanStore } from "../first-plan.js";
import { listProjectsAwaitingFirstPlan, recordFirstPlanFailure, stopFirstPlanning, withFirstPlanTransaction } from "../repositories/first-plan.js";
import { ProjectHaltRepository } from "../repositories/project-halt.js";
import { adaptWorkItemRepo } from "../repositories/work-item-adapter.js";

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
  const projects = new ProjectHaltRepository(db);
  return {
    async projectsAwaitingPlan() {
      // Each project's roster is read on its own (readEach): one that does not read is that project's UnreadSubject.
      return readEach(
        await listProjectsAwaitingFirstPlan(db),
        (row) => ({ id: row.projectId, projectId: row.projectId }),
        async (row) => ({
          projectId: row.projectId,
          projectName: row.projectName,
          vision: parseStoredVision(row.projectId, row.vision),
          planAttempts: row.planAttempts,
          planLastError: row.planLastError,
          rosterRows: await latestRosterRoles(db, row.projectId),
        }),
      );
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
