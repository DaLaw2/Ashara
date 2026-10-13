import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { parseProjectId, type ProjectId } from "@ashara/shared";
import type { Database, DbHandle } from "../connection.js";
import { projects, visionDocuments, workItems } from "../schema.js";
import type { PlanningTransactionRepos } from "./planning-transaction.js";
import { ContractRepository } from "./contract.js";
import { WorkItemRepository } from "./work-item.js";
import { noOpenStop } from "./project.js";

// Delivery's first plan of a project (migration 020). A project awaits its first
// plan while it is active, has a vision, has no work items and has no planning
// outcome stamped.

/** The project was expected to await its first plan and does not. */
class ProjectNotAwaitingPlan extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly operation: string,
  ) {
    super(`cannot ${operation}: project ${projectId} is not an active project awaiting its first plan`);
    this.name = "ProjectNotAwaitingPlan";
  }
}

interface ProjectAwaitingPlanRow {
  readonly projectId: ProjectId;
  readonly projectName: string;
  readonly planAttempts: number;
  readonly planLastError: string | null;
  readonly vision: typeof visionDocuments.$inferSelect;
}

const awaitingPlan = () =>
  and(
    eq(projects.status, "active"),
    isNull(projects.firstPlannedAt),
    isNull(projects.planStoppedAt),
    sql`EXISTS (SELECT 1 FROM vision_documents v WHERE v.project_id = projects.id)`,
    sql`NOT EXISTS (SELECT 1 FROM work_items w WHERE w.project_id = projects.id)`,
  );

/**
 * Projects awaiting their first plan, oldest first, each with its current vision.
 * A project with a stop awaiting the Liaison is not listed; a plan already in
 * progress when the stop lands is still written, and is never dispatched.
 * One statement, so a project and the vision it is listed with are read from the
 * same snapshot.
 */
export async function listProjectsAwaitingFirstPlan(db: DbHandle): Promise<ProjectAwaitingPlanRow[]> {
  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      planAttempts: projects.planAttempts,
      planLastError: projects.planLastError,
      vision: visionDocuments,
    })
    .from(projects)
    .innerJoin(
      visionDocuments,
      and(
        eq(visionDocuments.projectId, projects.id),
        sql`${visionDocuments.version} = (SELECT MAX(v.version) FROM vision_documents v WHERE v.project_id = projects.id)`,
      ),
    )
    .where(and(awaitingPlan(), noOpenStop(projects.id)))
    .orderBy(asc(projects.createdAt), asc(projects.id));

  return rows.map((row) => ({
    projectId: parseProjectId(row.id),
    projectName: row.name,
    planAttempts: row.planAttempts,
    planLastError: row.planLastError,
    vision: row.vision,
  }));
}

type FirstPlanTransaction<T> =
  | { readonly kind: "written"; readonly value: T }
  | { readonly kind: "already-planned" };

/**
 * Runs the plan write in one transaction with the project row locked, then
 * stamps first_planned_at. If the project no longer awaits a plan when the lock
 * is held (work items appeared, or an outcome was stamped), nothing is written.
 */
export async function withFirstPlanTransaction<T>(
  db: Database,
  projectId: ProjectId,
  fn: (repos: PlanningTransactionRepos) => Promise<T>,
): Promise<FirstPlanTransaction<T>> {
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId))
      .for("update");
    if (!locked) throw new ProjectNotAwaitingPlan(projectId, "write a first plan (no such project)");

    const [stillAwaiting] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), awaitingPlan()));
    if (!stillAwaiting) return { kind: "already-planned" };

    const value = await fn({ workItemRepo: new WorkItemRepository(tx), contractRepo: new ContractRepository(tx) });

    const [anyItem] = await tx.select({ id: workItems.id }).from(workItems).where(eq(workItems.projectId, projectId)).limit(1);
    if (!anyItem) throw new ProjectNotAwaitingPlan(projectId, "stamp a first plan that wrote no work items");
    await tx.update(projects).set({ firstPlannedAt: sql`now()` }).where(eq(projects.id, projectId));
    return { kind: "written", value };
  });
}

/** Counts one failed planning attempt with its error; returns the count after it. */
export async function recordFirstPlanFailure(db: DbHandle, projectId: ProjectId, error: string): Promise<number> {
  const [row] = await db
    .update(projects)
    .set({ planAttempts: sql`${projects.planAttempts} + 1`, planLastError: error })
    .where(and(eq(projects.id, projectId), awaitingPlan()))
    .returning({ planAttempts: projects.planAttempts });
  if (!row) throw new ProjectNotAwaitingPlan(projectId, "record a failed planning attempt");
  return row.planAttempts;
}

/** Blocks the project and stamps planning stopped, together. */
export async function stopFirstPlanning(db: DbHandle, projectId: ProjectId): Promise<void> {
  const [row] = await db
    .update(projects)
    .set({ status: "blocked", planStoppedAt: sql`now()` })
    .where(and(eq(projects.id, projectId), awaitingPlan()))
    .returning({ id: projects.id });
  if (!row) throw new ProjectNotAwaitingPlan(projectId, "stop planning");
}
