import {
  ProjectRepository,
  WorkItemRepository,
  latestRosterRoles,
  listProjectsAwaitingReplan,
  recordReplanFailure,
  withPlanRevisionTransaction,
} from "@ashara/db";
import type { createDb } from "@ashara/db";
import { PlanningService, createBulkPlanWithContract } from "@ashara/planning";
import type { ReplanStore } from "@ashara/planning";
import { RUN_SCOPE_AD_HOC, parseWorkItemId, type ProjectId } from "@ashara/shared";
import { adaptWorkItemRepo, rowToWorkItem } from "./work-item-adapter.js";

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

/** Delivery's plan revision store over projects, vision_documents, roster_roles, work_items and plan_revisions. */
export function createReplanStore(db: ReturnType<typeof createDb>): ReplanStore {
  const projects = new ProjectRepository(db);
  const workItems = new WorkItemRepository(db);
  return {
    async projectsAwaitingReplan() {
      const rows = await listProjectsAwaitingReplan(db);
      return Promise.all(
        rows.map(async (row) => ({
          projectId: row.projectId,
          projectName: row.projectName,
          requestedBy: row.requestedBy,
          repairsAwaited: row.repairsAwaited,
          visionVersion: row.vision.version,
          visionText: row.vision.visionText,
          summary: row.vision.summary,
          scopeBoundaries: row.vision.scopeBoundaries,
          inferences: row.vision.inferences,
          rosterRows: await latestRosterRoles(db, row.projectId),
          replanAttempts: row.replanAttempts,
          replanLastError: row.replanLastError,
          revisionsSinceReview: row.revisionsSinceReview,
          repairsSinceReview: row.repairsSinceReview,
          nextRevision: row.nextRevision,
          items: (await workItems.listByProject(row.projectId)).map((item) => ({
            item: rowToWorkItem(item),
            mergeCommit: item.mergeCommit,
            environmentStatement: item.environmentStatement,
          })),
        })),
      );
    },
    async writeRevision(write) {
      // The supersession and the bulk-plan path run inside the locked revision transaction, so
      // the superseded items, the new items with their edges and owners, the contract, the
      // revision record and the cleared flag commit together.
      return withPlanRevisionTransaction(
        db,
        {
          projectId: write.projectId,
          revision: write.revision,
          visionVersion: write.visionVersion,
          requestedBy: write.requestedBy,
          repaired: write.repaired,
          summary: write.summary,
          events: write.events,
        },
        async ({ workItemRepo, contractRepo }) => {
          const domainRepo = adaptWorkItemRepo(workItemRepo);
          for (const { item, previousStatus } of write.superseded) {
            await PlanningService.saveWorkItem(domainRepo, item, previousStatus);
          }
          const plan = await createBulkPlanWithContract(
            {
              withPlanningTransaction: (fn) => fn({ workItemRepo: domainRepo, contractRepo }),
              // As for the first plan: the loop's run id is not handed to planning.
              runScope: RUN_SCOPE_AD_HOC,
              projectId: write.projectId,
            },
            write.plan.items,
            write.plan.edges,
            write.plan.knowledge,
          );
          for (const edge of write.existingEdges) {
            const from = plan.tempIdToId[edge.from];
            if (from === undefined) throw new RevisionItemNotPlanned(write.projectId, edge.from, "edge");
            await domainRepo.addDependency(from, parseWorkItemId(edge.to, "replan existingEdges[].to"));
          }
          for (const owner of write.plan.owners) {
            const id = plan.tempIdToId[owner.tempId];
            if (id === undefined) throw new RevisionItemNotPlanned(write.projectId, owner.tempId, "owner");
            await workItemRepo.assignOwner(id, owner.workKind, owner.ownerRoleId);
          }
        },
      );
    },
    recordFailedAttempt: (projectId, error) => recordReplanFailure(db, projectId, error),
    blockProject: (projectId, cause) => projects.block(projectId, cause),
  };
}
