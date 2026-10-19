import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { acceptanceSweeps, clientMessages, completedGoalTasks, goalTaskSql, insertedRow, intakeReadings, isDatabaseConnectionFault, noOpenStop, projects, suiteReviewClaims, suiteReviewJudgements, taskChecks, undecidedItemClaims, undecidedItems, visionDocuments, workItems } from "@ashara/db";
import type { Database, DbHandle } from "@ashara/db";
import { CapabilityLevelSchema, SECOND_OPINION_STRENGTHS } from "@ashara/finance";
import { parseProjectId, type ProjectId } from "@ashara/shared";
import { parseStoredTaskSpec } from "@ashara/delivery/work-item";
import type { AcceptedAssumptionStanding } from "../vision-language/vision-assumption.js";
import type { DeliveredReportFailureRecord, JudgeStanding, ReadingTold, ReviewStrength, UndecidedBy } from "../delivered-report.js";
import type { VisionSource } from "../vision-language/vision-source.js";
import { VisionUnreadable, readVisionVersion } from "../vision.js";
import type { StoredVision, VisionAssumption, VisionVersion } from "../vision.js";

// The Liaison's delivered report: due while a
// passed acceptance sweep has none, rendered only from what is recorded: how each goal task closed,
// which tasks' checks the sweep ran and the commands of those that passed, the tasks given up, and every item of the reviewed vision with
// whether a check covers it and where each assumption stood with the client at acceptance.

/** How a goal task's recorded commit closed it. */
type GoalClose =
  | { readonly kind: "merged"; readonly commit: string }
  /** `by` is the task whose merge made that commit, null when no task records it as its merge. */
  | { readonly kind: "already-delivered"; readonly commit: string; readonly by: string | null }
  /** A commit is recorded, but not how it closed the task (a record from before merge kinds were recorded). */
  | { readonly kind: "unrecorded-kind"; readonly commit: string }
  /** Completed with no commit recorded at all. */
  | { readonly kind: "no-record" };

/** An assumption with where it stands with the client at acceptance. */
interface AcceptedAssumption {
  readonly type: "assumption";
  readonly id: string;
  readonly text: string;
  readonly kind: Extract<VisionSource, { readonly type: "assumption" }>["kind"];
  readonly standing: AcceptedAssumptionStanding;
}

/**
 * An item of the vision as the delivered report names it: a guarantee or a scope line as the plan's
 * review recorded it, or an assumption with where it stands with the client at acceptance. A
 * guarantee a version written before guarantees reads from an assumption carries that assumption as
 * it stood at acceptance, so the client is told it was Ashara's; null on every other guarantee.
 */
type AcceptedVisionItem =
  | (Extract<VisionSource, { readonly type: "guarantee" }> & { readonly assumed: AcceptedAssumption | null })
  | Extract<VisionSource, { readonly type: "scope" }>
  | AcceptedAssumption;

/**
 * Every item of the vision the delivered plan was reviewed against, each with whether an acceptance
 * line of a check task whose stored checks ran in the sweep cites it.
 */
type VisionCoverage =
  | {
      readonly kind: "recorded";
      readonly items: ReadonlyArray<{
        readonly source: AcceptedVisionItem;
        readonly checked: boolean;
        readonly undecided: UndecidedBy;
        readonly review: ReviewStrength | null;
        readonly judges: JudgeStanding | null;
      }>;
    }
  /** The review, or a check task whose checks ran, records no traced items: coverage cannot be stated. */
  | { readonly kind: "unrecorded" };

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
  readonly vision: VisionCoverage;
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
        eq(workItems.status, "Abandoned"),
        goalTaskSql,
        sql`${workItems.blockedReason}->>'source' IS DISTINCT FROM 'superseded'`,
      ),
    )
    .orderBy(asc(workItems.updatedAt), asc(workItems.id));
  return rows.map((row) => row.title);
}

/** A stored check says it decides an item id its check task's task_spec.sources does not hold, or its decides does not parse. */
class CheckDecisionUnreadable extends ReportRecordUnreadable {
  constructor(
    readonly checkTaskId: string,
    readonly check: string,
    readonly detail: string,
  ) {
    super(`check task ${checkTaskId}: stored check "${check}" ${detail}`);
    this.name = "CheckDecisionUnreadable";
  }
}

/**
 * An item is the same across the plan's revisions only when its id and text both match. Its kind is
 * not compared: a version written before guarantees reads a scope line or an assumption an earlier
 * revision cited as the guarantee of the same key and statement.
 */
function sourceIdentity(source: VisionSource): string {
  return JSON.stringify([source.id, source.text]);
}

/** task_checks.decides: the ids of the vision items one stored check decides; null on a row written before it. */
const StoredDecidesSchema = z.array(z.string().min(1)).min(1).nullable();

/**
 * The items one stored check decides, by identity, each read as its check task cites it; null when
 * the check records no items it decides (written before decides was recorded) or its check task records no
 * cited items, so what it covers is not on record.
 */
function decidedBy(check: { readonly checkTaskId: string; readonly name: string; readonly decides: unknown; readonly taskSpec: unknown }): Set<string> | null {
  const decides = StoredDecidesSchema.safeParse(check.decides);
  if (!decides.success) throw new CheckDecisionUnreadable(check.checkTaskId, check.name, `records decides that do not parse: ${z.prettifyError(decides.error)}`);
  const sources = storedSpecOf(check.checkTaskId, check.taskSpec)?.sources;
  if (decides.data === null || sources === undefined) return null;
  const decided = new Set<string>();
  for (const id of decides.data) {
    const source = sources.find((each) => each.id === id);
    if (source === undefined) throw new CheckDecisionUnreadable(check.checkTaskId, check.name, `decides ${id}, which its check task's task_spec.sources does not hold`);
    decided.add(sourceIdentity(source));
  }
  return decided;
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

/** Every check of each goal task's latest stored revision (the sets the sweep ran), with its check task's task spec. */
async function storedChecksOf(
  db: DbHandle,
  goalIds: readonly string[],
): Promise<Array<{ readonly checkTaskId: string; readonly name: string; readonly decides: unknown; readonly taskSpec: unknown }>> {
  return db
    .select({ checkTaskId: taskChecks.checkTaskId, name: taskChecks.name, decides: taskChecks.decides, taskSpec: workItems.taskSpec })
    .from(taskChecks)
    .innerJoin(workItems, eq(workItems.id, taskChecks.checkTaskId))
    .where(
      and(
        inArray(taskChecks.taskId, [...goalIds]),
        sql`${taskChecks.revision} = (SELECT max(latest.revision) FROM task_checks latest WHERE latest.task_id = ${taskChecks.taskId})`,
      ),
    )
    .orderBy(asc(taskChecks.checkTaskId), asc(taskChecks.name));
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
 * the client: a confirming answer asks for no replan, so the plan's own copy of the vision
 * can predate it. A reply counts only if it was sent by acceptance, and as read only if
 * it was read by then. A guarantee that version reads from an assumption, by the guarantee's id,
 * with that assumption. Throws AcceptedStandingUnreadable when any of it cannot be read.
 */
async function assumptionsAtAcceptance(
  db: DbHandle,
  sweep: { readonly id: string; readonly projectId: string; readonly acceptedAt: Date },
): Promise<{ readonly assumptions: ReadonlyMap<string, AcceptedAssumption>; readonly assumedGuarantees: ReadonlyMap<string, AcceptedAssumption> }> {
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

  const assumptions = new Map(
    vision.assumptions.map((assumption): [string, AcceptedAssumption] => [
      assumption.id,
      { type: "assumption", id: assumption.id, text: assumption.statement, kind: assumption.kind, standing: standingOf(assumption) },
    ]),
  );
  const assumedGuarantees = new Map<string, AcceptedAssumption>();
  for (const guarantee of vision.guarantees) {
    if (guarantee.source.kind !== "legacy" || guarantee.source.from !== "assumption") continue;
    const assumption = assumptions.get(guarantee.source.id);
    if (assumption === undefined) throw unreadable(`guarantee ${guarantee.id} is read from assumption ${guarantee.source.id}, which the version does not hold`);
    assumedGuarantees.set(guarantee.id, assumption);
  }
  return { assumptions, assumedGuarantees };
}

/**
 * Every item of the vision as the plan's latest completed review recorded it (every item of the
 * vision its revision was decomposed from), each checked exactly when a check of a goal task's
 * latest stored revision (the sets the sweep ran) records that it decides it: a line
 * citing an item is no check of it; each also undecided when a suite review left it so on one of
 * those goal tasks' check tasks. Unrecorded when the review holds no traced items, or one of
 * those checks records no items it decides. Where each assumption stands with the client comes from
 * the vision at acceptance, and an assumption whose text there is not the one reviewed is
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
  /** Each decided item, by identity, with the check tasks whose stored checks decide it. */
  const deciders = new Map<string, Set<string>>();
  for (const check of goalIds.length === 0 ? [] : await storedChecksOf(db, goalIds)) {
    const items = decidedBy(check);
    if (items === null) return { kind: "unrecorded" };
    for (const identity of items) {
      const by = deciders.get(identity);
      if (by === undefined) deciders.set(identity, new Set([check.checkTaskId]));
      else by.add(check.checkTaskId);
    }
  }
  const current = items.some((source) => source.type !== "scope")
    ? await assumptionsAtAcceptance(db, sweep)
    : { assumptions: new Map<string, AcceptedAssumption>(), assumedGuarantees: new Map<string, AcceptedAssumption>() };
  const undecided = goalIds.length === 0 ? new Map<string, UndecidedRecord>() : await undecidedOf(db, projectId, goalIds);
  const confirmations = await claimStrengths(db, projectId);
  return {
    kind: "recorded",
    items: items.map((source) => {
      const by = deciders.get(sourceIdentity(source));
      const checked = by !== undefined;
      const record = undecided.get(undecidedIdentity(source));
      // An item no review left undecided is false: no undecided_items row names it. Its review is then
      // the weakest confirmation among the check tasks deciding it, none when one of them has none.
      const left: UndecidedBy = record === undefined ? false : record.reason;
      const confirmed = record !== undefined || by === undefined ? null : weakestConfirmation([...by].map((checkTaskId) => confirmationOf(confirmations, checkTaskId)));
      const review = record !== undefined ? record.strength : confirmed === null ? null : confirmed.strength;
      const judges = confirmed === null ? null : confirmed.judges;
      if (source.type === "scope") return { source, checked, undecided: left, review, judges };
      if (source.type === "guarantee") {
        const assumed = current.assumedGuarantees.get(source.id);
        if (assumed !== undefined && assumed.text !== source.text) {
          throw new AcceptedStandingUnreadable(
            sweep.id,
            projectId,
            null,
            `guarantee ${source.id} is read from assumption ${assumed.id}, which reads "${assumed.text}" at acceptance, not "${source.text}" as the plan's review recorded it`,
          );
        }
        return { source: { ...source, assumed: assumed === undefined ? null : assumed }, checked, undecided: left, review, judges };
      }
      const now = current.assumptions.get(source.id);
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
      return { source: now, checked, undecided: left, review, judges };
    }),
  };
}

/** An item as an undecided_items row names it: its id and the text its check task cited it with. */
function undecidedIdentity(item: { readonly id: string; readonly text: string }): string {
  return JSON.stringify([item.id, item.text]);
}

/** An undecided_items row ties its item to neither a judgement nor a claim, which undecided_items_one_source and undecided_items_claim_linked forbid. */
class UndecidedItemUnsourced extends ReportRecordUnreadable {
  constructor(
    readonly itemId: string,
    readonly detail: string,
  ) {
    super(`undecided item ${itemId}: ${detail} (undecided_items_one_source and undecided_items_claim_linked should forbid it)`);
    this.name = "UndecidedItemUnsourced";
  }
}

/** The strength of a second review as stored; null where none answered. */
const StoredStrengthSchema = z.enum(SECOND_OPINION_STRENGTHS).nullable();

/** A stored second review's strength does not parse, or a confirmed claim records none. */
class ReviewStrengthUnreadable extends ReportRecordUnreadable {
  constructor(
    readonly table: string,
    readonly detail: string,
  ) {
    super(`${table}: second_strength is not a strength of second opinion: ${detail}`);
    this.name = "ReviewStrengthUnreadable";
  }
}

function storedStrength(table: string, raw: unknown): ReviewStrength | null {
  const parsed = StoredStrengthSchema.safeParse(raw);
  if (!parsed.success) throw new ReviewStrengthUnreadable(table, z.prettifyError(parsed.error));
  return parsed.data;
}

/** Why an item is undecided, with the strength of the second review behind it; null where none answered. */
interface UndecidedRecord {
  readonly reason: Exclude<UndecidedBy, false>;
  readonly strength: ReviewStrength | null;
}

/** Why a judgement on a finding leaves its item undecided. */
function judgementReason(basis: string): Exclude<UndecidedBy, false> {
  return basis === "second-review-failed" ? "review-failed" : "unsettled";
}

/** Why a claim leaves an item it covers undecided. */
function claimReason(itemId: string, basis: string): Exclude<UndecidedBy, false> {
  if (basis === "second-opinion-found") return "clean-contradicted";
  // no-other-family: a same-provider answer that confirmed nothing, on a claim written before strengths were recorded.
  if (basis === "no-other-family" || basis === "second-review-failed") return "clean-unconfirmed";
  throw new UndecidedItemUnsourced(itemId, `its claim's basis ${JSON.stringify(basis)} confirms the item it leaves undecided`);
}

/** Which reason an item undecided on several check tasks is reported under: the failure first, so a failed review never reads as a disagreement. */
const REASON_RANK: Readonly<Record<Exclude<UndecidedBy, false>, number>> = {
  "review-failed": 0,
  "clean-unconfirmed": 1,
  "clean-contradicted": 2,
  unsettled: 3,
};

/**
 * The items a suite review left undecided on a check task of one of the goal tasks the sweep ran
 * by id and cited text, so the report never counts them as covered:
 * a review found no check really deciding them and nothing settled it, or the review that found no
 * problem in their checks was not confirmed. Each says why: of the judgement that kept it and every
 * claim tied to it (undecided_item_claims), the reason that ranks first in REASON_RANK, with the
 * strength of that source's second review.
 */
async function undecidedOf(db: DbHandle, projectId: string, goalIds: readonly string[]): Promise<Map<string, UndecidedRecord>> {
  const rows = await db
    .select({
      id: undecidedItems.itemId,
      text: undecidedItems.itemText,
      judgementBasis: suiteReviewJudgements.basis,
      judgementStrength: suiteReviewJudgements.secondStrength,
      claimBasis: suiteReviewClaims.basis,
      claimStrength: suiteReviewClaims.secondStrength,
    })
    .from(undecidedItems)
    .innerJoin(workItems, eq(workItems.id, undecidedItems.checkTaskId))
    .leftJoin(suiteReviewJudgements, eq(suiteReviewJudgements.id, undecidedItems.judgementId))
    // Every claim tied to the item, not undecided_items.claim_id, which names only the first claim that kept it.
    .leftJoin(undecidedItemClaims, and(eq(undecidedItemClaims.checkTaskId, undecidedItems.checkTaskId), eq(undecidedItemClaims.itemId, undecidedItems.itemId)))
    .leftJoin(suiteReviewClaims, eq(suiteReviewClaims.id, undecidedItemClaims.claimId))
    .where(and(eq(undecidedItems.projectId, projectId), inArray(sql`${workItems.taskSpec}->>'checksFor'`, [...goalIds])));
  const undecided = new Map<string, UndecidedRecord>();
  for (const row of rows) {
    const identity = undecidedIdentity(row);
    const sources: UndecidedRecord[] = [
      ...(row.judgementBasis === null ? [] : [{ reason: judgementReason(row.judgementBasis), strength: storedStrength("suite_review_judgements", row.judgementStrength) }]),
      ...(row.claimBasis === null ? [] : [{ reason: claimReason(row.id, row.claimBasis), strength: storedStrength("suite_review_claims", row.claimStrength) }]),
    ];
    if (sources.length === 0) throw new UndecidedItemUnsourced(row.id, "it is tied to neither a judgement nor a claim");
    for (const source of sources) {
      const kept = undecided.get(identity);
      if (kept === undefined || REASON_RANK[source.reason] < REASON_RANK[kept.reason]) undecided.set(identity, source);
    }
  }
  return undecided;
}

/** suite_review_claims.covered: the check tasks a claim covers. */
const ClaimCoveredSchema = z.array(z.string().min(1)).min(1);

/** A stored claim's covered list does not parse. */
class ClaimCoveredUnreadable extends ReportRecordUnreadable {
  constructor(
    readonly claimId: string,
    readonly detail: string,
  ) {
    super(`suite_review_claims row ${claimId}: covered is not a list of check task ids: ${detail}`);
    this.name = "ClaimCoveredUnreadable";
  }
}

/** A confirmation: the strength of the second review that confirmed, and how the claim's reviewing models stood to the work. */
interface Confirmation {
  readonly strength: ReviewStrength;
  readonly judges: JudgeStanding;
}

/** How the latest claim covering a check task stands: confirmed, or not confirmed. */
type ClaimConfirmation = ({ readonly kind: "confirmed" } & Confirmation) | { readonly kind: "unconfirmed" };

const StoredJudgeColumns = { judgeTier: CapabilityLevelSchema, judgedTier: CapabilityLevelSchema, tierRelation: z.enum(["above", "equal"]) };

/**
 * A confirmed claim's tier columns as stored: the three judge columns and both reviews' grades on a
 * claim written with them; the judge columns alone on one written before the reviews' grades were;
 * none on one written before either was.
 */
const StoredClaimTiersSchema = z.union([
  z.object({ ...StoredJudgeColumns, firstTier: CapabilityLevelSchema, secondTier: CapabilityLevelSchema }),
  z.object({ ...StoredJudgeColumns, firstTier: z.null(), secondTier: z.null() }),
  z.object({ judgeTier: z.null(), judgedTier: z.null(), tierRelation: z.null(), firstTier: z.null(), secondTier: z.null() }),
]);

/** A stored claim's tier columns do not read as a judge's standing to the work. */
class ClaimTiersUnreadable extends ReportRecordUnreadable {
  constructor(
    readonly claimId: string,
    readonly detail: string,
  ) {
    super(`suite_review_claims row ${claimId}: judge_tier, judged_tier, tier_relation, first_tier and second_tier do not read as a judge's standing to the work: ${detail}`);
    this.name = "ClaimTiersUnreadable";
  }
}

/**
 * How a confirmed claim's reviewing models stood to the work: an equal relation names the review
 * graded at the work's tier where both reviews' grades are on record, and says only that one was where they are not.
 */
function standingOf(claimId: string, tiers: z.infer<typeof StoredClaimTiersSchema>): JudgeStanding {
  if (tiers.tierRelation === null) return "unrecorded";
  if (tiers.tierRelation === "above") return "above";
  if (tiers.firstTier === null) return "equal";
  const firstAt = tiers.firstTier === tiers.judgedTier;
  const secondAt = tiers.secondTier === tiers.judgedTier;
  if (firstAt && secondAt) return "equal-both";
  if (secondAt) return "equal-second";
  if (firstAt) return "equal-first";
  throw new ClaimTiersUnreadable(claimId, `the relation is equal at ${tiers.judgedTier}, but neither review was graded at it (first ${tiers.firstTier}, second ${tiers.secondTier})`);
}

/**
 * Per check task, how the latest claim covering it stands: confirmed at the
 * strength of the second review that answered, whether it named nothing or something about other
 * items, with how its reviewing models stood to the work; unconfirmed when it failed or was answered
 * by its first's provider, a basis that records no strength. A check task no claim covers has no entry.
 */
async function claimStrengths(db: DbHandle, projectId: string): Promise<Map<string, ClaimConfirmation>> {
  const rows = await db
    .select({
      id: suiteReviewClaims.id,
      basis: suiteReviewClaims.basis,
      covered: suiteReviewClaims.covered,
      strength: suiteReviewClaims.secondStrength,
      judgeTier: suiteReviewClaims.judgeTier,
      judgedTier: suiteReviewClaims.judgedTier,
      tierRelation: suiteReviewClaims.tierRelation,
      firstTier: suiteReviewClaims.firstTier,
      secondTier: suiteReviewClaims.secondTier,
    })
    .from(suiteReviewClaims)
    .where(eq(suiteReviewClaims.projectId, projectId))
    .orderBy(asc(suiteReviewClaims.createdAt), asc(suiteReviewClaims.id));
  const latest = new Map<string, ClaimConfirmation>();
  for (const row of rows) {
    const covered = ClaimCoveredSchema.safeParse(row.covered);
    if (!covered.success) throw new ClaimCoveredUnreadable(row.id, z.prettifyError(covered.error));
    let standing: ClaimConfirmation = { kind: "unconfirmed" };
    if (row.basis === "second-opinion-clean" || row.basis === "second-opinion-found") {
      const strength = storedStrength("suite_review_claims", row.strength);
      if (strength === null) throw new ReviewStrengthUnreadable("suite_review_claims", `claim ${row.id} is ${row.basis} but records no strength`);
      const tiers = StoredClaimTiersSchema.safeParse(row);
      if (!tiers.success) throw new ClaimTiersUnreadable(row.id, z.prettifyError(tiers.error));
      standing = { kind: "confirmed", strength, judges: standingOf(row.id, tiers.data) };
    }
    for (const checkTaskId of covered.data) latest.set(checkTaskId, standing);
  }
  return latest;
}

/** A check task's confirmation; null when its latest claim was not confirmed or no claim covers it. */
function confirmationOf(confirmations: ReadonlyMap<string, ClaimConfirmation>, checkTaskId: string): Confirmation | null {
  const standing = confirmations.get(checkTaskId);
  return standing === undefined || standing.kind === "unconfirmed" ? null : standing;
}

/**
 * How the reviewing models of two confirmations stand to the work together: their shared standing
 * where it names the same review of the same strength; not on record where either is not; else only
 * that at least one of them was no stronger than the work, since no single review is named for both.
 */
function jointStanding(a: Confirmation, b: Confirmation): JudgeStanding {
  if (a.judges === "unrecorded" || b.judges === "unrecorded") return "unrecorded";
  if (a.judges === b.judges && (a.strength === b.strength || a.judges === "above" || a.judges === "equal")) return a.judges;
  return "equal";
}

/**
 * An item decided by several check tasks is confirmed only as strongly as the weakest of them
 * (SECOND_OPINION_STRENGTHS is strongest first), and its reviewing models stand to the work only as
 * all of theirs jointly do (jointStanding); null when one of them is not confirmed.
 */
function weakestConfirmation(confirmations: ReadonlyArray<Confirmation | null>): Confirmation | null {
  let weakest: Confirmation | null = null;
  for (const confirmation of confirmations) {
    if (confirmation === null) return null;
    if (weakest === null) {
      weakest = confirmation;
      continue;
    }
    weakest = {
      strength: SECOND_OPINION_STRENGTHS.indexOf(confirmation.strength) > SECOND_OPINION_STRENGTHS.indexOf(weakest.strength) ? confirmation.strength : weakest.strength,
      judges: jointStanding(confirmation, weakest),
    };
  }
  return weakest;
}

/** intake_readings as the report reads it; its CHECKs hold the second reading to its confirmation. */
const IntakeReadingRowSchema = z.discriminatedUnion("confirmation", [
  z.object({ confirmation: z.literal("not-needed") }),
  z.object({ confirmation: z.literal("confirmed"), secondStrength: StoredStrengthSchema.unwrap() }),
  z.object({ confirmation: z.literal("questions-raised"), secondStrength: StoredStrengthSchema.unwrap(), secondQuestions: z.number().int().min(1) }),
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
  readonly acceptedAt: Date;
  readonly workspacePath: string | null;
  readonly failures: number;
  readonly interfaceReadFailures: number;
  readonly recordFailures: number;
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
    vision: await visionCoverage(db, { id: row.id, projectId: row.projectId, acceptedAt: row.acceptedAt }, goalIds),
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
