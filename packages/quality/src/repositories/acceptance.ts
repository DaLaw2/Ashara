import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { acceptanceSweeps, guaranteeEvidence, projects, taskChecks, undecidedItems } from "@ashara/db";
import type { Database, DbHandle, DbTransaction } from "@ashara/db";
import { parseProjectId, type ProjectId } from "@ashara/shared";
import { completedGoalTaskExists, completedGoalTasks, completedScaffolds, noTaskOpen, openHaltEpisodesWhere, pendingCorrection, pendingRepair } from "../acl/delivery-acl.js";
import { noOpenAnswer, noOpenStop, projectActive, projectAtWork, stopsThatStopped, type AcceptProject } from "../acl/engagement-acl.js";
import type { FailedCheck, SweptCheck } from "../verification/acceptance-sweep.js";
import { recordFailedSweepOutcomes } from "./reviewer-outcome.js";

// A delivered project is accepted on one sweep of main HEAD. A project is ready for it once its first plan exists,
// no task of it is open (any status Delivery does not name settled), at least one goal task is Completed,
// no repair or revision is awaited, and no stop or answer awaits the Liaison. A passed sweep is
// recorded with the project's move to 'accepted' in one transaction, the project row locked and
// readiness read again; a failed one with the defect item it opens. Engagement's delivered report
// is due while a passed sweep has none on Engagement's told record, and reads what the sweep
// recorded only through readSweepOutcome. A project
// stopped or halted short of acceptance gets one terminal sweep per stop or halt episode. Every
// sweep is recorded with the outcome of each stored check it ran and one evidence row per guarantee
// in force, together.

/** Every condition of readiness, on the projects row in scope. */
const readyForAcceptance = sql`(${projectAtWork()}
  AND ${projects.firstPlannedAt} IS NOT NULL
  AND NOT ${pendingCorrection(projects.id)}
  AND NOT ${pendingRepair(projects.id)}
  AND ${noOpenStop(projects.id)}
  AND ${noOpenAnswer()}
  AND ${noTaskOpen(projects.id)}
  AND ${completedGoalTaskExists(projects.id)})`;

/** A Completed product scaffold with the merge its completion recorded; null when none is on record. */
interface RecordedScaffold {
  readonly taskId: string;
  readonly mergeCommit: string | null;
}

interface ReadyProjectRow {
  readonly projectId: ProjectId;
  /** null when no workspace was ever minted: nothing can be swept, and the caller says so. */
  readonly workspacePath: string | null;
  /** The project's Completed goal tasks (isGoalTask), oldest completion first. */
  readonly goalTaskIds: readonly string[];
  /** The project's Completed product scaffolds with their recorded merges, oldest completion first. */
  readonly scaffoldMerges: readonly RecordedScaffold[];
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
      scaffoldMerges: await completedScaffolds(db, row.id),
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
  /** Every stored check the sweep could run, with how it ended; none when it ran on no commit. */
  readonly checkOutcomes: readonly SweptCheck[];
  readonly details: string;
}

/**
 * The guarantees of the project's vision version in force, by key, as Engagement's vision reader
 * reads them (the composition root supplies the reader); none when the project has no vision yet.
 */
type GuaranteesInForce =
  | { readonly kind: "none" }
  | { readonly kind: "version"; readonly version: number; readonly guaranteeIds: readonly string[] };

/** Reads the guarantees in force inside the transaction a sweep is recorded in. */
type ReadGuarantees = (tx: DbHandle, projectId: ProjectId) => Promise<GuaranteesInForce>;

/**
 * The evidence class of every stored check: each is stored before its task's first attempt and
 * shown in that task's brief, so its implementer could see it. A check written after the work by
 * someone else has no record that would set it apart yet.
 */
const STORED_CHECK_CLASS = "implementer-visible";

/** A swept check names a stored check revision that holds no row by its name: its outcome cannot be tied to a stored check. */
class SweptCheckUnrecorded extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly check: Pick<SweptCheck, "taskId" | "revision" | "name">,
  ) {
    super(
      `cannot record the sweep of project ${projectId}: task ${check.taskId}'s checks revision ${check.revision} holds no ` +
        `check named ${JSON.stringify(check.name)}, so its outcome cannot be tied to a stored check`,
    );
    this.name = "SweptCheckUnrecorded";
  }
}

/** A sweep's insert returned no row. */
class AcceptanceSweepUnrecorded extends Error {
  constructor(readonly projectId: ProjectId) {
    super(`the acceptance sweep of project ${projectId} returned no row from its insert`);
    this.name = "AcceptanceSweepUnrecorded";
  }
}

/** Each swept check with the task_checks row it ran, in the order swept. */
async function storedRowsOf(tx: DbHandle, projectId: ProjectId, swept: readonly SweptCheck[]): Promise<Array<SweptCheck & { readonly taskCheckId: string }>> {
  const taskIds = [...new Set(swept.map((check) => check.taskId))];
  const rows =
    taskIds.length === 0
      ? []
      : await tx
          .select({ id: taskChecks.id, taskId: taskChecks.taskId, revision: taskChecks.revision, name: taskChecks.name })
          .from(taskChecks)
          .where(inArray(taskChecks.taskId, taskIds));
  const key = (check: { readonly taskId: string; readonly revision: number; readonly name: string }): string => JSON.stringify([check.taskId, check.revision, check.name]);
  const ids = new Map(rows.map((row) => [key(row), row.id]));
  return swept.map((check) => {
    const taskCheckId = ids.get(key(check));
    if (taskCheckId === undefined) throw new SweptCheckUnrecorded(projectId, check);
    return { ...check, taskCheckId };
  });
}

/** The columns of an acceptance_sweeps row as inserted. */
type SweepRow = typeof acceptanceSweeps.$inferInsert;

/**
 * Inserts the sweep's row with the outcome of every stored check it ran, then one evidence row per
 * guarantee in force: every stored check deciding it with its outcome and class, an empty list when
 * none does, and whether a review left it undecided. Returns the sweep's id, or null when `row`
 * conflicted with a sweep already recorded (a terminal one, by its stop or halt episode).
 */
async function insertSweepWithEvidence(
  tx: DbHandle,
  sweep: AcceptanceSweepRecord,
  row: Omit<SweepRow, "checkOutcomes" | "projectId" | "mainCommit" | "environmentVersion" | "checkedTasks" | "uncheckedTasks" | "details">,
  readGuarantees: ReadGuarantees,
): Promise<string | null> {
  const swept = await storedRowsOf(tx, sweep.projectId, sweep.checkOutcomes);
  const insert = tx.insert(acceptanceSweeps).values({
    ...row,
    projectId: sweep.projectId,
    mainCommit: sweep.mainCommit,
    environmentVersion: sweep.environmentVersion,
    checkedTasks: [...sweep.checkedTasks],
    uncheckedTasks: [...sweep.uncheckedTasks],
    details: sweep.details,
    checkOutcomes: swept.map((check) => ({ taskCheckId: check.taskCheckId, taskId: check.taskId, name: check.name, command: check.command, outcome: check.outcome })),
  });
  // Only a terminal sweep may meet one already recorded (its stop or halt episode's); any other conflict is a fault.
  const [recorded] =
    row.purpose === "terminal" ? await insert.onConflictDoNothing().returning({ id: acceptanceSweeps.id }) : await insert.returning({ id: acceptanceSweeps.id });
  if (recorded === undefined) {
    if (row.purpose === "terminal") return null;
    throw new AcceptanceSweepUnrecorded(sweep.projectId);
  }
  const guarantees = await readGuarantees(tx, sweep.projectId);
  if (guarantees.kind === "none" || guarantees.guaranteeIds.length === 0) return recorded.id;
  const undecided = await tx
    .selectDistinct({ itemId: undecidedItems.itemId })
    .from(undecidedItems)
    .where(and(eq(undecidedItems.projectId, sweep.projectId), inArray(undecidedItems.itemId, [...guarantees.guaranteeIds])));
  const lowered = new Set(undecided.map((item) => item.itemId));
  await tx.insert(guaranteeEvidence).values(
    guarantees.guaranteeIds.map((guaranteeId) => ({
      projectId: sweep.projectId,
      sweepId: recorded.id,
      visionVersion: guarantees.version,
      guaranteeId,
      mainCommit: sweep.mainCommit,
      checks: swept
        .filter((check) => check.decides?.includes(guaranteeId) === true)
        .map((check) => ({ taskCheckId: check.taskCheckId, outcome: check.outcome, class: STORED_CHECK_CLASS })),
      reviewLowers: lowered.has(guaranteeId),
    })),
  );
  return recorded.id;
}

/** recordSweepFault named a project with no row. */
class AcceptanceFaultProjectMissing extends Error {
  constructor(readonly projectId: ProjectId) {
    super(`cannot count an acceptance sweep fault on project ${projectId}: no projects row has that id`);
    this.name = "AcceptanceFaultProjectMissing";
  }
}

/**
 * Counts one acceptance sweep that could not run on the project (projects.acceptance_faults),
 * durably, and returns the count with it: the bound outlives a restart.
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
 * A sweep that passed: recorded with the outcome of every stored check it ran and the evidence of
 * every guarantee in force (`readGuarantees`), and the project moved to 'accepted' by `accept`
 * (Engagement's lifecycle guard; the composition root supplies both), in one transaction (the
 * projects_acceptance_guard trigger refuses the move without the row). "moved" when the project is
 * no longer ready; nothing is written.
 */
export async function recordAcceptance(
  db: Database,
  sweep: AcceptanceSweepRecord & { readonly mainCommit: string },
  accept: AcceptProject,
  readGuarantees: ReadGuarantees,
): Promise<"accepted" | "moved"> {
  return db.transaction(async (tx) => {
    if (!(await lockReady(tx, sweep.projectId))) return "moved";
    await insertSweepWithEvidence(tx, sweep, { purpose: "acceptance", passed: true }, readGuarantees);
    await accept(tx, sweep.projectId);
    return "accepted";
  });
}

/**
 * A sweep that failed: `writeDefect` writes the defect item in the transaction and gives it up (so
 * the abandonment trigger opens its repair) and returns its id; the sweep is recorded with it, with
 * the outcome of every stored check it ran and the evidence of every guarantee in force, and with
 * the reviewer outcomes its failed checks are evidence of, in one transaction.
 * "moved" when the project is no longer ready; nothing is written.
 */
export async function recordAcceptanceDefect(
  db: Database,
  sweep: AcceptanceSweepRecord & { readonly failedChecks: readonly FailedCheck[] },
  writeDefect: (tx: DbTransaction) => Promise<string>,
  readGuarantees: ReadGuarantees,
): Promise<"recorded" | "moved"> {
  return db.transaction(async (tx) => {
    if (!(await lockReady(tx, sweep.projectId))) return "moved";
    const defectItemId = await writeDefect(tx);
    const sweepId = await insertSweepWithEvidence(tx, sweep, { purpose: "acceptance", passed: false, defectItemId }, readGuarantees);
    if (sweepId === null) throw new AcceptanceSweepUnrecorded(sweep.projectId);
    await recordFailedSweepOutcomes(tx, { projectId: sweep.projectId, sweepId, failedCheckTasks: sweep.failedChecks.map((check) => check.checkTaskId) });
    return "recorded";
  });
}

/** A terminal's project has no projects row, which its foreign key forbids. */
class TerminalProjectMissing extends Error {
  constructor(readonly projectId: string) {
    super(`a terminal owed its sweep names project ${projectId}, which has no projects row`);
    this.name = "TerminalProjectMissing";
  }
}

/** Each project's target checkout (null when none was ever minted), looked up by project; a project with no row throws. */
async function workspacePaths(db: DbHandle, projectIds: readonly string[]): Promise<(projectId: string) => string | null> {
  const rows = projectIds.length === 0 ? [] : await db.select({ id: projects.id, workspacePath: projects.workspacePath }).from(projects).where(inArray(projects.id, [...new Set(projectIds)]));
  const paths = new Map(rows.map((row) => [row.id, row.workspacePath]));
  return (projectId) => {
    const path = paths.get(projectId);
    if (path === undefined) throw new TerminalProjectMissing(projectId);
    return path;
  };
}

/** What a terminal sweep is run for: the client's consumed stop, or a halt episode (project_blocks). */
type Terminal = { readonly kind: "stop"; readonly stopId: string } | { readonly kind: "halt"; readonly blockId: string };

/** A project at a terminal short of acceptance with no terminal sweep recorded for it yet. */
interface DueTerminalSweepRow {
  readonly projectId: ProjectId;
  /** null when no workspace was ever minted: main holds nothing of the project's to sweep. */
  readonly workspacePath: string | null;
  readonly terminal: Terminal;
}

/**
 * Every terminal owed its one terminal sweep, oldest first: each stop that stopped a project still
 * stopped, then each open halt episode of an active project. A second stop of a project already
 * stopped stopped nothing, so it is owed none. The stop's report is posted after the cycle's terminal
 * sweeps, so it carries this sweep when it is recorded, and is still posted, with no sweep, when it is not.
 */
export async function listDueTerminalSweeps(db: DbHandle): Promise<DueTerminalSweepRow[]> {
  const stopped = await stopsThatStopped(db, (stop) => sql`NOT EXISTS (SELECT 1 FROM acceptance_sweeps s WHERE s.stop_id = ${stop.id})`);
  const open = await openHaltEpisodesWhere(
    db,
    (episode) => sql`(EXISTS (SELECT 1 FROM projects WHERE projects.id = ${episode.projectId} AND ${projectActive()})
      AND NOT EXISTS (SELECT 1 FROM acceptance_sweeps s WHERE s.block_id = ${episode.id}))`,
  );
  const workspaceOf = await workspacePaths(db, [...stopped.map((stop) => stop.projectId), ...open.map((episode) => episode.projectId)]);
  const stops = stopped.map((stop) => ({ projectId: stop.projectId, workspacePath: workspaceOf(stop.projectId), stopId: stop.stopId }));
  const halts = open.map((episode) => ({ projectId: episode.projectId, workspacePath: workspaceOf(episode.projectId), blockId: episode.id }));
  return [
    ...stops.map((row) => ({
      projectId: parseProjectId(row.projectId, "projects.id"),
      workspacePath: row.workspacePath,
      terminal: { kind: "stop" as const, stopId: row.stopId },
    })),
    ...halts.map((row) => ({
      projectId: parseProjectId(row.projectId, "projects.id"),
      workspacePath: row.workspacePath,
      terminal: { kind: "halt" as const, blockId: row.blockId },
    })),
  ];
}

/**
 * A terminal sweep: recorded once per stop or halt episode with the outcome of every stored check it
 * ran and the evidence of every guarantee in force (`readGuarantees`), in one transaction. It is
 * never passed and opens nothing. "already-recorded" when its terminal has one; nothing is written.
 */
export async function recordTerminalSweep(
  db: Database,
  sweep: AcceptanceSweepRecord & { readonly terminal: Terminal },
  readGuarantees: ReadGuarantees,
): Promise<"recorded" | "already-recorded"> {
  return db.transaction(async (tx) => {
    const of = sweep.terminal.kind === "stop" ? { stopId: sweep.terminal.stopId } : { blockId: sweep.terminal.blockId };
    const sweepId = await insertSweepWithEvidence(tx, sweep, { purpose: "terminal", passed: false, ...of }, readGuarantees);
    return sweepId === null ? "already-recorded" : "recorded";
  });
}

/**
 * The verdict of the project's most recent acceptance sweep, by when it was recorded, and the commit it ran on;
 * undefined when it has none. A terminal sweep judges no acceptance and is never it.
 */
export async function latestAcceptanceSweepOf(
  db: DbHandle,
  projectId: ProjectId,
): Promise<{ readonly passed: boolean; readonly mainCommit: string | null; readonly createdAt: Date } | undefined> {
  const [row] = await db
    .select({ passed: acceptanceSweeps.passed, mainCommit: acceptanceSweeps.mainCommit, createdAt: acceptanceSweeps.createdAt })
    .from(acceptanceSweeps)
    .where(and(eq(acceptanceSweeps.projectId, projectId), eq(acceptanceSweeps.purpose, "acceptance")))
    .orderBy(desc(acceptanceSweeps.createdAt), desc(acceptanceSweeps.id))
    .limit(1);
  return row;
}

/** How one stored check an acceptance sweep ran ended (acceptance_sweeps.check_outcomes). */
const CHECK_OUTCOMES = ["passed", "failed", "not-run"] as const;

const SweepTaskIdsSchema = z.array(z.guid());

/** acceptance_sweeps.check_outcomes as insertSweepWithEvidence writes it; null on a row recorded before the column existed. */
const StoredCheckOutcomesSchema = z
  .array(z.object({ taskId: z.guid(), name: z.string().min(1), command: z.string().min(1), outcome: z.enum(CHECK_OUTCOMES) }))
  .nullable();

/** One stored check a sweep ran: its task, its name, the command it ran and how it ended. */
interface SweepCheckOutcome {
  readonly taskId: string;
  readonly name: string;
  readonly command: string;
  readonly outcome: (typeof CHECK_OUTCOMES)[number];
}

/**
 * What a sweep recorded of the work it swept, as Quality publishes it: the completed tasks whose
 * stored checks it ran and those with none, and every stored check it ran with its outcome; the
 * checks are unrecorded on a sweep recorded before their outcomes were.
 */
interface SweepOutcome {
  readonly checkedTasks: readonly string[];
  readonly uncheckedTasks: readonly string[];
  readonly checks: { readonly kind: "unrecorded" } | { readonly kind: "recorded"; readonly checks: readonly SweepCheckOutcome[] };
}

/** A sweep's stored outcome does not read: the column named holds something its writer never writes. */
class SweepOutcomeUnreadable extends Error {
  constructor(
    readonly sweepId: string,
    readonly column: "checked_tasks" | "unchecked_tasks" | "check_outcomes" | "row",
    readonly detail: string,
  ) {
    super(`acceptance sweep ${sweepId}: ${column} does not read as its sweep outcome: ${detail}`);
    this.name = "SweepOutcomeUnreadable";
  }
}

function parsedColumn<T>(sweepId: string, column: "checked_tasks" | "unchecked_tasks" | "check_outcomes", schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new SweepOutcomeUnreadable(sweepId, column, z.prettifyError(parsed.error));
  return parsed.data;
}

/** The outcome the sweep `sweepId` recorded; one that does not read throws SweepOutcomeUnreadable, never reads as empty. */
export async function readSweepOutcome(db: DbHandle, sweepId: string): Promise<SweepOutcome> {
  const [row] = await db
    .select({ checkedTasks: acceptanceSweeps.checkedTasks, uncheckedTasks: acceptanceSweeps.uncheckedTasks, checkOutcomes: acceptanceSweeps.checkOutcomes })
    .from(acceptanceSweeps)
    .where(eq(acceptanceSweeps.id, sweepId));
  if (row === undefined) throw new SweepOutcomeUnreadable(sweepId, "row", "no acceptance_sweeps row has that id");
  const checks = parsedColumn(sweepId, "check_outcomes", StoredCheckOutcomesSchema, row.checkOutcomes);
  return {
    checkedTasks: parsedColumn(sweepId, "checked_tasks", SweepTaskIdsSchema, row.checkedTasks),
    uncheckedTasks: parsedColumn(sweepId, "unchecked_tasks", SweepTaskIdsSchema, row.uncheckedTasks),
    checks:
      checks === null
        ? { kind: "unrecorded" }
        : { kind: "recorded", checks: checks.map((check) => ({ taskId: check.taskId, name: check.name, command: check.command, outcome: check.outcome })) },
  };
}
