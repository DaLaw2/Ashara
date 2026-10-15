import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { parseProjectId, type ProjectId } from "@ashara/shared";
import type { Database, DbHandle } from "../connection.js";
import { projects, visionDocuments, workItems } from "../schema/index.js";
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

/** A first plan would commit a task with no owner, or one owned by a role outside the project's latest roster. */
class FirstPlanTaskUnowned extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly taskIds: readonly string[],
  ) {
    super(
      `cannot stamp the first plan of project ${projectId}: task(s) ${taskIds.join(", ")} have no owner ` +
        `from the project's latest roster`,
    );
    this.name = "FirstPlanTaskUnowned";
  }
}

/** The project's tasks whose owner is missing or not a role of its latest roster revision. */
export async function tasksWithoutRosterOwner(db: DbHandle, projectId: ProjectId): Promise<string[]> {
  const rows = await db
    .select({ id: workItems.id })
    .from(workItems)
    .where(
      and(
        eq(workItems.projectId, projectId),
        eq(workItems.level, "Task"),
        sql`(${workItems.ownerRoleId} IS NULL OR NOT EXISTS (
          SELECT 1 FROM roster_roles r
          WHERE r.project_id = ${projectId} AND r.role_id = ${workItems.ownerRoleId}
            AND r.revision = (SELECT MAX(l.revision) FROM roster_roles l WHERE l.project_id = ${projectId})))`,
      ),
    );
  return rows.map((row) => row.id);
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
    // First planning requires a roster (migration 031): every task gets an owner.
    sql`EXISTS (SELECT 1 FROM roster_roles r WHERE r.project_id = projects.id)`,
  );

// An answer the Liaison has yet to read may change the vision: the project is
// planned once its answers are in (migration 038).
export const noOpenAnswer = () =>
  sql`NOT EXISTS (SELECT 1 FROM client_messages a WHERE a.project_id = projects.id
    AND a.direction = 'inbound' AND a.kind = 'answer' AND a.consumed_at IS NULL)`;

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
    .where(and(awaitingPlan(), noOpenStop(projects.id), noOpenAnswer()))
    .orderBy(asc(projects.createdAt), asc(projects.id));

  return rows.map((row) => ({
    projectId: parseProjectId(row.id, "projects.id"),
    projectName: row.name,
    planAttempts: row.planAttempts,
    planLastError: row.planLastError,
    vision: row.vision,
  }));
}

/** A `dependsOn` entry a first plan's decomposition dropped (migration 033). */
export interface DroppedPlanDependency {
  readonly dependentTaskTitle: string;
  readonly unresolvedRef: string;
}

type FirstPlanTransaction<T> =
  | { readonly kind: "written"; readonly value: T }
  | { readonly kind: "already-planned" };

/**
 * Runs the plan write in one transaction with the project row locked, then
 * stamps first_planned_at together with the ordering hints the plan dropped. If
 * the project no longer awaits a plan when the lock is held (work items
 * appeared, or an outcome was stamped), nothing is written.
 */
export async function withFirstPlanTransaction<T>(
  db: Database,
  projectId: ProjectId,
  droppedDependencies: readonly DroppedPlanDependency[],
  fn: (workItemRepo: WorkItemRepository) => Promise<T>,
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

    const value = await fn(new WorkItemRepository(tx));

    const [anyItem] = await tx.select({ id: workItems.id }).from(workItems).where(eq(workItems.projectId, projectId)).limit(1);
    if (!anyItem) throw new ProjectNotAwaitingPlan(projectId, "stamp a first plan that wrote no work items");
    const unowned = await tasksWithoutRosterOwner(tx, projectId);
    if (unowned.length > 0) throw new FirstPlanTaskUnowned(projectId, unowned);
    await tx
      .update(projects)
      .set({ firstPlannedAt: sql`now()`, planDroppedDependencies: droppedDependencies })
      .where(eq(projects.id, projectId));
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
