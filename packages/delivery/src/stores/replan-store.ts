import type { createDb } from "@ashara/db";
import { parseWorkItemId, readEach, type Logger, type ProjectId } from "@ashara/shared";
import { latestRosterRoles } from "../acl/organization-roster-acl.js";
import { createBulkPlan } from "../bulk-plan.js";
import { PlanningService } from "../domain/index.js";
import type { AttemptGrade, ReplanStore } from "../replan-port.js";
import { completedAttemptGrades, decidedByLatestChecks, listProjectsAwaitingReplan, recordReplanFailure, withPlanRevisionTransaction } from "../repositories/replan.js";
import { ProjectHaltRepository } from "../repositories/project-halt.js";
import { adaptWorkItemRepo, rowToWorkItem } from "../repositories/work-item-adapter.js";
import { WorkItemRowRepository } from "../repositories/work-item.js";
import { recordPlannedAssumptions } from "./planned-behaviour.js";

/** An owner or an edge names a temp id the revision did not write. */
class RevisionItemNotPlanned extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly tempId: string,
    readonly role: "owner" | "edge",
  ) {
    super(`plan revision of project ${projectId}: an ${role} names "${tempId}", which is not an item of the revision`);
    this.name = "RevisionItemNotPlanned";
  }
}

/** A task's grade from the project's completed attempts; unrecorded when none of them names its model. */
function attemptGradeOf(grades: ReadonlyMap<string, AttemptGrade>, taskId: string): AttemptGrade {
  const graded = grades.get(taskId);
  if (graded !== undefined) return graded;
  return { kind: "unrecorded", why: "no completed attempt of it records the model it ran on" };
}

/** Delivery's plan revision store over projects, vision_documents, roster_roles, work_items, task_checks and plan_revisions. */
export function createReplanStore(db: ReturnType<typeof createDb>, logger: Logger): ReplanStore {
  const projects = new ProjectHaltRepository(db);
  const workItems = new WorkItemRowRepository(db);
  return {
    async projectsAwaitingReplan() {
      // Each project's roster, work items and stored checks are read on its own (readEach): one
      // project's row that does not parse is that project's UnreadSubject, never the listing's.
      return readEach(
        await listProjectsAwaitingReplan(db),
        (row) => ({ id: row.projectId, projectId: row.projectId }),
        async (row) => {
          const decided = await decidedByLatestChecks(db, row.projectId);
          const grades = await completedAttemptGrades(db, row.projectId);
          return {
          projectId: row.projectId,
          projectName: row.projectName,
          correctionsAwaited: row.correctionsAwaited,
          repairsAwaited: row.repairsAwaited,
          vision: row.vision,
          dependencies: await workItems.listDependenciesByProject(row.projectId),
          rosterRows: await latestRosterRoles(db, row.projectId),
          replanAttempts: row.replanAttempts,
          replanLastError: row.replanLastError,
          replanLastFailure: row.replanLastFailure,
          revisionsSinceReview: row.revisionsSinceReview,
          repairsSinceReview: row.repairsSinceReview,
          nextRevision: row.nextRevision,
          items: (await workItems.listByProject(row.projectId)).map((item) => ({
            item: rowToWorkItem(item),
            mergeCommit: item.mergeCommit,
            attemptGrade: attemptGradeOf(grades, item.id),
            environmentStatement: item.environmentStatement,
            // eslint-disable-next-line no-restricted-syntax -- policy default: a task with no stored checks decides no item (decidedByLatestChecks), the reading that counts none of its items as covered
            decided: decided.get(item.id) ?? [],
          })),
          };
        },
      );
    },
    async writeRevision(write) {
      // The supersession and the bulk-plan path run inside the locked revision transaction, so
      // the superseded items, the new items with their edges and owners, the revision record and the corrections and repairs it took in commit together.
      return withPlanRevisionTransaction(
        db,
        {
          projectId: write.projectId,
          revision: write.revision,
          visionVersion: write.visionVersion,
          corrections: write.corrections,
          repaired: write.repaired,
          summary: write.summary,
          events: write.events,
        },
        async (workItemRepo, tx) => {
          await recordPlannedAssumptions(tx, write.projectId, write.revision, write.plan.assumptions);
          const domainRepo = adaptWorkItemRepo(workItemRepo);
          for (const { item, previousStatus } of write.superseded) {
            await PlanningService.saveWorkItem(domainRepo, item, previousStatus);
          }
          const plan = await createBulkPlan(
            {
              workItemRepo: domainRepo,
              projectId: write.projectId,
            },
            write.plan.items,
            write.plan.edges,
          );
          for (const edge of write.existingEdges) {
            const from = plan.tempIdToId[edge.from];
            if (from === undefined) throw new RevisionItemNotPlanned(write.projectId, edge.from, "edge");
            await domainRepo.addDependency(from, parseWorkItemId(edge.to, "replan existingEdges[].to"));
          }
          for (const { taskId, from, toTempId } of write.regated) {
            const to = plan.tempIdToId[toTempId];
            if (to === undefined) throw new RevisionItemNotPlanned(write.projectId, toTempId, "edge");
            await workItemRepo.removeDependency(taskId, from);
            await workItemRepo.addDependency(taskId, to);
          }
          for (const owner of write.plan.owners) {
            const id = plan.tempIdToId[owner.tempId];
            if (id === undefined) throw new RevisionItemNotPlanned(write.projectId, owner.tempId, "owner");
            await workItemRepo.assignOwner(id, owner.workKind, owner.ownerRoleId);
          }
        },
        logger,
      );
    },
    recordFailedAttempt: (projectId, error, failure) => recordReplanFailure(db, projectId, error, failure),
    blockProject: (projectId, cause) => projects.block(projectId, cause),
  };
}
