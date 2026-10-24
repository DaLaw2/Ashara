import { eq, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { deliveredReportAttempts, intakeReadings } from "@ashara/db/schema/engagement";
import type { DbHandle } from "@ashara/db";
import { SECOND_OPINION_STRENGTHS } from "@ashara/finance";
import type { Clock, ProjectId } from "@ashara/shared";
import { completedGoalTasks } from "@ashara/delivery/predicates";
import { givenUpGoalTitles, mergedCommitsOf, workItemSummaries } from "@ashara/delivery/reads";
import { recordedSweep, type SweepOutcome, type SweepRef } from "@ashara/quality/published-reads";
import type { DeliveredReportFailureRecord, DueDeliveredReport, ExecutedChecks, ReadingTold } from "../delivered-report.js";

// The records of the Liaison's delivered report, a terminal message (repositories/terminal-report.ts):
// rendered only from what is recorded: how each goal task closed, which tasks' checks the sweep ran
// and the commands of those that passed (Quality's published sweep outcome), the tasks given up,
// and how the tender was read. Its failed attempts are its own record (delivered_report_attempts).

/** What was read of a sweep's records does not hold together as its delivered report; a retry reads the same. */
abstract class ReportRecordUnreadable extends Error {}

/** Reads a sweep's outcome: Quality's published read, which the composition root supplies. */
export type SweepOutcomeReader = (db: DbHandle, sweepId: string) => Promise<SweepOutcome>;

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

/** The titles of the tasks `ids` names, in its order. */
async function sweepTaskTitles(db: DbHandle, sweepId: string, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const titles = new Map((await workItemSummaries(db, ids)).map((row) => [row.id, row.title]));
  return ids.map((id) => {
    const title = titles.get(id);
    if (title === undefined) throw new SweepTaskMissing(sweepId, id);
    return title;
  });
}

/** The stored checks the sweep records it ran and saw pass, each with its task's title; unrecorded on a sweep from before check outcomes were recorded. */
async function passedChecksOf(db: DbHandle, sweepId: string, recorded: SweepOutcome["checks"]): Promise<ExecutedChecks> {
  if (recorded.kind === "unrecorded") return { kind: "unrecorded" };
  const passed = recorded.checks.filter((check) => check.outcome === "passed");
  const ids = [...new Set(passed.map((check) => check.taskId))];
  const titles = new Map((await workItemSummaries(db, ids)).map((row) => [row.id, row.title]));
  return {
    kind: "recorded",
    checks: passed.map((check) => {
      const task = titles.get(check.taskId);
      if (task === undefined) throw new SweepTaskMissing(sweepId, check.taskId);
      return { task, name: check.name, command: check.command };
    }),
  };
}

async function goalCloses(db: DbHandle, projectId: string): Promise<DueDeliveredReport["goals"]> {
  const goals = await completedGoalTasks(db, projectId);
  const merges = await mergedCommitsOf(db, projectId);
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

/** What Engagement keeps of a passed sweep beside it: its project's target checkout and the counts of its failed attempts. */
const DueSweepRecordSchema = z.strictObject({
  workspacePath: z.string().nullable(),
  failures: z.number().int().nonnegative(),
  interfaceReadFailures: z.number().int().nonnegative(),
  recordFailures: z.number().int().nonnegative(),
});

/**
 * What the delivered report's listing selects beside each passed sweep (Quality's passedSweepsWhere):
 * the project's target checkout and the counts of the sweep's failed attempts.
 */
export function deliveredAttempts(sweep: SweepRef): SQL<unknown> {
  // A count of the sweep's failed attempts is none while no attempt failed: no attempts row is on file.
  return sql<unknown>`(SELECT jsonb_build_object('workspacePath', ap.workspace_path,
      'failures', COALESCE(da.failures, 0), 'interfaceReadFailures', COALESCE(da.interface_read_failures, 0),
      'recordFailures', COALESCE(da.record_failures, 0))
    FROM projects ap LEFT JOIN delivered_report_attempts da ON da.sweep_id = ${sweep.id}
    WHERE ap.id = ${sweep.projectId})`;
}

/**
 * No failed attempt at the sweep's delivered report is waiting out its backoff on `clock`, the time
 * the cycle runs on, never the database's: a backoff set and read on another clock than the one that
 * spaces the cycles passes in no number of cycles, or in none at all.
 */
export function deliveredRetryDue(sweep: SweepRef, clock: Clock): SQL {
  return sql`NOT EXISTS (SELECT 1 FROM delivered_report_attempts da WHERE da.sweep_id = ${sweep.id} AND da.retry_at > ${new Date(clock.now())})`;
}

/** One passed sweep due its delivered report, as listed, with what deliveredAttempts selected beside it. */
export interface DueSweep {
  readonly id: string;
  readonly projectId: ProjectId;
  readonly mainCommit: string | null;
  readonly workspacePath: string | null;
  readonly failures: number;
  readonly interfaceReadFailures: number;
  readonly recordFailures: number;
}

/** What deliveredAttempts selected beside a sweep, read. */
export function attemptsOf(annotation: unknown): z.infer<typeof DueSweepRecordSchema> {
  return DueSweepRecordSchema.parse(annotation);
}

/** A passed sweep's delivered report, read from its records; one whose records do not hold together throws. */
export async function deliveredReportOf(db: DbHandle, row: DueSweep, sweepOutcome: SweepOutcomeReader): Promise<DueDeliveredReport> {
  const goals = await goalCloses(db, row.projectId);
  // A passed sweep always ran on main (acceptance_sweeps_pass_has_main).
  if (row.mainCommit === null) throw new AcceptedSweepWithoutMain(row.id);
  if (row.workspacePath === null) throw new AcceptedProjectWithoutWorkspace(row.id, row.projectId);
  const outcome = await sweepOutcome(db, row.id);
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
    checked: await sweepTaskTitles(db, row.id, outcome.checkedTasks),
    unchecked: await sweepTaskTitles(db, row.id, outcome.uncheckedTasks),
    givenUp: await givenUpGoalTitles(db, row.projectId),
    executed: await passedChecksOf(db, row.id, outcome.checks),
    reading: await readingOf(db, row.projectId),
  };
}

/** A failed attempt was to be recorded on a sweep that does not exist or did not pass. */
class DeliveredReportFailureUnrecorded extends Error {
  constructor(readonly sweepId: string) {
    super(`cannot record a failed delivered report on acceptance sweep ${sweepId}: no passed acceptance_sweeps row has that id`);
    this.name = "DeliveredReportFailureUnrecorded";
  }
}

/** The passed sweep's project; null when no passed sweep has that id. */
export async function passedSweepProject(db: DbHandle, sweepId: string): Promise<string | null> {
  const sweep = await recordedSweep(db, sweepId, true);
  return sweep === null ? null : sweep.projectId;
}

/**
 * Records a failure at a sweep's delivered report on Engagement's attempts record: its error; a
 * failed read of the public interface file, and records that did not read as a report, each counted
 * apart; and, for an attempt that failed, one more failure and when to try again, on `clock`, the
 * clock deliveredRetryDue reads it on.
 */
export async function recordDeliveredReportFailure(db: DbHandle, sweepId: string, failure: DeliveredReportFailureRecord, clock: Clock): Promise<void> {
  const projectId = await passedSweepProject(db, sweepId);
  if (projectId === null) throw new DeliveredReportFailureUnrecorded(sweepId);
  const { retryAfterSeconds } = failure;
  const counted = retryAfterSeconds === null ? 0 : 1;
  const retryAt = retryAfterSeconds === null ? null : new Date(clock.now() + retryAfterSeconds * 1000);
  await db
    .insert(deliveredReportAttempts)
    .values({
      sweepId,
      projectId,
      lastError: failure.error,
      interfaceReadFailures: failure.interfaceRead ? 1 : 0,
      recordFailures: failure.recordUnread ? 1 : 0,
      failures: counted,
      retryAt,
    })
    .onConflictDoUpdate({
      target: deliveredReportAttempts.sweepId,
      set: {
        lastError: failure.error,
        ...(failure.interfaceRead ? { interfaceReadFailures: sql`${deliveredReportAttempts.interfaceReadFailures} + 1` } : {}),
        ...(failure.recordUnread ? { recordFailures: sql`${deliveredReportAttempts.recordFailures} + 1` } : {}),
        ...(retryAt === null ? {} : { failures: sql`${deliveredReportAttempts.failures} + 1`, retryAt }),
      },
    });
}
