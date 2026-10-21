import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { parseProjectId, type ProjectId } from "@ashara/shared";
import type { Database, DbHandle } from "@ashara/db";
import { hasRoster, projects, roleOfLatestRoster, workItems } from "@ashara/db";
import { noOpenAnswer, noOpenStop, projectAtWork } from "../acl/engagement-predicates-acl.js";
import { currentStoredVision, hasVision } from "../acl/engagement-vision-acl.js";
import { WorkItemRowRepository } from "./work-item.js";
import { haltForPlanningStopped } from "./project-halt.js";

// Delivery's first plan of a project. A project awaits its first
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
        sql`(${workItems.ownerRoleId} IS NULL OR NOT ${roleOfLatestRoster(projectId, workItems.ownerRoleId)})`,
      ),
    );
  return rows.map((row) => row.id);
}

interface ProjectAwaitingPlanRow {
  readonly projectId: ProjectId;
  readonly projectName: string;
  readonly planAttempts: number;
  readonly planLastError: string | null;
  /** The project's current vision as Engagement's currentStoredVision selects it, read by its parseStoredVision. */
  readonly vision: unknown;
}

const awaitingPlan = () =>
  and(
    projectAtWork(),
    isNull(projects.firstPlannedAt),
    isNull(projects.planStoppedAt),
    hasVision(projects.id),
    sql`NOT EXISTS (SELECT 1 FROM work_items w WHERE w.project_id = projects.id)`,
    // First planning requires a roster: every task gets an owner.
    hasRoster(projects.id),
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
      vision: currentStoredVision(projects.id),
    })
    .from(projects)
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

/** A `dependsOn` entry a first plan's decomposition dropped. */
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
  fn: (workItemRepo: WorkItemRowRepository) => Promise<T>,
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

    const value = await fn(new WorkItemRowRepository(tx));

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

/**
 * Stamps planning stopped and halts the project, together, with the project row locked: the halt
 * through Delivery's guard.
 */
export async function stopFirstPlanning(db: DbHandle, projectId: ProjectId): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).for("update");
    const [row] = await tx
      .update(projects)
      .set({ planStoppedAt: sql`now()` })
      .where(and(eq(projects.id, projectId), awaitingPlan()))
      .returning({ lastError: projects.planLastError });
    if (!row) throw new ProjectNotAwaitingPlan(projectId, "stop planning");
    await haltForPlanningStopped(tx, projectId, row.lastError);
  });
}
