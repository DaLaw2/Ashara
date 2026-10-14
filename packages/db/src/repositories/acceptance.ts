import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { parseProjectId, parseStoredTaskSpec, type ProjectId, type VisionSource } from "@ashara/shared";
import type { Database, DbHandle } from "../connection.js";
import { acceptanceSweeps, clientMessages, projects, taskChecks, workItems } from "../schema.js";
import { noOpenAnswer } from "./first-plan.js";
import { noOpenStop, pendingChange, pendingRepair } from "./project.js";
import { WorkItemRepository } from "./work-item.js";

// A delivered project is accepted on one sweep of main HEAD (migration 049; story
// s-independent-verify-m1 W7, design P11). A project is ready for it once its first plan exists,
// no task of it is open (Pending, InProgress, Blocked, Failed), at least one goal task is Completed,
// no repair or revision is awaited, and no stop or answer awaits the Liaison. A passed sweep is
// recorded with the project's move to 'accepted' in one transaction, the project row locked and
// readiness read again; a failed one with the defect item it opens. The Liaison's delivered report
// is due while a passed sweep has none.

/** Every condition of readiness, on the projects row in scope. */
const readyForAcceptance = sql`(${projects.status} = 'active'
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

async function completedGoalTasks(db: DbHandle, projectId: string): Promise<Array<typeof workItems.$inferSelect>> {
  return db
    .select()
    .from(workItems)
    .where(
      and(
        eq(workItems.projectId, projectId),
        eq(workItems.level, "Task"),
        eq(workItems.status, "Completed"),
        sql`${workItems.taskSpec}->>'origin' = 'decomposition'`,
      ),
    )
    .orderBy(asc(workItems.updatedAt), asc(workItems.id));
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
 * A sweep that passed: recorded, and the project moved to 'accepted', in one transaction (the
 * projects_acceptance_guard trigger refuses the move without the row). "moved" when the project is
 * no longer ready; nothing is written.
 */
export async function recordAcceptance(db: Database, sweep: AcceptanceSweepRecord & { readonly mainCommit: string }): Promise<"accepted" | "moved"> {
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
    await tx.update(projects).set({ status: "accepted" }).where(eq(projects.id, sweep.projectId));
    return "accepted";
  });
}

/**
 * A sweep that failed: `writeDefect` writes the defect item and gives it up (so migration 048's
 * trigger opens its repair) and returns its id; the sweep is recorded with it, in one transaction.
 * "moved" when the project is no longer ready; nothing is written.
 */
export async function recordAcceptanceDefect(
  db: Database,
  sweep: AcceptanceSweepRecord,
  writeDefect: (workItems: WorkItemRepository) => Promise<string>,
): Promise<"recorded" | "moved"> {
  return db.transaction(async (tx) => {
    if (!(await lockReady(tx, sweep.projectId))) return "moved";
    const defectItemId = await writeDefect(new WorkItemRepository(tx));
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

/** How a goal task's recorded commit closed it (migration 049). */
type GoalClose =
  | { readonly kind: "merged"; readonly commit: string }
  /** `by` is the task whose merge made that commit, null when no task records it as its merge. */
  | { readonly kind: "already-delivered"; readonly commit: string; readonly by: string | null }
  /** A commit is recorded, but not how it closed the task (a record from before migration 049). */
  | { readonly kind: "unrecorded-kind"; readonly commit: string }
  /** Completed with no commit recorded at all. */
  | { readonly kind: "no-record" };

/**
 * Every item of the vision the delivered plan was reviewed against, each with whether an acceptance
 * line of a check task whose stored checks ran in the sweep cites it.
 */
type VisionCoverage =
  | { readonly kind: "recorded"; readonly items: ReadonlyArray<{ readonly source: VisionSource; readonly checked: boolean }> }
  /** The review, or a check task whose checks ran, records no traced items: coverage cannot be stated. */
  | { readonly kind: "unrecorded" };

interface DueDeliveredReportRow {
  readonly sweepId: string;
  readonly projectId: ProjectId;
  readonly mainCommit: string;
  readonly goals: ReadonlyArray<{ readonly title: string; readonly close: GoalClose }>;
  /** The titles of the completed tasks whose stored checks the sweep ran. */
  readonly checked: readonly string[];
  /** The titles of the completed tasks with no stored check: nothing of theirs ran in the sweep. */
  readonly unchecked: readonly string[];
  /** The titles of goal tasks given up (Abandoned), which the plan was repaired around. */
  readonly givenUp: readonly string[];
  readonly vision: VisionCoverage;
}

const SweepTaskIdsSchema = z.array(z.guid());

/** A passed sweep's stored checked_tasks or unchecked_tasks is not a list of work item ids. */
class SweepTasksUnreadable extends Error {
  constructor(
    readonly sweepId: string,
    readonly column: "checked_tasks" | "unchecked_tasks",
    readonly detail: string,
  ) {
    super(`acceptance sweep ${sweepId}: ${column} is not a list of work item ids: ${detail}`);
    this.name = "SweepTasksUnreadable";
  }
}

/** A sweep names a task id that has no work_items row: the report cannot name it. */
class SweepTaskMissing extends Error {
  constructor(
    readonly sweepId: string,
    readonly taskId: string,
  ) {
    super(`acceptance sweep ${sweepId} names task ${taskId}, which has no work_items row`);
    this.name = "SweepTaskMissing";
  }
}

/** The titles of the tasks a sweep's jsonb column names, in its order. */
async function sweepTaskTitles(db: DbHandle, sweepId: string, column: "checked_tasks" | "unchecked_tasks", raw: unknown): Promise<string[]> {
  const parsed = SweepTaskIdsSchema.safeParse(raw);
  if (!parsed.success) throw new SweepTasksUnreadable(sweepId, column, z.prettifyError(parsed.error));
  if (parsed.data.length === 0) return [];
  const rows = await db.select({ id: workItems.id, title: workItems.title }).from(workItems).where(inArray(workItems.id, parsed.data));
  const titles = new Map(rows.map((row) => [row.id, row.title]));
  return parsed.data.map((id) => {
    const title = titles.get(id);
    if (title === undefined) throw new SweepTaskMissing(sweepId, id);
    return title;
  });
}

/** The project's goal tasks given up (Abandoned), oldest first: each is a task the plan was repaired around. */
async function givenUpGoalTitles(db: DbHandle, projectId: string): Promise<string[]> {
  const rows = await db
    .select({ title: workItems.title })
    .from(workItems)
    .where(
      and(
        eq(workItems.projectId, projectId),
        eq(workItems.level, "Task"),
        eq(workItems.status, "Abandoned"),
        sql`${workItems.taskSpec}->>'origin' = 'decomposition'`,
      ),
    )
    .orderBy(asc(workItems.updatedAt), asc(workItems.id));
  return rows.map((row) => row.title);
}

/** A check task's acceptance line cites an item id its own task_spec.sources does not hold. */
class AcceptanceTraceBroken extends Error {
  constructor(
    readonly checkTaskId: string,
    readonly line: string,
    readonly sourceId: string,
  ) {
    super(`check task ${checkTaskId}: acceptance line "${line}" cites ${sourceId}, which its task_spec.sources does not hold`);
    this.name = "AcceptanceTraceBroken";
  }
}

/** An item is the same across the plan's revisions only when its type, id and text all match. */
function sourceIdentity(source: VisionSource): string {
  return JSON.stringify([source.type, source.id, source.text]);
}

/**
 * The items a check task's acceptance lines cite, by identity; null when the task records no traced
 * lines (written before d89), so what it covers is not on record.
 */
function citedBy(checkTaskId: string, rawSpec: unknown): Set<string> | null {
  const spec = parseStoredTaskSpec(rawSpec);
  if (spec?.acceptance === undefined || spec.sources === undefined) return null;
  const sources = new Map(spec.sources.map((source) => [source.id, source]));
  const cited = new Set<string>();
  for (const line of spec.acceptance) {
    for (const id of line.sources) {
      const source = sources.get(id);
      if (source === undefined) throw new AcceptanceTraceBroken(checkTaskId, line.line, id);
      cited.add(sourceIdentity(source));
    }
  }
  return cited;
}

async function goalCloses(db: DbHandle, projectId: string): Promise<DueDeliveredReportRow["goals"]> {
  const goals = await completedGoalTasks(db, projectId);
  const merges = await db
    .select({ title: workItems.title, commit: workItems.mergeCommit })
    .from(workItems)
    .where(and(eq(workItems.projectId, projectId), eq(workItems.mergeKind, "merged")));
  return goals.map((goal) => {
    const commit = goal.mergeCommit;
    if (commit === null) return { title: goal.title, close: { kind: "no-record" } };
    if (goal.mergeKind === "merged") return { title: goal.title, close: { kind: "merged", commit } };
    if (goal.mergeKind === "already_delivered") {
      const by = merges.find((merge) => merge.commit === commit)?.title ?? null;
      return { title: goal.title, close: { kind: "already-delivered", commit, by } };
    }
    return { title: goal.title, close: { kind: "unrecorded-kind", commit } };
  });
}

/** The check tasks that wrote each goal task's latest stored checks, with their task specs. */
async function checkAuthors(db: DbHandle, goalIds: readonly string[]): Promise<Array<{ readonly id: string; readonly taskSpec: unknown }>> {
  return db
    .select({ id: workItems.id, taskSpec: workItems.taskSpec })
    .from(workItems)
    .where(
      inArray(
        workItems.id,
        db
          .select({ id: taskChecks.checkTaskId })
          .from(taskChecks)
          .where(
            and(
              inArray(taskChecks.taskId, [...goalIds]),
              sql`${taskChecks.revision} = (SELECT max(latest.revision) FROM task_checks latest WHERE latest.task_id = ${taskChecks.taskId})`,
            ),
          ),
      ),
    );
}

/**
 * Every item of the vision as the plan's latest completed review recorded it (every item of the
 * vision its revision was decomposed from), each checked exactly when an acceptance line of the
 * check task of a goal task's latest stored checks (the sets the sweep ran) cites it (W11c D3). A
 * stored check is not recorded against one line, so the trace reaches the check task's lines, not
 * one check. Unrecorded when the review, or one of those check tasks, holds no traced items.
 */
async function visionCoverage(db: DbHandle, projectId: string, goalIds: readonly string[]): Promise<VisionCoverage> {
  const [review] = await db
    .select({ taskSpec: workItems.taskSpec })
    .from(workItems)
    .where(
      and(
        eq(workItems.projectId, projectId),
        eq(workItems.status, "Completed"),
        sql`${workItems.taskSpec}->>'origin' = 'review'`,
      ),
    )
    .orderBy(desc(workItems.createdAt), desc(workItems.id))
    .limit(1);
  const items = review ? parseStoredTaskSpec(review.taskSpec)?.sources : undefined;
  if (items === undefined) return { kind: "unrecorded" };
  const cited = new Set<string>();
  for (const author of goalIds.length === 0 ? [] : await checkAuthors(db, goalIds)) {
    const lines = citedBy(author.id, author.taskSpec);
    if (lines === null) return { kind: "unrecorded" };
    for (const identity of lines) cited.add(identity);
  }
  return { kind: "recorded", items: items.map((source) => ({ source, checked: cited.has(sourceIdentity(source)) })) };
}

/** A passed sweep with no main commit, which acceptance_sweeps_pass_has_main forbids. */
class AcceptedSweepWithoutMain extends Error {
  constructor(readonly sweepId: string) {
    super(`acceptance sweep ${sweepId} passed but records no main commit (acceptance_sweeps_pass_has_main should forbid it)`);
    this.name = "AcceptedSweepWithoutMain";
  }
}

/**
 * Every passed sweep whose delivered report is not yet posted, oldest first, with what the report
 * is rendered from. A project the client stopped, or has a stop awaiting the Liaison, is not
 * reported on: its stop report is what it is told.
 */
export async function listDueDeliveredReports(db: DbHandle): Promise<DueDeliveredReportRow[]> {
  const rows = await db
    .select({
      id: acceptanceSweeps.id,
      projectId: acceptanceSweeps.projectId,
      mainCommit: acceptanceSweeps.mainCommit,
      checkedTasks: acceptanceSweeps.checkedTasks,
      uncheckedTasks: acceptanceSweeps.uncheckedTasks,
    })
    .from(acceptanceSweeps)
    .innerJoin(projects, eq(projects.id, acceptanceSweeps.projectId))
    .where(and(eq(acceptanceSweeps.passed, true), isNull(acceptanceSweeps.reportId), eq(projects.status, "accepted"), noOpenStop(projects.id)))
    .orderBy(asc(acceptanceSweeps.createdAt), asc(acceptanceSweeps.id));
  const due: DueDeliveredReportRow[] = [];
  for (const row of rows) {
    const goals = await goalCloses(db, row.projectId);
    const goalIds = (await completedGoalTasks(db, row.projectId)).map((goal) => goal.id);
    // A passed sweep always ran on main (acceptance_sweeps_pass_has_main).
    if (row.mainCommit === null) throw new AcceptedSweepWithoutMain(row.id);
    due.push({
      sweepId: row.id,
      projectId: parseProjectId(row.projectId, "acceptance_sweeps.project_id"),
      mainCommit: row.mainCommit,
      goals,
      checked: await sweepTaskTitles(db, row.id, "checked_tasks", row.checkedTasks),
      unchecked: await sweepTaskTitles(db, row.id, "unchecked_tasks", row.uncheckedTasks),
      givenUp: await givenUpGoalTitles(db, row.projectId),
      vision: await visionCoverage(db, row.projectId, goalIds),
    });
  }
  return due;
}

/** A delivered report was asked to be posted for a sweep that does not exist or did not pass. */
class AcceptedSweepNotFound extends Error {
  constructor(readonly sweepId: string) {
    super(`cannot post the delivered report on acceptance sweep ${sweepId}: no passed acceptance_sweeps row has that id`);
    this.name = "AcceptedSweepNotFound";
  }
}

/** Posts the delivered report and records it on the sweep, in one transaction; once per sweep. */
export async function postDeliveredReport(db: Database, sweepId: string, body: string): Promise<"posted" | "already-posted"> {
  return db.transaction(async (tx) => {
    const [sweep] = await tx
      .select({ projectId: acceptanceSweeps.projectId, reportId: acceptanceSweeps.reportId })
      .from(acceptanceSweeps)
      .where(and(eq(acceptanceSweeps.id, sweepId), eq(acceptanceSweeps.passed, true)))
      .for("update");
    if (!sweep) throw new AcceptedSweepNotFound(sweepId);
    if (sweep.reportId !== null) return "already-posted";
    const [message] = await tx
      .insert(clientMessages)
      .values({ projectId: sweep.projectId, direction: "outbound", kind: "report", body, inReplyTo: null })
      .returning({ id: clientMessages.id });
    await tx.update(acceptanceSweeps).set({ reportId: message.id }).where(eq(acceptanceSweeps.id, sweepId));
    return "posted";
  });
}
