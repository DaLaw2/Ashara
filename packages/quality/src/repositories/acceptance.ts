import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { projects, qualifiedColumn } from "@ashara/db";
import { acceptanceSweepFaults, acceptanceSweeps, guaranteeEvidence, taskChecks, terminalSweepFaults, undecidedItems } from "@ashara/db/schema/quality";
import type { Database, DbHandle, DbTransaction } from "@ashara/db";
import { parseProjectId, type ProjectId } from "@ashara/shared";
import { completedGoalTaskExists, completedGoalTasks, completedScaffolds, firstPlanned, haltEpisodesWhere, noTaskOpen, pendingCorrection, pendingRepair } from "../acl/delivery-acl.js";
import { haltReported, noOpenAnswer, noOpenStop, projectActive, projectAtWork, reportTold, stopsThatStopped, type AcceptProject } from "../acl/engagement-acl.js";
import { coverageOf, judgeGuarantees } from "../guarantee-verdict.js";
import type { Coverage, Evidence, JudgedGuarantee } from "../guarantee-verdict.js";
import type { FailedCheck, SweptCheck } from "../verification/acceptance-sweep.js";
import { recordFailedSweepOutcomes } from "./reviewer-outcome.js";

// A delivered project is accepted on one sweep of main HEAD. A project is ready for it once its first plan exists,
// no task of it is open (any status Delivery does not name settled), at least one goal task is Completed,
// no repair or revision is awaited, and no stop or answer awaits the Liaison. A project is accepted
// only when its sweep passed and it covers the contract in force: every guarantee the contract does
// not mark not verifiable by Ashara judged pass on the evidence that sweep recorded (coverageOf). The
// sweep is recorded with the project's move to 'accepted' in one transaction, the project row locked
// and readiness read again; a passed sweep that leaves such a guarantee unjudged records nothing and
// names each such guarantee, and the project is not accepted. A failed sweep is recorded with the
// defect item it opens. Engagement's delivered report
// is due while a passed sweep has none on Engagement's told record, and reads what the sweep
// recorded only through readSweepOutcome. A project
// stopped or halted short of acceptance gets one terminal sweep per stop or halt episode. Every
// sweep is recorded with the outcome of each stored check it ran and one evidence row per guarantee
// in force, together.

/** Every condition of readiness, on the projects row in scope. */
const readyForAcceptance = sql`(${projectAtWork()}
  AND ${firstPlanned(projects.id)}
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
 * The guarantees of the project's vision version in force, in its order, as Engagement's vision
 * reader reads them (the composition root supplies the reader); none when the project has no vision yet.
 */
type GuaranteesInForce =
  | { readonly kind: "none" }
  | { readonly kind: "version"; readonly version: number; readonly guarantees: readonly JudgedGuarantee[] };

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

/** A swept check with the task_checks row it ran, and the check task that row records wrote it. */
type StoredSweptCheck = SweptCheck & { readonly taskCheckId: string; readonly writtenBy: string };

/** Each swept check with the task_checks row it ran, in the order swept. */
async function storedRowsOf(tx: DbHandle, projectId: ProjectId, swept: readonly SweptCheck[]): Promise<StoredSweptCheck[]> {
  const taskIds = [...new Set(swept.map((check) => check.taskId))];
  const rows =
    taskIds.length === 0
      ? []
      : await tx
          .select({ id: taskChecks.id, taskId: taskChecks.taskId, revision: taskChecks.revision, name: taskChecks.name, checkTaskId: taskChecks.checkTaskId })
          .from(taskChecks)
          .where(inArray(taskChecks.taskId, taskIds));
  const key = (check: { readonly taskId: string; readonly revision: number; readonly name: string }): string => JSON.stringify([check.taskId, check.revision, check.name]);
  const stored = new Map(rows.map((row) => [key(row), row]));
  return swept.map((check) => {
    const row = stored.get(key(check));
    if (row === undefined) throw new SweptCheckUnrecorded(projectId, check);
    return { ...check, taskCheckId: row.id, writtenBy: row.checkTaskId };
  });
}

/** The columns of an acceptance_sweeps row as inserted. */
type SweepRow = typeof acceptanceSweeps.$inferInsert;

/** What a sweep is recorded with: each swept check with its stored row, and each guarantee in force with its evidence. */
interface SweepEvidenceRecord {
  readonly swept: readonly StoredSweptCheck[];
  readonly guarantees: GuaranteesInForce;
  readonly byGuarantee: ReadonlyMap<string, Evidence>;
}

/** A cited item of one check task, as a key: a review's finding on an item speaks of that check task's checks alone. */
function itemOfCheckTask(checkTaskId: string, itemId: string): string {
  return JSON.stringify([checkTaskId, itemId]);
}

/**
 * The evidence of every guarantee in force on the sweep: every stored check deciding it with its
 * outcome and class, an empty list when none does. A check is lowered when a suite review left the
 * guarantee undecided on the check task its stored row records wrote it, and no later review of that
 * check task cleared it; a finding on one check task never lowers another's checks.
 */
async function sweepEvidenceOf(tx: DbHandle, sweep: AcceptanceSweepRecord, readGuarantees: ReadGuarantees): Promise<SweepEvidenceRecord> {
  const swept = await storedRowsOf(tx, sweep.projectId, sweep.checkOutcomes);
  const guarantees = await readGuarantees(tx, sweep.projectId);
  const ids = guarantees.kind === "none" ? [] : guarantees.guarantees.map((guarantee) => guarantee.id);
  if (ids.length === 0) return { swept, guarantees, byGuarantee: new Map() };
  const standing = await tx
    .select({ checkTaskId: undecidedItems.checkTaskId, itemId: undecidedItems.itemId })
    .from(undecidedItems)
    .where(and(eq(undecidedItems.projectId, sweep.projectId), inArray(undecidedItems.itemId, ids), isNull(undecidedItems.clearedByClaimId)));
  const lowered = new Set(standing.map((row) => itemOfCheckTask(row.checkTaskId, row.itemId)));
  const byGuarantee = new Map(
    ids.map((guaranteeId): [string, Evidence] => [
      guaranteeId,
      {
        checks: swept
          .filter((check) => check.decides?.includes(guaranteeId) === true)
          .map((check) => ({
            checkId: check.taskCheckId,
            outcome: check.outcome,
            class: STORED_CHECK_CLASS,
            lowered: lowered.has(itemOfCheckTask(check.writtenBy, guaranteeId)),
          })),
      },
    ]),
  );
  return { swept, guarantees, byGuarantee };
}

/**
 * Whether a passed sweep on `mainCommit` covers the contract in force: Quality's verdict on every
 * guarantee, judged on the evidence the sweep records, is a pass.
 */
function coverageOfSweep(evidence: SweepEvidenceRecord, projectId: ProjectId, mainCommit: string): Coverage {
  const { guarantees } = evidence;
  if (guarantees.kind === "none") return coverageOf(null, []);
  const verdicts = judgeGuarantees(guarantees.guarantees, guarantees.version, { id: `of project ${projectId} on ${mainCommit}`, mainCommit }, { kind: "recorded", byGuarantee: evidence.byGuarantee });
  return coverageOf(guarantees.version, verdicts);
}

/**
 * Inserts the sweep's row with the outcome of every stored check it ran, then one evidence row per
 * guarantee in force. Returns the sweep's id, or null when `row` conflicted with a sweep already
 * recorded (a terminal one, by its stop or halt episode).
 */
async function insertSweepWithEvidence(
  tx: DbHandle,
  sweep: AcceptanceSweepRecord,
  row: Omit<SweepRow, "checkOutcomes" | "projectId" | "mainCommit" | "environmentVersion" | "checkedTasks" | "uncheckedTasks" | "details">,
  evidence: SweepEvidenceRecord,
): Promise<string | null> {
  const insert = tx.insert(acceptanceSweeps).values({
    ...row,
    projectId: sweep.projectId,
    mainCommit: sweep.mainCommit,
    environmentVersion: sweep.environmentVersion,
    checkedTasks: [...sweep.checkedTasks],
    uncheckedTasks: [...sweep.uncheckedTasks],
    details: sweep.details,
    checkOutcomes: evidence.swept.map((check) => ({ taskCheckId: check.taskCheckId, taskId: check.taskId, name: check.name, command: check.command, outcome: check.outcome })),
  });
  // Only a terminal sweep may meet one already recorded (its stop or halt episode's); any other conflict is a fault.
  const [recorded] =
    row.purpose === "terminal" ? await insert.onConflictDoNothing().returning({ id: acceptanceSweeps.id }) : await insert.returning({ id: acceptanceSweeps.id });
  if (recorded === undefined) {
    if (row.purpose === "terminal") return null;
    throw new AcceptanceSweepUnrecorded(sweep.projectId);
  }
  const { guarantees } = evidence;
  if (guarantees.kind === "none" || guarantees.guarantees.length === 0) return recorded.id;
  await tx.insert(guaranteeEvidence).values(
    guarantees.guarantees.map(({ id: guaranteeId }) => {
      const seen = evidence.byGuarantee.get(guaranteeId);
      if (seen === undefined) throw new GuaranteeEvidenceUnbuilt(sweep.projectId, guaranteeId);
      return {
        projectId: sweep.projectId,
        sweepId: recorded.id,
        visionVersion: guarantees.version,
        guaranteeId,
        mainCommit: sweep.mainCommit,
        checks: seen.checks.map((check) => ({ taskCheckId: check.checkId, outcome: check.outcome, class: check.class, lowered: check.lowered })),
      };
    }),
  );
  return recorded.id;
}

/** A guarantee in force has no evidence built for it: the sweep's evidence and the guarantees it was built for are out of step. */
class GuaranteeEvidenceUnbuilt extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly guaranteeId: string,
  ) {
    super(`cannot record the sweep of project ${projectId}: no evidence was built for guarantee ${guaranteeId}, which is in force`);
    this.name = "GuaranteeEvidenceUnbuilt";
  }
}

/** recordSweepFault named a project with no row. */
class AcceptanceFaultProjectMissing extends Error {
  constructor(readonly projectId: ProjectId) {
    super(`cannot count an acceptance sweep fault on project ${projectId}: no projects row has that id, or the count returned no row`);
    this.name = "AcceptanceFaultProjectMissing";
  }
}

/**
 * Counts one acceptance sweep that could not run on the project (acceptance_sweep_faults),
 * durably, and returns the count with it: the bound outlives a restart.
 */
export async function recordAcceptanceSweepFault(db: DbHandle, projectId: ProjectId): Promise<number> {
  return db.transaction(async (tx) => {
    const [locked] = await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).for("update");
    if (!locked) throw new AcceptanceFaultProjectMissing(projectId);
    const [row] = await tx
      .insert(acceptanceSweepFaults)
      .values({ projectId, faults: 1 })
      .onConflictDoUpdate({ target: acceptanceSweepFaults.projectId, set: { faults: sql`${qualifiedColumn(acceptanceSweepFaults.faults)} + 1` } })
      .returning({ faults: acceptanceSweepFaults.faults });
    if (!row) throw new AcceptanceFaultProjectMissing(projectId);
    return row.faults;
  });
}

/** Locks the project row and reads readiness again; false when the project moved since it was listed. */
async function lockReady(tx: DbHandle, projectId: ProjectId): Promise<boolean> {
  await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).for("update");
  const [ready] = await tx.select({ id: projects.id }).from(projects).where(and(eq(projects.id, projectId), readyForAcceptance));
  return ready !== undefined;
}

/**
 * Why a passed sweep did not accept its project: it does not cover the contract in force, every
 * guarantee of which that Ashara can verify must be judged pass (Coverage, short of covered).
 */
export type AcceptanceUncovered = { readonly kind: "uncovered"; readonly coverage: Exclude<Coverage, { readonly kind: "covered" }> };

/**
 * A sweep that passed: when it covers the contract in force (every guarantee in force, read by
 * `readGuarantees`, that the contract does not mark not verifiable by Ashara judged pass on the
 * evidence it records), recorded with the outcome of every stored check it ran and that evidence, and
 * the project moved to 'accepted' by `accept` (Engagement's lifecycle guard; the composition root
 * supplies both), in one transaction. "moved" when the project is no longer ready; the uncovered
 * outcome, naming each guarantee not judged pass, when the sweep does not cover the contract: the
 * project is not accepted. Either way nothing is written.
 *
 * This is the one writer of a passed acceptance sweep, and it writes one only on coverage, in the
 * transaction that moves the project. The projects_acceptance_guard trigger refuses 'accepted' without
 * a passed sweep, so the database holds coverage through this writer: judging coverage again in SQL
 * would put a second verdict computation outside Quality's verdictOf.
 */
export async function recordAcceptance(
  db: Database,
  sweep: AcceptanceSweepRecord & { readonly mainCommit: string },
  accept: AcceptProject,
  readGuarantees: ReadGuarantees,
): Promise<"accepted" | "moved" | AcceptanceUncovered> {
  return db.transaction(async (tx) => {
    if (!(await lockReady(tx, sweep.projectId))) return "moved";
    const evidence = await sweepEvidenceOf(tx, sweep, readGuarantees);
    const coverage = coverageOfSweep(evidence, sweep.projectId, sweep.mainCommit);
    if (coverage.kind !== "covered") return { kind: "uncovered", coverage };
    await insertSweepWithEvidence(tx, sweep, { purpose: "acceptance", passed: true }, evidence);
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
    const sweepId = await insertSweepWithEvidence(tx, sweep, { purpose: "acceptance", passed: false, defectItemId }, await sweepEvidenceOf(tx, sweep, readGuarantees));
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
 * stopped, then each halt episode open on an active project, or ended by a resumption before either
 * its halt or its resumption was told, of a project not stopped. A second stop of a project already
 * stopped stopped nothing, so it is owed none. The stop's and the halt's report wait for this sweep:
 * each is told only once the sweep, or the fault that exhausted its retries, is on record. The
 * terminals and their projects are read in one snapshot: a project deleted between two separate
 * reads would leave a terminal naming a project no row holds.
 */
export async function listDueTerminalSweeps(db: Database): Promise<DueTerminalSweepRow[]> {
  return db.transaction((tx) => dueTerminalSweepsIn(tx), { isolationLevel: "repeatable read", accessMode: "read only" });
}

async function dueTerminalSweepsIn(db: DbTransaction): Promise<DueTerminalSweepRow[]> {
  const stopped = await stopsThatStopped(db, (stop) => sql`NOT EXISTS (SELECT 1 FROM acceptance_sweeps s WHERE s.stop_id = ${stop.id})`);
  const open = await haltEpisodesWhere(
    db,
    (episode) => sql`(NOT EXISTS (SELECT 1 FROM acceptance_sweeps s WHERE s.block_id = ${episode.id})
      AND ((${episode.open} AND EXISTS (SELECT 1 FROM projects WHERE projects.id = ${episode.projectId} AND ${projectActive()}))
        OR (${episode.resumed} AND NOT ${haltReported(episode.id)} AND NOT ${reportTold("project-resumed", episode.id)}
          AND EXISTS (SELECT 1 FROM projects WHERE projects.id = ${episode.projectId} AND projects.lifecycle <> 'stopped'))))`,
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

/** recordTerminalSweepFault named a project with no row, or the count returned no row. */
class TerminalSweepFaultUncounted extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly terminal: Terminal,
  ) {
    super(
      `cannot count a terminal sweep fault of ${terminal.kind === "stop" ? `stop ${terminal.stopId}` : `halt ${terminal.blockId}`} on project ${projectId}: ` +
        "no projects row has that id, or the count returned no row",
    );
    this.name = "TerminalSweepFaultUncounted";
  }
}

/**
 * Counts one terminal sweep of `terminal` that could not run (terminal_sweep_faults), durably, and
 * returns the count with it: the bound on its retries outlives a restart.
 */
export async function recordTerminalSweepFault(db: DbHandle, projectId: ProjectId, terminal: Terminal): Promise<number> {
  const of = terminal.kind === "stop" ? { stopId: terminal.stopId } : { blockId: terminal.blockId };
  const target = terminal.kind === "stop" ? terminalSweepFaults.stopId : terminalSweepFaults.blockId;
  const [row] = await db
    .insert(terminalSweepFaults)
    .values({ projectId, ...of, faults: 1 })
    .onConflictDoUpdate({ target, set: { faults: sql`${qualifiedColumn(terminalSweepFaults.faults)} + 1` } })
    .returning({ faults: terminalSweepFaults.faults });
  if (!row) throw new TerminalSweepFaultUncounted(projectId, terminal);
  return row.faults;
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
    const sweepId = await insertSweepWithEvidence(tx, sweep, { purpose: "terminal", passed: false, ...of }, await sweepEvidenceOf(tx, sweep, readGuarantees));
    return sweepId === null ? "already-recorded" : "recorded";
  });
}

/**
 * A terminal sweep whose evidence could not be built (the guarantees in force, or the stored checks,
 * did not read): recorded with no check run and no guarantee evidence, so its terminal's report is
 * told on what its records hold. "already-recorded" when its terminal has one; nothing is written.
 */
export async function recordTerminalSweepWithoutEvidence(
  db: DbHandle,
  sweep: Omit<AcceptanceSweepRecord, "checkOutcomes"> & { readonly terminal: Terminal },
): Promise<"recorded" | "already-recorded"> {
  const of = sweep.terminal.kind === "stop" ? { stopId: sweep.terminal.stopId } : { blockId: sweep.terminal.blockId };
  const sweepId = await insertSweepWithEvidence(
    db,
    { ...sweep, checkOutcomes: [] },
    { purpose: "terminal", passed: false, ...of },
    { swept: [], guarantees: { kind: "none" }, byGuarantee: new Map() },
  );
  return sweepId === null ? "already-recorded" : "recorded";
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
