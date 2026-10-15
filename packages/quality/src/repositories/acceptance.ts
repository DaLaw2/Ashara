import { and, asc, eq, sql } from "drizzle-orm";
import { acceptanceSweeps, completedGoalTasks, noOpenAnswer, noOpenStop, pendingChange, pendingRepair, projectAtWork, projects } from "@ashara/db";
import type { Database, DbHandle, DbTransaction } from "@ashara/db";
import { parseProjectId, type ProjectId } from "@ashara/shared";

// A delivered project is accepted on one sweep of main HEAD (migration 049; story
// s-independent-verify-m1 W7, design P11). A project is ready for it once its first plan exists,
// no task of it is open (Pending, InProgress, Blocked, Failed), at least one goal task is Completed,
// no repair or revision is awaited, and no stop or answer awaits the Liaison. A passed sweep is
// recorded with the project's move to 'accepted' in one transaction, the project row locked and
// readiness read again; a failed one with the defect item it opens. Engagement's delivered report
// is due while a passed sweep has none (engagement repositories/delivered-report.ts).

/** Every condition of readiness, on the projects row in scope. */
const readyForAcceptance = sql`(${projectAtWork()}
  AND ${projects.firstPlannedAt} IS NOT NULL
  AND NOT ${pendingChange(projects.id)}
  AND NOT ${pendingRepair(projects.id)}
  AND ${noOpenStop(projects.id)}
  AND ${noOpenAnswer()}
  AND NOT EXISTS (SELECT 1 FROM work_items w WHERE w.project_id = projects.id AND w.level = 'Task'
    AND w.status IN ('Pending', 'InProgress', 'Blocked', 'Failed'))
  AND EXISTS (SELECT 1 FROM work_items w WHERE w.project_id = projects.id AND w.level = 'Task'
    AND w.status = 'Completed' AND w.task_spec->>'origin' = 'decomposition'))`;

interface ReadyProjectRow {
  readonly projectId: ProjectId;
  /** null when no workspace was ever minted: nothing can be swept, and the caller says so. */
  readonly workspacePath: string | null;
  /** The project's Completed goal tasks (decomposition), oldest completion first. */
  readonly goalTaskIds: readonly string[];
}

/** The projects ready for their acceptance sweep, oldest first. */
export async function listProjectsReadyForAcceptance(db: DbHandle): Promise<ReadyProjectRow[]> {
  const rows = await db
    .select({ id: projects.id, workspacePath: projects.workspacePath })
    .from(projects)
    .where(readyForAcceptance)
    .orderBy(asc(projects.createdAt), asc(projects.id));
  const ready: ReadyProjectRow[] = [];
  for (const row of rows) {
    const goals = await completedGoalTasks(db, row.id);
    ready.push({
      projectId: parseProjectId(row.id, "projects.id"),
      workspacePath: row.workspacePath,
      goalTaskIds: goals.map((goal) => goal.id),
    });
  }
  return ready;
}

/** What one sweep recorded, whatever its verdict. */
interface AcceptanceSweepRecord {
  readonly projectId: ProjectId;
  /** null only on a sweep that faulted before main could be read (never a passed one). */
  readonly mainCommit: string | null;
  readonly environmentVersion: string | null;
  readonly checkedTasks: readonly string[];
  /** Completed implementation tasks with no stored check, which nothing re-ran. */
  readonly uncheckedTasks: readonly string[];
  readonly details: string;
}

/** recordSweepFault named a project with no row. */
class AcceptanceFaultProjectMissing extends Error {
  constructor(readonly projectId: ProjectId) {
    super(`cannot count an acceptance sweep fault on project ${projectId}: no projects row has that id`);
    this.name = "AcceptanceFaultProjectMissing";
  }
}

/**
 * Counts one acceptance sweep that could not run on the project (projects.acceptance_faults,
 * migration 049), durably, and returns the count with it: the bound outlives a restart.
 */
export async function recordAcceptanceSweepFault(db: DbHandle, projectId: ProjectId): Promise<number> {
  const [row] = await db
    .update(projects)
    .set({ acceptanceFaults: sql`${projects.acceptanceFaults} + 1` })
    .where(eq(projects.id, projectId))
    .returning({ faults: projects.acceptanceFaults });
  if (!row) throw new AcceptanceFaultProjectMissing(projectId);
  return row.faults;
}

/** Locks the project row and reads readiness again; false when the project moved since it was listed. */
async function lockReady(tx: DbHandle, projectId: ProjectId): Promise<boolean> {
  await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).for("update");
  const [ready] = await tx.select({ id: projects.id }).from(projects).where(and(eq(projects.id, projectId), readyForAcceptance));
  return ready !== undefined;
}

/**
 * A sweep that passed: recorded, and the project moved to 'accepted' by `accept` (Engagement's
 * lifecycle guard, which the composition root supplies), in one transaction (the
 * projects_acceptance_guard trigger refuses the move without the row). "moved" when the project is
 * no longer ready; nothing is written.
 */
export async function recordAcceptance(
  db: Database,
  sweep: AcceptanceSweepRecord & { readonly mainCommit: string },
  accept: (tx: DbTransaction, projectId: ProjectId) => Promise<void>,
): Promise<"accepted" | "moved"> {
  return db.transaction(async (tx) => {
    if (!(await lockReady(tx, sweep.projectId))) return "moved";
    await tx.insert(acceptanceSweeps).values({
      projectId: sweep.projectId,
      mainCommit: sweep.mainCommit,
      environmentVersion: sweep.environmentVersion,
      checkedTasks: [...sweep.checkedTasks],
      uncheckedTasks: [...sweep.uncheckedTasks],
      passed: true,
      details: sweep.details,
    });
    await accept(tx, sweep.projectId);
    return "accepted";
  });
}

/**
 * A sweep that failed: `writeDefect` writes the defect item in the transaction and gives it up (so
 * migration 048's trigger opens its repair) and returns its id; the sweep is recorded with it, in one transaction.
 * "moved" when the project is no longer ready; nothing is written.
 */
export async function recordAcceptanceDefect(
  db: Database,
  sweep: AcceptanceSweepRecord,
  writeDefect: (tx: DbTransaction) => Promise<string>,
): Promise<"recorded" | "moved"> {
  return db.transaction(async (tx) => {
    if (!(await lockReady(tx, sweep.projectId))) return "moved";
    const defectItemId = await writeDefect(tx);
    await tx.insert(acceptanceSweeps).values({
      projectId: sweep.projectId,
      mainCommit: sweep.mainCommit,
      environmentVersion: sweep.environmentVersion,
      checkedTasks: [...sweep.checkedTasks],
      uncheckedTasks: [...sweep.uncheckedTasks],
      passed: false,
      details: sweep.details,
      defectItemId,
    });
    return "recorded";
  });
}
