import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { DbHandle } from "@ashara/db";
import { projectPlans } from "@ashara/db/schema/delivery";
import type { ProjectId } from "@ashara/shared";

// Delivery's planning record of one project (project_plans): the first plan's failed attempts and
// its outcome, written or stopped, and the failed attempts to revise the plan for the current
// request. Every write of it is a function here, called inside a transaction that holds the project
// row locked, and each creates the row it changes: a project with no row has had no planning event.
// Each function holds the record's own invariants; whether the project awaits the planning at all
// is its caller's read of the shared state.

/** A planning record write the record's own state refuses: nothing was written. */
class PlanningRecordRefused extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly operation: string,
    readonly state: string,
  ) {
    super(`cannot ${operation} on project ${projectId}: its planning record ${state}`);
    this.name = "PlanningRecordRefused";
  }
}

/** The project's first planning has no outcome: no plan written and planning not stopped. */
const noOutcome = () => and(isNull(projectPlans.firstPlannedAt), isNull(projectPlans.planStoppedAt));

async function openRecord(tx: DbHandle, projectId: ProjectId): Promise<void> {
  await tx.insert(projectPlans).values({ projectId }).onConflictDoNothing();
}

/** A `dependsOn` entry a first plan's decomposition dropped. */
export interface DroppedPlanDependency {
  readonly dependentTaskTitle: string;
  readonly unresolvedRef: string;
}

/** Stamps the first plan written, with the ordering hints its decomposition dropped. */
export async function planWritten(tx: DbHandle, projectId: ProjectId, dropped: readonly DroppedPlanDependency[]): Promise<void> {
  await openRecord(tx, projectId);
  const [row] = await tx
    .update(projectPlans)
    .set({ firstPlannedAt: sql`now()`, planDroppedDependencies: dropped })
    .where(and(eq(projectPlans.projectId, projectId), noOutcome()))
    .returning({ projectId: projectPlans.projectId });
  if (!row) throw new PlanningRecordRefused(projectId, "stamp the first plan", "already has a planning outcome");
}

/** Counts one failed first-planning attempt with its error; returns the count after it. */
export async function recordPlanFailure(tx: DbHandle, projectId: ProjectId, error: string): Promise<number> {
  await openRecord(tx, projectId);
  const [row] = await tx
    .update(projectPlans)
    .set({ planAttempts: sql`${projectPlans.planAttempts} + 1`, planLastError: error })
    .where(and(eq(projectPlans.projectId, projectId), noOutcome()))
    .returning({ planAttempts: projectPlans.planAttempts });
  if (!row) throw new PlanningRecordRefused(projectId, "record a failed planning attempt", "already has a planning outcome");
  return row.planAttempts;
}

/** Stamps first planning stopped; returns the last failed attempt's error, null when none was recorded. */
export async function stopPlanning(tx: DbHandle, projectId: ProjectId): Promise<string | null> {
  await openRecord(tx, projectId);
  const [row] = await tx
    .update(projectPlans)
    .set({ planStoppedAt: sql`now()` })
    .where(and(eq(projectPlans.projectId, projectId), noOutcome()))
    .returning({ lastError: projectPlans.planLastError });
  if (!row) throw new PlanningRecordRefused(projectId, "stop planning", "already has a planning outcome");
  return row.lastError;
}

/** Counts one failed attempt to revise the plan, with its error and whose failure it was; returns the count after it. */
export async function recordReplanFailure(tx: DbHandle, projectId: ProjectId, error: string, failure: "model" | "provider"): Promise<number> {
  await openRecord(tx, projectId);
  const [row] = await tx
    .update(projectPlans)
    .set({ replanAttempts: sql`${projectPlans.replanAttempts} + 1`, replanLastError: error, replanLastFailure: failure })
    .where(and(eq(projectPlans.projectId, projectId), isNotNull(projectPlans.firstPlannedAt)))
    .returning({ replanAttempts: projectPlans.replanAttempts });
  if (!row) throw new PlanningRecordRefused(projectId, "record a failed plan revision attempt", "has no first plan written");
  return row.replanAttempts;
}

/** A revision was written: the next one is tried from no attempts. */
export async function revisionWritten(tx: DbHandle, projectId: ProjectId): Promise<void> {
  await openRecord(tx, projectId);
  await tx
    .update(projectPlans)
    .set({ replanAttempts: 0, replanLastError: null, replanLastFailure: null })
    .where(eq(projectPlans.projectId, projectId));
}

/**
 * The operator ended the project's halt: a revision that gave up is tried again from no attempts,
 * and a first planning that gave up runs again from no attempts.
 */
export async function resetOnUnblock(tx: DbHandle, projectId: ProjectId): Promise<void> {
  await openRecord(tx, projectId);
  await tx
    .update(projectPlans)
    .set({ replanAttempts: 0, replanLastError: null, replanLastFailure: null })
    .where(eq(projectPlans.projectId, projectId));
  await tx
    .update(projectPlans)
    .set({ planStoppedAt: null, planAttempts: 0, planLastError: null })
    .where(and(eq(projectPlans.projectId, projectId), isNotNull(projectPlans.planStoppedAt)));
}
