import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { acceptanceSweeps, clientMessages, insertedRow, intakeReadings, isDatabaseConnectionFault, projects, workItems } from "@ashara/db";
import type { Database, DbHandle } from "@ashara/db";
import { SECOND_OPINION_STRENGTHS } from "@ashara/finance";
import { parseProjectId, type ProjectId } from "@ashara/shared";
import { completedGoalTasks, givenUpItem, goalTaskSql } from "@ashara/delivery/predicates";
import { noOpenStop } from "../predicates.js";
import type { DeliveredReportFailureRecord, ReadingTold } from "../delivered-report.js";
import type { GuaranteeTable, TableVerdicts } from "../guarantee-report.js";
import { insertGuaranteeVerdicts, readGuaranteeTable } from "./guarantee-report.js";

// The Liaison's delivered report: due while a
// passed acceptance sweep has none, rendered only from what is recorded: how each goal task closed,
// which tasks' checks the sweep ran and the commands of those that passed, the tasks given up, and
// the guarantee table judged from the sweep's evidence, whose verdicts are posted with the report.

/** How a goal task's recorded commit closed it. */
type GoalClose =
  | { readonly kind: "merged"; readonly commit: string }
  /** `by` is the task whose merge made that commit, null when no task records it as its merge. */
  | { readonly kind: "already-delivered"; readonly commit: string; readonly by: string | null }
  /** A commit is recorded, but not how it closed the task (a record from before merge kinds were recorded). */
  | { readonly kind: "unrecorded-kind"; readonly commit: string }
  /** Completed with no commit recorded at all. */
  | { readonly kind: "no-record" };

interface DueDeliveredReportRow {
  readonly kind: "due";
  /** Failed attempts at the report so far. */
  readonly failures: number;
  /** Failed reads of the public interface file so far. */
  readonly interfaceReadFailures: number;
  /** Failed attempts whose records did not make a report so far. */
  readonly recordFailures: number;
  readonly sweepId: string;
  readonly projectId: ProjectId;
  readonly mainCommit: string;
  /** The project's target checkout (projects.workspace_path). */
  readonly targetProjectPath: string;
  readonly goals: ReadonlyArray<{ readonly title: string; readonly close: GoalClose }>;
  /** The titles of the completed tasks whose stored checks the sweep ran. */
  readonly checked: readonly string[];
  /** The titles of the completed tasks with no stored check: nothing of theirs ran in the sweep. */
  readonly unchecked: readonly string[];
  /** The titles of goal tasks given up (Abandoned), which the plan was repaired around. */
  readonly givenUp: readonly string[];
  readonly executed: ExecutedChecks;
  readonly guarantees: GuaranteeTable;
  readonly reading: ReadingTold;
}

/** The stored checks the sweep ran and saw pass, by task title; unrecorded on a sweep from before check outcomes were recorded. */
type ExecutedChecks =
  | { readonly kind: "recorded"; readonly checks: ReadonlyArray<{ readonly task: string; readonly name: string; readonly command: string }> }
  | { readonly kind: "unrecorded" };

/**
 * A due report whose records could not be read; the rest of the due reports are still listed.
 * `cause` is "connection" when the database could not be reached (isDatabaseConnectionFault), and
 * "record" for every other failure: what was read does not make a report, by a defect of the records
 * or of Ashara's reading of them, which a retry meets again.
 */
interface UnreadDeliveredReportRow {
  readonly kind: "unread";
  readonly cause: "record" | "connection";
  readonly failures: number;
  readonly recordFailures: number;
  readonly sweepId: string;
  readonly projectId: ProjectId;
  readonly error: unknown;
}

/** What was read of a sweep's records does not hold together as its delivered report; a retry reads the same. */
abstract class ReportRecordUnreadable extends Error {}

const SweepTaskIdsSchema = z.array(z.guid());

/** A passed sweep's stored checked_tasks or unchecked_tasks is not a list of work item ids. */
class SweepTasksUnreadable extends ReportRecordUnreadable {
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
class SweepTaskMissing extends ReportRecordUnreadable {
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

/** acceptance_sweeps.check_outcomes: every stored check the sweep ran, with the command it ran and how it ended; null on a row written before it. */
const CheckOutcomesSchema = z
  .array(z.object({ taskId: z.guid(), name: z.string().min(1), command: z.string().min(1), outcome: z.enum(["passed", "failed", "not-run"]) }))
  .nullable();

/** A passed sweep's stored check_outcomes is neither null nor a list of check outcomes. */
class SweepCheckOutcomesUnreadable extends ReportRecordUnreadable {
  constructor(
    readonly sweepId: string,
    readonly detail: string,
  ) {
    super(`acceptance sweep ${sweepId}: check_outcomes is not a list of {taskId, name, command, outcome}: ${detail}`);
    this.name = "SweepCheckOutcomesUnreadable";
  }
}

/** The stored checks the sweep records it ran and saw pass, each with its task's title; unrecorded on a sweep from before check outcomes were recorded. */
async function passedChecksOf(db: DbHandle, sweepId: string, raw: unknown): Promise<ExecutedChecks> {
  const parsed = CheckOutcomesSchema.safeParse(raw);
  if (!parsed.success) throw new SweepCheckOutcomesUnreadable(sweepId, z.prettifyError(parsed.error));
  if (parsed.data === null) return { kind: "unrecorded" };
  const passed = parsed.data.filter((check) => check.outcome === "passed");
  const ids = [...new Set(passed.map((check) => check.taskId))];
  const rows = ids.length === 0 ? [] : await db.select({ id: workItems.id, title: workItems.title }).from(workItems).where(inArray(workItems.id, ids));
  const titles = new Map(rows.map((row) => [row.id, row.title]));
  return {
    kind: "recorded",
    checks: passed.map((check) => {
      const task = titles.get(check.taskId);
      if (task === undefined) throw new SweepTaskMissing(sweepId, check.taskId);
      return { task, name: check.name, command: check.command };
    }),
  };
}

/**
 * The project's goal tasks given up (Abandoned), oldest first: each is a task the plan was repaired
 * around. A task a plan revision replaced while it was open (blocked_reason source `superseded`) was
 * set aside, not given up, and is not one.
 */
async function givenUpGoalTitles(db: DbHandle, projectId: string): Promise<string[]> {
  const rows = await db
    .select({ title: workItems.title })
    .from(workItems)
    .where(
      and(
        eq(workItems.projectId, projectId),
        goalTaskSql,
        givenUpItem(workItems),
      ),
    )
    .orderBy(asc(workItems.updatedAt), asc(workItems.id));
  return rows.map((row) => row.title);
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

/** intake_readings as the report reads it; its CHECKs hold the second reading to its confirmation. */
const StoredStrengthSchema = z.enum(SECOND_OPINION_STRENGTHS);

const IntakeReadingRowSchema = z.discriminatedUnion("confirmation", [
  z.object({ confirmation: z.literal("not-needed") }),
  z.object({ confirmation: z.literal("confirmed"), secondStrength: StoredStrengthSchema }),
  z.object({ confirmation: z.literal("questions-raised"), secondStrength: StoredStrengthSchema, secondQuestions: z.number().int().min(1) }),
  z.object({ confirmation: z.literal("unconfirmed") }),
]);

/** A stored intake reading does not read as one. */
class IntakeReadingUnreadable extends ReportRecordUnreadable {
  constructor(
    readonly projectId: string,
    readonly detail: string,
  ) {
    super(`intake_readings row of project ${projectId} does not read as a reading of its tender: ${detail}`);
    this.name = "IntakeReadingUnreadable";
  }
}

/** How the project's tender was read; unrecorded for a project taken in before it. */
async function readingOf(db: DbHandle, projectId: string): Promise<ReadingTold> {
  const [row] = await db
    .select({ confirmation: intakeReadings.confirmation, secondStrength: intakeReadings.secondStrength, secondQuestions: intakeReadings.secondQuestions })
    .from(intakeReadings)
    .where(eq(intakeReadings.projectId, projectId));
  if (row === undefined) return { kind: "unrecorded" };
  const parsed = IntakeReadingRowSchema.safeParse(row);
  if (!parsed.success) throw new IntakeReadingUnreadable(projectId, z.prettifyError(parsed.error));
  const reading = parsed.data;
  switch (reading.confirmation) {
    case "confirmed":
      return { kind: "confirmed", strength: reading.secondStrength };
    case "questions-raised":
      return { kind: "questions-raised", strength: reading.secondStrength, questions: reading.secondQuestions };
    default:
      return { kind: reading.confirmation };
  }
}

/** A passed sweep with no main commit, which acceptance_sweeps_pass_has_main forbids. */
class AcceptedSweepWithoutMain extends ReportRecordUnreadable {
  constructor(readonly sweepId: string) {
    super(`acceptance sweep ${sweepId} passed but records no main commit (acceptance_sweeps_pass_has_main should forbid it)`);
    this.name = "AcceptedSweepWithoutMain";
  }
}

/** A passed sweep's project records no target checkout: main, where the product is, cannot be read. */
class AcceptedProjectWithoutWorkspace extends ReportRecordUnreadable {
  constructor(
    readonly sweepId: string,
    readonly projectId: string,
  ) {
    super(`acceptance sweep ${sweepId} passed, but project ${projectId} records no workspace_path: the product on main cannot be read for its delivered report`);
    this.name = "AcceptedProjectWithoutWorkspace";
  }
}

/** One passed sweep's row, as listDueDeliveredReports reads it. */
interface DueSweep {
  readonly id: string;
  readonly projectId: ProjectId;
  readonly mainCommit: string | null;
  readonly checkedTasks: unknown;
  readonly uncheckedTasks: unknown;
  readonly checkOutcomes: unknown;
  readonly workspacePath: string | null;
  readonly failures: number;
  readonly interfaceReadFailures: number;
  readonly recordFailures: number;
}

async function dueReportOf(db: DbHandle, row: DueSweep): Promise<DueDeliveredReportRow> {
  const goals = await goalCloses(db, row.projectId);
  // A passed sweep always ran on main (acceptance_sweeps_pass_has_main).
  if (row.mainCommit === null) throw new AcceptedSweepWithoutMain(row.id);
  if (row.workspacePath === null) throw new AcceptedProjectWithoutWorkspace(row.id, row.projectId);
  return {
    kind: "due",
    failures: row.failures,
    interfaceReadFailures: row.interfaceReadFailures,
    recordFailures: row.recordFailures,
    sweepId: row.id,
    projectId: row.projectId,
    mainCommit: row.mainCommit,
    targetProjectPath: row.workspacePath,
    goals,
    checked: await sweepTaskTitles(db, row.id, "checked_tasks", row.checkedTasks),
    unchecked: await sweepTaskTitles(db, row.id, "unchecked_tasks", row.uncheckedTasks),
    givenUp: await givenUpGoalTitles(db, row.projectId),
    executed: await passedChecksOf(db, row.id, row.checkOutcomes),
    guarantees: await readGuaranteeTable(db, { kind: "sweep", sweepId: row.id }),
    reading: await readingOf(db, row.projectId),
  };
}

/**
 * Every passed sweep whose delivered report is not yet posted and is not waiting out the backoff of
 * a failed attempt, oldest first, with what the report is rendered from. A sweep
 * whose records cannot be read is listed with why, so one project's records never stop another's
 * report. A project the client stopped, or has a stop awaiting the Liaison, is not reported on: its
 * stop report is what it is told.
 */
export async function listDueDeliveredReports(db: DbHandle): Promise<Array<DueDeliveredReportRow | UnreadDeliveredReportRow>> {
  const rows = await db
    .select({
      id: acceptanceSweeps.id,
      projectId: acceptanceSweeps.projectId,
      mainCommit: acceptanceSweeps.mainCommit,
      checkedTasks: acceptanceSweeps.checkedTasks,
      uncheckedTasks: acceptanceSweeps.uncheckedTasks,
      checkOutcomes: acceptanceSweeps.checkOutcomes,
      workspacePath: projects.workspacePath,
      failures: acceptanceSweeps.reportFailures,
      interfaceReadFailures: acceptanceSweeps.reportInterfaceReadFailures,
      recordFailures: acceptanceSweeps.reportRecordFailures,
    })
    .from(acceptanceSweeps)
    .innerJoin(projects, eq(projects.id, acceptanceSweeps.projectId))
    .where(
      and(
        eq(acceptanceSweeps.passed, true),
        isNull(acceptanceSweeps.reportId),
        eq(projects.lifecycle, "accepted"),
        noOpenStop(projects.id),
        or(isNull(acceptanceSweeps.reportRetryAt), lte(acceptanceSweeps.reportRetryAt, sql`now()`)),
      ),
    )
    .orderBy(asc(acceptanceSweeps.createdAt), asc(acceptanceSweeps.id));
  const due: Array<DueDeliveredReportRow | UnreadDeliveredReportRow> = [];
  for (const row of rows) {
    const projectId = parseProjectId(row.projectId, "acceptance_sweeps.project_id");
    try {
      due.push(await dueReportOf(db, { ...row, projectId }));
    } catch (error) {
      // Only a database that could not be reached says nothing of the records, and is retried
      // uncounted; every other failure counts toward the notice sent in the report's place, so one
      // nothing names is never retried unseen for good.
      // eslint-disable-next-line ashara/catch-continue -- best effort: the failure is kept as the row's unread entry with its cause, which counts toward the notice sent in the report's place
      const cause = isDatabaseConnectionFault(error) ? "connection" : "record";
      due.push({ kind: "unread", cause, failures: row.failures, recordFailures: row.recordFailures, sweepId: row.id, projectId, error });
    }
  }
  return due;
}

/** A failed attempt was to be recorded on a sweep that does not exist or did not pass. */
class DeliveredReportFailureUnrecorded extends Error {
  constructor(readonly sweepId: string) {
    super(`cannot record a failed delivered report on acceptance sweep ${sweepId}: no passed acceptance_sweeps row has that id`);
    this.name = "DeliveredReportFailureUnrecorded";
  }
}

/**
 * Records a failure at a sweep's delivered report: its error; a failed read of the public interface
 * file, and records that did not read as a report, each counted apart; and, for an attempt that failed, one more failure and when to try again.
 */
export async function recordDeliveredReportFailure(db: DbHandle, sweepId: string, failure: DeliveredReportFailureRecord): Promise<void> {
  const { retryAfterSeconds } = failure;
  const updated = await db
    .update(acceptanceSweeps)
    .set({
      reportLastError: failure.error,
      ...(failure.interfaceRead ? { reportInterfaceReadFailures: sql`${acceptanceSweeps.reportInterfaceReadFailures} + 1` } : {}),
      ...(failure.recordUnread ? { reportRecordFailures: sql`${acceptanceSweeps.reportRecordFailures} + 1` } : {}),
      ...(retryAfterSeconds === null
        ? {}
        : { reportFailures: sql`${acceptanceSweeps.reportFailures} + 1`, reportRetryAt: sql`now() + make_interval(secs => ${retryAfterSeconds})` }),
    })
    .where(and(eq(acceptanceSweeps.id, sweepId), eq(acceptanceSweeps.passed, true)))
    .returning({ id: acceptanceSweeps.id });
  if (updated.length === 0) throw new DeliveredReportFailureUnrecorded(sweepId);
}

/** A delivered report was asked to be posted for a sweep that does not exist or did not pass. */
class AcceptedSweepNotFound extends Error {
  constructor(readonly sweepId: string) {
    super(`cannot post the delivered report on acceptance sweep ${sweepId}: no passed acceptance_sweeps row has that id`);
    this.name = "AcceptedSweepNotFound";
  }
}

/**
 * Posts the delivered report, or the acceptance notice in its place, and records it on the sweep,
 * with its table's verdicts, in one transaction; once per sweep.
 */
export async function postDeliveredReport(db: Database, sweepId: string, body: string, verdicts: TableVerdicts): Promise<"posted" | "already-posted"> {
  return db.transaction(async (tx) => {
    const [sweep] = await tx
      .select({ projectId: acceptanceSweeps.projectId, reportId: acceptanceSweeps.reportId })
      .from(acceptanceSweeps)
      .where(and(eq(acceptanceSweeps.id, sweepId), eq(acceptanceSweeps.passed, true)))
      .for("update");
    if (!sweep) throw new AcceptedSweepNotFound(sweepId);
    if (sweep.reportId !== null) return "already-posted";
    const rows = await tx
      .insert(clientMessages)
      .values({ projectId: sweep.projectId, direction: "outbound", kind: "report", body, inReplyTo: null })
      .returning({ id: clientMessages.id });
    const message = insertedRow(rows, "client_messages", `post the delivered report of acceptance sweep ${sweepId}`);
    await insertGuaranteeVerdicts(tx, sweep.projectId, message.id, verdicts);
    await tx.update(acceptanceSweeps).set({ reportId: message.id }).where(eq(acceptanceSweeps.id, sweepId));
    return "posted";
  });
}
