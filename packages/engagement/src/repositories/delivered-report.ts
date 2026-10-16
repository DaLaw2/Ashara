import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { acceptanceSweeps, clientMessages, completedGoalTasks, insertedRow, noOpenStop, projects, taskChecks, visionDocuments, workItems } from "@ashara/db";
import type { Database, DbHandle } from "@ashara/db";
import { parseProjectId, type ProjectId } from "@ashara/shared";
import { parseStoredTaskSpec } from "@ashara/delivery/work-item";
import type { AcceptedAssumptionStanding } from "../vision-language/vision-assumption.js";
import type { DeliveredReportFailureRecord } from "../delivered-report.js";
import type { VisionSource } from "../vision-language/vision-source.js";
import { VisionUnreadable, readVisionVersion } from "../vision.js";
import type { StoredVision, VisionAssumption, VisionVersion } from "../vision.js";

// The Liaison's delivered report (migration 049; story s-independent-verify-m1 W7): due while a
// passed acceptance sweep has none, rendered only from what is recorded: how each goal task closed,
// which tasks' checks the sweep ran, the tasks given up, and every item of the reviewed vision with
// whether a check covers it and where each assumption stood with the client at acceptance.

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
 * An item of the vision as the delivered report names it: a scope line as the plan's review recorded
 * it, or an assumption with where it stands with the client at acceptance (d95 a).
 */
type AcceptedVisionItem =
  | Extract<VisionSource, { readonly type: "scope" }>
  | {
      readonly type: "assumption";
      readonly id: string;
      readonly text: string;
      readonly kind: Extract<VisionSource, { readonly type: "assumption" }>["kind"];
      readonly standing: AcceptedAssumptionStanding;
    };

/**
 * Every item of the vision the delivered plan was reviewed against, each with whether an acceptance
 * line of a check task whose stored checks ran in the sweep cites it.
 */
type VisionCoverage =
  | { readonly kind: "recorded"; readonly items: ReadonlyArray<{ readonly source: AcceptedVisionItem; readonly checked: boolean }> }
  /** The review, or a check task whose checks ran, records no traced items: coverage cannot be stated. */
  | { readonly kind: "unrecorded" };

interface DueDeliveredReportRow {
  readonly kind: "due";
  /** Failed attempts at the report so far (migration 062). */
  readonly failures: number;
  /** Failed reads of the public interface file so far (migration 062). */
  readonly interfaceReadFailures: number;
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
  readonly vision: VisionCoverage;
}

/**
 * A due report whose records could not be read; the rest of the due reports are still listed.
 * `cause` is "record" when what was read does not hold together as a report (ReportRecordUnreadable),
 * "read-failed" for any other failure of the read.
 */
interface UnreadDeliveredReportRow {
  readonly kind: "unread";
  readonly cause: "record" | "read-failed";
  readonly failures: number;
  readonly recordFailures: number;
  readonly sweepId: string;
  readonly projectId: ProjectId;
  readonly error: unknown;
}

/** What was read of a sweep's records does not hold together as its delivered report; a retry reads the same. */
abstract class ReportRecordUnreadable extends Error {}

/** A task_spec the report reads does not parse. */
class ReportTaskSpecUnreadable extends ReportRecordUnreadable {
  constructor(
    readonly taskId: string,
    options: { readonly cause: unknown },
  ) {
    super(`work item ${taskId}: its task_spec does not parse for the delivered report`, options);
    this.name = "ReportTaskSpecUnreadable";
  }
}

/** parseStoredTaskSpec, whose every throw is a row that does not parse, as the report's record defect. */
function storedSpecOf(taskId: string, raw: unknown): ReturnType<typeof parseStoredTaskSpec> {
  try {
    return parseStoredTaskSpec(raw);
  } catch (err) {
    throw new ReportTaskSpecUnreadable(taskId, { cause: err });
  }
}

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
        eq(workItems.level, "Task"),
        eq(workItems.status, "Abandoned"),
        sql`${workItems.taskSpec}->>'origin' = 'decomposition'`,
        sql`${workItems.blockedReason}->>'source' IS DISTINCT FROM 'superseded'`,
      ),
    )
    .orderBy(asc(workItems.updatedAt), asc(workItems.id));
  return rows.map((row) => row.title);
}

/** A check task's acceptance line cites an item id its own task_spec.sources does not hold. */
class AcceptanceTraceBroken extends ReportRecordUnreadable {
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
  const spec = storedSpecOf(checkTaskId, rawSpec);
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

/** Where an assumption stood with the client at acceptance cannot be read: the report never falls back to the plan's copy. */
class AcceptedStandingUnreadable extends ReportRecordUnreadable {
  constructor(
    readonly sweepId: string,
    readonly projectId: string,
    readonly visionVersion: number | null,
    readonly detail: string,
  ) {
    super(
      `acceptance sweep ${sweepId} of project ${projectId}: where the client stood on the vision at acceptance cannot be read` +
        `${visionVersion === null ? "" : ` (vision v${visionVersion})`}: ${detail}`,
    );
    this.name = "AcceptedStandingUnreadable";
  }
}

type AcceptedAssumption = Extract<AcceptedVisionItem, { readonly type: "assumption" }>;

/** The vision version current at acceptance, read through the Vision's reader; any read failure is unreadable. */
function visionAtAcceptance(sweep: { readonly id: string; readonly projectId: string }, stored: StoredVision): VisionVersion {
  const unreadable = (detail: string) => new AcceptedStandingUnreadable(sweep.id, sweep.projectId, stored.version, detail);
  let vision: VisionVersion;
  try {
    vision = readVisionVersion(stored);
  } catch (err) {
    if (!(err instanceof VisionUnreadable)) throw err;
    throw unreadable(`its ${err.field} are not readable: ${err.issues}`);
  }
  // The deleted CLI path's map records no status and no disclosure: where the client stood is not on record.
  if (vision.assumptions.some((assumption) => assumption.status === null)) {
    throw unreadable("its assumptions are not a list of assumption records");
  }
  if (vision.openQuestions.some((question) => question.messageId === null || !z.guid().safeParse(question.messageId).success)) {
    throw unreadable("its open questions do not each name the question message asked");
  }
  return vision;
}

/**
 * Each assumption of the vision version current at acceptance, by id, with where it then stood with
 * the client (d95 a): a confirming answer asks for no replan, so the plan's own copy of the vision
 * can predate it. A reply counts only if it was sent by acceptance, and as read only if
 * it was read by then. Throws AcceptedStandingUnreadable when any of it cannot be read.
 */
async function assumptionsAtAcceptance(
  db: DbHandle,
  sweep: { readonly id: string; readonly projectId: string; readonly acceptedAt: Date },
): Promise<ReadonlyMap<string, AcceptedAssumption>> {
  const [stored] = await db
    .select()
    .from(visionDocuments)
    .where(and(eq(visionDocuments.projectId, sweep.projectId), lte(visionDocuments.createdAt, sweep.acceptedAt)))
    .orderBy(desc(visionDocuments.version))
    .limit(1);
  if (stored === undefined) throw new AcceptedStandingUnreadable(sweep.id, sweep.projectId, null, "no vision version was written by acceptance");
  const unreadable = (detail: string) => new AcceptedStandingUnreadable(sweep.id, sweep.projectId, stored.version, detail);
  const vision = visionAtAcceptance(sweep, stored);
  const asked = vision.openQuestions.flatMap((question) =>
    question.messageId === null || question.assumptionKey === null ? [] : [{ messageId: question.messageId, assumptionKey: question.assumptionKey }],
  );
  const replies = asked.length === 0
    ? []
    : await db
        .select({ question: clientMessages.inReplyTo, consumedAt: clientMessages.consumedAt })
        .from(clientMessages)
        .where(
          and(
            eq(clientMessages.direction, "inbound"),
            eq(clientMessages.kind, "answer"),
            inArray(clientMessages.inReplyTo, asked.map((question) => question.messageId)),
            lte(clientMessages.createdAt, sweep.acceptedAt),
          ),
        );

  const standingOf = (assumption: VisionAssumption): AcceptedAssumptionStanding => {
    if (assumption.status === "Stated") {
      if (assumption.clientAnswer === null) throw unreadable(`assumption ${assumption.id} is Stated but carries no client answer`);
      if (assumption.clientAnswer.verdict === null) return "stated";
      return assumption.clientAnswer.verdict === "confirms" ? "confirmed" : "changed";
    }
    if (assumption.disclosed === null) return "unrecorded";
    if (assumption.disclosed === "reported") return "reported";
    const question = asked.find((open) => open.assumptionKey === assumption.id);
    if (question === undefined) throw unreadable(`assumption ${assumption.id} was asked about and is not Stated, yet no open question names it`);
    const reply = replies.find((row) => row.question === question.messageId);
    if (reply === undefined) return "asked";
    return reply.consumedAt !== null && reply.consumedAt <= sweep.acceptedAt ? "answered" : "answer-unread";
  };

  return new Map(
    vision.assumptions.map((assumption): [string, AcceptedAssumption] => [
      assumption.id,
      { type: "assumption", id: assumption.id, text: assumption.statement, kind: assumption.kind, standing: standingOf(assumption) },
    ]),
  );
}

/**
 * Every item of the vision as the plan's latest completed review recorded it (every item of the
 * vision its revision was decomposed from), each checked exactly when an acceptance line of the
 * check task of a goal task's latest stored checks (the sets the sweep ran) cites it. A
 * stored check is not recorded against one line, so the trace reaches the check task's lines, not
 * one check. Unrecorded when the review, or one of those check tasks, holds no traced items. Which
 * items are checked comes from the trace; where each assumption stands with the client comes from
 * the vision at acceptance (d95 a), and an assumption whose text there is not the one reviewed is
 * refused, never reported on the plan's copy.
 */
async function visionCoverage(
  db: DbHandle,
  sweep: { readonly id: string; readonly projectId: string; readonly acceptedAt: Date },
  goalIds: readonly string[],
): Promise<VisionCoverage> {
  const { projectId } = sweep;
  const [review] = await db
    .select({ id: workItems.id, taskSpec: workItems.taskSpec })
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
  const items = review ? storedSpecOf(review.id, review.taskSpec)?.sources : undefined;
  if (items === undefined) return { kind: "unrecorded" };
  const cited = new Set<string>();
  for (const author of goalIds.length === 0 ? [] : await checkAuthors(db, goalIds)) {
    const lines = citedBy(author.id, author.taskSpec);
    if (lines === null) return { kind: "unrecorded" };
    for (const identity of lines) cited.add(identity);
  }
  const current = items.some((source) => source.type === "assumption") ? await assumptionsAtAcceptance(db, sweep) : new Map<string, AcceptedAssumption>();
  return {
    kind: "recorded",
    items: items.map((source) => {
      const checked = cited.has(sourceIdentity(source));
      if (source.type === "scope") return { source, checked };
      const now = current.get(source.id);
      if (now === undefined) {
        throw new AcceptedStandingUnreadable(sweep.id, projectId, null, `the vision at acceptance holds no assumption ${source.id}, which the plan's review recorded`);
      }
      if (now.text !== source.text) {
        throw new AcceptedStandingUnreadable(
          sweep.id,
          projectId,
          null,
          `assumption ${source.id} reads "${now.text}" at acceptance, not "${source.text}" as the plan's review recorded it`,
        );
      }
      return { source: now, checked };
    }),
  };
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
  readonly acceptedAt: Date;
  readonly workspacePath: string | null;
  readonly failures: number;
  readonly interfaceReadFailures: number;
}

async function dueReportOf(db: DbHandle, row: DueSweep): Promise<DueDeliveredReportRow> {
  const goals = await goalCloses(db, row.projectId);
  const goalIds = (await completedGoalTasks(db, row.projectId)).map((goal) => goal.id);
  // A passed sweep always ran on main (acceptance_sweeps_pass_has_main).
  if (row.mainCommit === null) throw new AcceptedSweepWithoutMain(row.id);
  if (row.workspacePath === null) throw new AcceptedProjectWithoutWorkspace(row.id, row.projectId);
  return {
    kind: "due",
    failures: row.failures,
    interfaceReadFailures: row.interfaceReadFailures,
    sweepId: row.id,
    projectId: row.projectId,
    mainCommit: row.mainCommit,
    targetProjectPath: row.workspacePath,
    goals,
    checked: await sweepTaskTitles(db, row.id, "checked_tasks", row.checkedTasks),
    unchecked: await sweepTaskTitles(db, row.id, "unchecked_tasks", row.uncheckedTasks),
    givenUp: await givenUpGoalTitles(db, row.projectId),
    vision: await visionCoverage(db, { id: row.id, projectId: row.projectId, acceptedAt: row.acceptedAt }, goalIds),
  };
}

/**
 * Every passed sweep whose delivered report is not yet posted and is not waiting out the backoff of
 * a failed attempt (migration 062), oldest first, with what the report is rendered from. A sweep
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
      acceptedAt: acceptanceSweeps.createdAt,
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
      // Only records that do not hold together count toward the notice sent in the report's place;
      // a read that failed for any other reason (a lost connection) says nothing of them.
      const cause = error instanceof ReportRecordUnreadable ? "record" : "read-failed";
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
 * file, and records that did not read as a report (migration 063), each counted apart; and, for an attempt that failed, one more failure and when to try again.
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
    const rows = await tx
      .insert(clientMessages)
      .values({ projectId: sweep.projectId, direction: "outbound", kind: "report", body, inReplyTo: null })
      .returning({ id: clientMessages.id });
    const message = insertedRow(rows, "client_messages", `post the delivered report of acceptance sweep ${sweepId}`);
    await tx.update(acceptanceSweeps).set({ reportId: message.id }).where(eq(acceptanceSweeps.id, sweepId));
    return "posted";
  });
}
