import { and, asc, eq, inArray, isNull, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { z } from "zod";
import { parseProjectId, readEach, type DomainEvent, type Logger, type ProjectId, type UnreadSubject } from "@ashara/shared";
import type { Database, DbHandle } from "@ashara/db";
import { domainEvents, projects } from "@ashara/db";
import { correctionHolds, planRepairs, planRevisions, projectPlans, workItems } from "@ashara/db/schema/delivery";
import type { AppliedCorrection } from "../acl/engagement-acl.js";
import { clientMessageBodies, firstPlanTold, noOpenAnswer, noOpenStop, planRevisionTold, projectAtWork } from "../acl/engagement-predicates-acl.js";
import { currentStoredVision, currentVisionVersion, parseStoredVision, type PublishedStoredVision } from "../acl/engagement-vision-acl.js";
import { CapabilityLevelSchema } from "../acl/finance-acl.js";
import { latestStoredChecks, StoredDecidesSchema } from "../acl/quality-acl.js";
import { lastCompletedAttempts } from "../acl/workplace-acl.js";
import type { VisionItem } from "../decomposition-types.js";
import { holdForCorrection, takeEvents } from "../domain/index.js";
import { firstPlanned, pendingCorrection, pendingRepair } from "../predicates.js";
import type { AttemptGrade, CorrectionRequest, RevisionCorrections } from "../replan-port.js";
import { parseStoredTaskSpec } from "../work-item-language/task-spec.js";
import { InvalidStatusTransition } from "../work-item-language/transitions.js";
import { IDLE_OPEN_WORK_ITEM_STATUSES } from "../work-item-language/work-item-status.js";
import { citesAnyOf } from "./citation.js";
import { tasksWithoutRosterOwner } from "./first-plan.js";
import { projectReportsPlans } from "./project-halt.js";
import { recordReplanFailure as countReplanFailure, revisionWritten } from "./project-plan.js";
import { rowToWorkItem, workItemSaveRow } from "./work-item-adapter.js";
import { WorkItemRowRepository } from "./work-item.js";

// Delivery's revisions of a plan under way. A project awaits a revision while it is at work,
// planned, has no unread answer and no stop awaiting the Liaison, and awaits either the revision
// for a client's correction (correction_holds), with no task citing a key it affects in progress, or
// the repair of a task the failure router gave up (plan_repairs), with no task in progress at all.
// Only a Task has a live attempt: an Epic is InProgress from its first started task until every child
// settles, so a plan under way always has one, and counting it would keep a flagged project from
// ever being revised. A correction holds only the tasks citing a key it affects, in its own
// transaction; a revision supersedes the work it replaces, writes the new work, records itself and
// records every correction and repair it takes in, in one transaction.

interface ProjectAwaitingReplanRow {
  readonly projectId: ProjectId;
  readonly projectName: string;
  /** The client's corrections whose revision the project awaits (correction_holds), oldest first; empty when none. */
  readonly correctionsAwaited: readonly CorrectionRequest[];
  /** The tasks the failure router gave up whose repair the project awaits, oldest first; empty when none. */
  readonly repairsAwaited: readonly string[];
  readonly replanAttempts: number;
  readonly replanLastError: string | null;
  readonly replanLastFailure: string | null;
  readonly revisionsSinceReview: number;
  readonly repairsSinceReview: number;
  readonly nextRevision: number;
  readonly vision: PublishedStoredVision;
}

const CountsSchema = z.object({
  revisionsSinceReview: z.number().int().min(0),
  repairsSinceReview: z.number().int().min(0),
  nextRevision: z.number().int().min(2),
});

/** Revisions of `kind` written after the operator last ended a `blockKind` block, every one when none was. */
function revisionsSince(kind: "client_change" | "repair", blockKind: "replan_bound" | "plan_repair") {
  return sql<unknown>`(SELECT count(*)::int FROM plan_revisions r WHERE r.project_id = projects.id AND r.kind = ${kind}
    AND r.created_at > COALESCE((SELECT max(b.ended_at) FROM project_blocks b WHERE b.project_id = projects.id
      AND b.kind = ${blockKind} AND b.end_kind = 'unblocked'), '-infinity'::timestamptz))`;
}

/**
 * Projects ready to be revised, oldest first, each with its current vision and the repairs it
 * awaits. One statement for the projects, so a project and the vision it is listed with are read
 * from the same snapshot. `revisionsSinceReview` counts the revisions for client changes written
 * after the operator last ended a replan_bound block; `repairsSinceReview` the plan repairs after
 * the last plan_repair block; each every one when none was. Each project is read on its own
 * (readEach): one whose rows do not read is its UnreadSubject, and every other project is listed.
 */
export async function listProjectsAwaitingReplan(db: DbHandle): Promise<Array<ProjectAwaitingReplanRow | UnreadSubject>> {
  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      replanAttempts: projectPlans.replanAttempts,
      replanLastError: projectPlans.replanLastError,
      replanLastFailure: projectPlans.replanLastFailure,
      revisionsSinceReview: revisionsSince("client_change", "replan_bound"),
      repairsSinceReview: revisionsSince("repair", "plan_repair"),
      nextRevision: sql<unknown>`(SELECT COALESCE(max(r.revision), 1) + 1 FROM plan_revisions r WHERE r.project_id = projects.id)`,
      vision: currentStoredVision(projects.id),
    })
    .from(projects)
    .innerJoin(projectPlans, eq(projectPlans.projectId, projects.id))
    .where(
      and(
        projectAtWork(),
        sql`${currentStoredVision(projects.id)} IS NOT NULL`,
        firstPlanned(projects.id),
        sql`((${pendingCorrection(projects.id)} AND NOT ${heldTaskInProgress(projects.id)})
          OR (${pendingRepair(projects.id)} AND NOT ${taskInProgress(projects.id)}))`,
        noOpenStop(projects.id),
        noOpenAnswer(),
      ),
    )
    .orderBy(asc(projects.createdAt), asc(projects.id));

  return readEach(
    rows,
    (row) => ({ id: row.id, projectId: parseProjectId(row.id, "projects.id") }),
    async (row): Promise<ProjectAwaitingReplanRow> => {
      const counts = CountsSchema.parse({
        revisionsSinceReview: row.revisionsSinceReview,
        repairsSinceReview: row.repairsSinceReview,
        nextRevision: row.nextRevision,
      });
      const awaited = await db
        .select({ id: planRepairs.workItemId })
        .from(planRepairs)
        .where(and(eq(planRepairs.projectId, row.id), isNull(planRepairs.planRevisionId)))
        .orderBy(asc(planRepairs.createdAt), asc(planRepairs.workItemId));
      return {
        projectId: parseProjectId(row.id, "projects.id"),
        projectName: row.name,
        correctionsAwaited: await awaitedCorrections(db, row.id),
        repairsAwaited: awaited.map((repair) => repair.id),
        replanAttempts: row.replanAttempts,
        replanLastError: row.replanLastError,
        replanLastFailure: row.replanLastFailure,
        ...counts,
        vision: parseStoredVision(row.id, row.vision),
      };
    },
  );
}

/** Whether a Task of the project is in progress. */
const taskInProgress = (projectId: AnyColumn): SQL =>
  sql`EXISTS (SELECT 1 FROM work_items w WHERE w.project_id = ${projectId} AND w.level = 'Task' AND w.status = 'InProgress')`;

/** Whether a Task citing a key of a correction the project awaits is in progress: that revision waits only for it. */
const heldTaskInProgress = (projectId: AnyColumn): SQL =>
  sql`EXISTS (SELECT 1 FROM work_items w JOIN correction_holds ch ON ch.project_id = w.project_id AND ch.plan_revision_id IS NULL
    WHERE w.project_id = ${projectId} AND w.level = 'Task' AND w.status = 'InProgress' AND ${citesAnyOf(sql`ch.affected`)})`;

const AffectedSchema = z.array(z.string().min(1));

/** A stored correction hold names no affected key, or its keys do not read: the row the migration's CHECK refuses. */
class CorrectionHoldUnreadable extends Error {
  constructor(
    readonly projectId: string,
    readonly visionVersion: number,
    readonly detail: string,
  ) {
    super(`project ${projectId}: the correction hold of vision v${visionVersion} does not read: ${detail}`);
    this.name = "CorrectionHoldUnreadable";
  }
}

/** The corrections whose revision the project awaits, in the order they were recorded. */
async function awaitedCorrections(db: DbHandle, projectId: string): Promise<CorrectionRequest[]> {
  const rows = await db
    .select({ visionVersion: correctionHolds.visionVersion, requestedBy: correctionHolds.requestedBy, affected: correctionHolds.affected })
    .from(correctionHolds)
    .where(and(eq(correctionHolds.projectId, projectId), isNull(correctionHolds.planRevisionId)))
    .orderBy(asc(correctionHolds.createdAt), asc(correctionHolds.visionVersion));
  const words = await clientMessageBodies(db, rows.map((row) => row.requestedBy));
  return rows.map((row) => {
    const affected = AffectedSchema.safeParse(row.affected);
    if (!affected.success) throw new CorrectionHoldUnreadable(projectId, row.visionVersion, z.prettifyError(affected.error));
    const [first, ...rest] = affected.data;
    if (first === undefined) throw new CorrectionHoldUnreadable(projectId, row.visionVersion, "it names no affected key");
    const said = words.get(row.requestedBy);
    if (said === undefined) throw new CorrectionHoldUnreadable(projectId, row.visionVersion, `the client message ${row.requestedBy} it answers is not on record`);
    return { visionVersion: row.visionVersion, requestedBy: row.requestedBy, words: said, affected: [first, ...rest] };
  });
}

/** What holdCorrection did: held, parking `parked` tasks, or nothing, and why. */
type HoldOutcome = { readonly kind: "held"; readonly parked: number } | { readonly kind: "unplanned" } | { readonly kind: "no-key" };

/**
 * Holds the work a client's correction touches, in the transaction that records the correction:
 * the correction is recorded as awaiting its revision, and every Task of the project not yet started
 * (Pending) that cites a key of a correction awaiting its revision is parked (correction_pending), so
 * it is never dispatched before the revision replaces it; every other task goes on dispatching. A
 * citing task in progress, Blocked or Failed is held as it comes back to Pending (the dispatch gate
 * parks it), and the revision waits for one in progress. The project row is locked, as the
 * first-plan transaction locks it: before the first plan nothing is held, since that plan is made
 * from the vision the correction wrote, and a correction affecting no guarantee or assumption holds
 * nothing either.
 */
export async function holdCorrection(db: DbHandle, hold: AppliedCorrection): Promise<HoldOutcome> {
  const affected = [...new Set(hold.affected)];
  if (affected.length === 0) return { kind: "no-key" };
  const [locked] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, hold.projectId)).for("update");
  if (!locked) return { kind: "unplanned" };
  const [planned] = await db.select({ id: projects.id }).from(projects).where(and(eq(projects.id, hold.projectId), firstPlanned(projects.id)));
  if (!planned) return { kind: "unplanned" };
  await db.insert(correctionHolds).values({ projectId: hold.projectId, visionVersion: hold.visionVersion, requestedBy: hold.requestedBy, affected });

  const rows = new WorkItemRowRepository(db);
  const held = await rows.listCorrectionHeld(hold.projectId);
  for (const { taskId, ...holdOf } of held) {
    const row = await rows.findById(taskId);
    if (row === null) throw new HeldTaskVanished(hold.projectId, taskId);
    const item = rowToWorkItem(row);
    holdForCorrection(item, holdOf);
    await rows.save(workItemSaveRow(item), "Pending");
    for (const event of takeEvents(item)) await insertEvent(db, event);
  }
  return { kind: "held", parked: held.length };
}

/** A task the hold's own read listed is gone before it is parked, under the project's lock. */
class HeldTaskVanished extends Error {
  constructor(
    readonly projectId: string,
    readonly taskId: string,
  ) {
    super(`project ${projectId}: task ${taskId}, listed as citing a corrected key, is gone before it could be held`);
    this.name = "HeldTaskVanished";
  }
}

async function insertEvent(db: DbHandle, event: DomainEvent): Promise<void> {
  await db.insert(domainEvents).values({
    eventId: event.eventId,
    eventType: event.eventType,
    timestamp: event.timestamp,
    sourceContext: event.sourceContext,
    correlationId: event.correlationId ?? null,
    payload: event.payload,
  });
}

/** A stored check's decides does not parse, or names an item its check task's task_spec.sources does not hold. */
class StoredDecisionUnreadable extends Error {
  constructor(
    readonly checkTaskId: string,
    readonly check: string,
    readonly detail: string,
  ) {
    super(`check task ${checkTaskId}: stored check "${check}" ${detail}`);
    this.name = "StoredDecisionUnreadable";
  }
}

/**
 * The vision items the latest stored check revision of each task of the project decides, keyed by
 * the task's id, each item as its check task cites it. A check that records no items it
 * decides (a legacy row) decides none, and a task with no stored checks is absent:
 * a citation never stands in for a check.
 */
export async function decidedByLatestChecks(db: DbHandle, projectId: string): Promise<Map<string, VisionItem[]>> {
  const checks = await latestStoredChecks(db, { projectId });
  const checkTaskIds = [...new Set(checks.map((check) => check.checkTaskId))];
  const specs =
    checkTaskIds.length === 0 ? [] : await db.select({ id: workItems.id, taskSpec: workItems.taskSpec }).from(workItems).where(inArray(workItems.id, checkTaskIds));
  const decided = new Map<string, VisionItem[]>();
  for (const check of checks) {
    const spec = specs.find((each) => each.id === check.checkTaskId);
    if (spec === undefined) throw new StoredDecisionUnreadable(check.checkTaskId, check.name, "names a check task that has no work_items row");
    const row = { ...check, taskSpec: spec.taskSpec };
    const decides = StoredDecidesSchema.safeParse(row.decides);
    if (!decides.success) throw new StoredDecisionUnreadable(row.checkTaskId, row.name, `records decides that do not parse: ${z.prettifyError(decides.error)}`);
    if (decides.data === null) continue;
    // eslint-disable-next-line no-restricted-syntax -- policy default: an absent task_spec holds no source, so every id the row decides throws StoredDecisionUnreadable below
    const sources = parseStoredTaskSpec(row.taskSpec)?.sources ?? [];
    // eslint-disable-next-line no-restricted-syntax -- policy default: a task not yet seen has no decided item yet; the accumulator's start
    const items = decided.get(row.taskId) ?? [];
    for (const id of decides.data) {
      const source = sources.find((each) => each.id === id);
      if (source === undefined) throw new StoredDecisionUnreadable(row.checkTaskId, row.name, `decides ${id}, which its check task's task_spec.sources does not hold`);
      if (!items.some((item) => item.type === source.type && item.id === source.id && item.text === source.text)) items.push(source);
    }
    decided.set(row.taskId, items);
  }
  return decided;
}

/**
 * The catalog grade (Finance's attemptGrade) of the model each of the project's tasks last
 * completed an attempt on. A task with no completed attempt that names its model is absent; one
 * whose model the catalog no longer holds under the attempt's provider is unrecorded, naming both.
 */
export async function completedAttemptGrades(db: DbHandle, projectId: string): Promise<Map<string, AttemptGrade>> {
  const tasks = await db.select({ id: workItems.id }).from(workItems).where(eq(workItems.projectId, projectId));
  const rows = await lastCompletedAttempts(db, tasks.map((task) => task.id));
  const grades = new Map<string, AttemptGrade>();
  for (const row of rows) {
    const model = z.string().min(1).parse(row.model);
    const provider = z.string().min(1).parse(row.provider);
    if (row.grade === null) {
      grades.set(row.taskId, { kind: "unrecorded", why: `its last completed attempt ran on ${model} from provider ${provider}, which the model catalog does not hold` });
      continue;
    }
    grades.set(row.taskId, { kind: "graded", model, grade: CapabilityLevelSchema.parse(row.grade) });
  }
  return grades;
}

/** How many client corrections the revision took in (correction_holds), as a selected column. */
export const answersTakenBy = (revisionId: AnyColumn) =>
  sql<unknown>`(SELECT count(*)::int FROM correction_holds ch WHERE ch.plan_revision_id = ${revisionId})`;

/** The answersTakenBy column did not read back as a count. */
class AnswersTakenUnreadable extends Error {
  constructor(
    readonly revisionId: string,
    readonly raw: unknown,
  ) {
    super(`plan revision ${revisionId}: the count of answers it took in read back as ${JSON.stringify(raw)}, not a non-negative integer`);
    this.name = "AnswersTakenUnreadable";
  }
}

/** The answersTakenBy column as a count; anything else throws. */
export function parseAnswersTaken(revisionId: string, raw: unknown): number {
  const parsed = z.number().int().min(0).safeParse(raw);
  if (!parsed.success) throw new AnswersTakenUnreadable(revisionId, raw);
  return parsed.data;
}

/** A revision was to be written that takes in neither a client's correction nor a repair: nothing asked for it. */
class RevisionCauseMissing extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly revision: number,
  ) {
    super(`plan revision ${revision} of project ${projectId} takes in no client correction and no repair; nothing is written`);
    this.name = "RevisionCauseMissing";
  }
}

/** What was read for the revision changed before it was written: nothing is written. */
class RevisionReadMoved extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly detail: string,
  ) {
    super(`plan revision of project ${projectId} not written: ${detail}`);
    this.name = "RevisionReadMoved";
  }
}

/** The revision's insert returned no row: nothing of it is recorded. */
class RevisionNotInserted extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly revision: number,
  ) {
    super(`plan revision ${revision} of project ${projectId} was not inserted: the INSERT returned no row`);
    this.name = "RevisionNotInserted";
  }
}

/** A revision would commit a new task with no owner from the project's latest roster. */
class RevisionTaskUnowned extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly taskIds: readonly string[],
  ) {
    super(`cannot record a plan revision of project ${projectId}: task(s) ${taskIds.join(", ")} have no owner from the latest roster`);
    this.name = "RevisionTaskUnowned";
  }
}

interface PlanRevisionRecord {
  readonly projectId: ProjectId;
  readonly revision: number;
  readonly visionVersion: number;
  /**
   * The client corrections the revision takes in, by the vision version each wrote in the order they
   * were recorded, with the message its report replies to and every key they affect; null for a plan repair.
   */
  readonly corrections: RevisionCorrections | null;
  /** The given-up tasks whose awaited repair the revision records; at least one for a plan repair. */
  readonly repaired: readonly string[];
  readonly summary: unknown;
  readonly events: readonly DomainEvent[];
}

/**
 * Runs the revision in one transaction with the project row locked (the answer, correction and
 * first-plan transactions lock it too): the project must still be active, awaiting a revision for
 * exactly the corrections it takes in (none, for a repair), every repair it records still awaited, on
 * the same vision version, with no stop awaiting the Liaison and no task in progress (for a
 * correction, none citing a key it affects). `fn` supersedes and writes the items; then every task
 * must have a roster owner, and the revision, its domain events, the corrections and repairs it took
 * in and the reset attempts are written. A revision that takes in no correction and no repair throws
 * RevisionCauseMissing: nothing asked for it. A moved read, or an item that left the status it was
 * read in, writes nothing and returns "moved".
 */
export async function withPlanRevisionTransaction(
  db: Database,
  record: PlanRevisionRecord,
  fn: (workItemRepo: WorkItemRowRepository, tx: DbHandle) => Promise<void>,
  logger: Logger,
): Promise<"written" | "moved"> {
  const { projectId } = record;
  const { corrections } = record;
  if (corrections === null && record.repaired.length === 0) throw new RevisionCauseMissing(projectId, record.revision);
  const versions: readonly number[] = corrections === null ? [] : corrections.versions;
  try {
    await db.transaction(async (tx) => {
      const [locked] = await tx
        .select({ lifecycle: projects.lifecycle })
        .from(projects)
        .where(eq(projects.id, projectId))
        .for("update");
      if (!locked) throw new RevisionReadMoved(projectId, "the project does not exist");
      // Read after the lock, in its own statement: a halt committed while the lock was awaited is seen.
      const [atWork] = await tx.select({ id: projects.id }).from(projects).where(and(eq(projects.id, projectId), projectAtWork()));
      if (!atWork) throw new RevisionReadMoved(projectId, `the project is ${locked.lifecycle === "active" ? "blocked" : locked.lifecycle}`);
      // The answer and correction transactions lock the project row too: no correction joins this set meanwhile.
      const awaited = (await awaitedCorrections(tx, projectId)).map((correction) => correction.visionVersion);
      if (awaited.join(",") !== versions.join(",")) {
        const named = (list: readonly number[]) => (list.length === 0 ? "none" : list.map((version) => `v${version}`).join(", "));
        throw new RevisionReadMoved(projectId, `the revision is awaited for the correction(s) of vision ${named(awaited)}, not ${named(versions)}`);
      }
      if (record.repaired.length > 0) {
        const awaited = await tx
          .select({ id: planRepairs.workItemId })
          .from(planRepairs)
          .where(and(eq(planRepairs.projectId, projectId), isNull(planRepairs.planRevisionId), inArray(planRepairs.workItemId, [...record.repaired])));
        if (awaited.length !== record.repaired.length) {
          throw new RevisionReadMoved(projectId, `the repair of ${record.repaired.join(", ")} is no longer awaited`);
        }
      }
      const [stopFree] = await tx.select({ id: projects.id }).from(projects).where(and(eq(projects.id, projectId), noOpenStop(projects.id)));
      if (!stopFree) throw new RevisionReadMoved(projectId, "a stop awaits the Liaison");
      const [current] = await tx.select({ version: currentVisionVersion(projects.id) }).from(projects).where(eq(projects.id, projectId));
      if (!current) throw new RevisionReadMoved(projectId, "the project does not exist");
      const version = z.number().int().positive().nullable().parse(current.version);
      if (version !== record.visionVersion) {
        throw new RevisionReadMoved(projectId, `planned from vision v${record.visionVersion}, current is v${version ?? "none"}`);
      }
      // A correction's revision replaces only the work citing a key it affects, so it waits only for that.
      const held = corrections === null ? sql`TRUE` : citesAnyOf(sql`${`{${corrections.affected.join(",")}}`}::text[]`);
      const inProgress = await tx.execute(sql`SELECT w.id FROM work_items w
        WHERE w.project_id = ${projectId} AND w.level = 'Task' AND w.status = 'InProgress' AND ${held} LIMIT 1`);
      const [running] = z.array(z.object({ id: z.string() })).parse(inProgress.rows);
      if (running) throw new RevisionReadMoved(projectId, `task ${running.id} is in progress`);
      // An Epic is not an attempt: it is superseded with its open tasks (supersedeWorkItem).

      await fn(new WorkItemRowRepository(tx), tx);

      const unowned = await tasksWithoutRosterOwnerAmongOpen(tx, projectId);
      if (unowned.length > 0) throw new RevisionTaskUnowned(projectId, unowned);
      const [written] = await tx
        .insert(planRevisions)
        .values({
          projectId,
          revision: record.revision,
          visionVersion: record.visionVersion,
          requestedBy: corrections === null ? null : corrections.requestedBy,
          kind: corrections === null ? "repair" : "client_change",
          summary: record.summary,
        })
        .returning({ id: planRevisions.id });
      if (!written) throw new RevisionNotInserted(projectId, record.revision);
      if (versions.length > 0) {
        await tx
          .update(correctionHolds)
          .set({ planRevisionId: written.id })
          .where(and(eq(correctionHolds.projectId, projectId), isNull(correctionHolds.planRevisionId), inArray(correctionHolds.visionVersion, [...versions])));
      }
      if (record.repaired.length > 0) {
        await tx
          .update(planRepairs)
          .set({ planRevisionId: written.id })
          .where(and(eq(planRepairs.projectId, projectId), isNull(planRepairs.planRevisionId), inArray(planRepairs.workItemId, [...record.repaired])));
      }
      for (const event of record.events) await insertEvent(tx, event);
      await revisionWritten(tx, projectId);
    });
  } catch (err) {
    if (!(err instanceof RevisionReadMoved) && !(err instanceof InvalidStatusTransition)) throw err;
    logger.info("delivery.revision-moved", `revision ${record.revision} not written, retried next cycle: ${err.message}`, { projectId, revision: record.revision });
    return "moved";
  }
  return "written";
}

/**
 * The open tasks lacking a roster owner. Superseded and completed work is history: a task planned
 * before owners were assigned stays as it is.
 */
async function tasksWithoutRosterOwnerAmongOpen(db: DbHandle, projectId: ProjectId): Promise<string[]> {
  const unowned = new Set(await tasksWithoutRosterOwner(db, projectId));
  if (unowned.size === 0) return [];
  const open = await db
    .select({ id: workItems.id })
    .from(workItems)
    .where(and(eq(workItems.projectId, projectId), inArray(workItems.status, IDLE_OPEN_WORK_ITEM_STATUSES)));
  return open.map((row) => row.id).filter((id) => unowned.has(id));
}

/** The project was expected to await a revision and does not. */
class ProjectNotAwaitingReplan extends Error {
  constructor(readonly projectId: ProjectId) {
    super(`cannot record a failed plan revision attempt: project ${projectId} is not an active project awaiting one`);
    this.name = "ProjectNotAwaitingReplan";
  }
}

/** Counts one failed attempt to revise the plan, with its error and whose failure it was; returns the count after it. */
export async function recordReplanFailure(db: DbHandle, projectId: ProjectId, error: string, failure: "model" | "provider"): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).for("update");
    const [awaiting] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), projectAtWork(), sql`(${pendingCorrection(projects.id)} OR ${pendingRepair(projects.id)})`));
    if (!awaiting) throw new ProjectNotAwaitingReplan(projectId);
    return countReplanFailure(tx, projectId, error, failure);
  });
}

/** A revision of the plan the client has not been told about. */
export interface DuePlanRevision {
  readonly revisionId: string;
  readonly projectId: ProjectId;
  readonly revision: number;
  /** plan_revisions.summary as stored; Engagement parses it. */
  readonly summary: unknown;
  /** The client corrections recorded as taken in by it (correction_holds); Engagement checks the summary names each. */
  readonly answersTaken: number;
}

/**
 * Plan revisions the client has not been told about (Engagement's told record), oldest first. Only
 * an active project's: a report saying what the team will now do is not posted while the project is
 * stopped, nor while a stop awaits the Liaison, nor while it is halted for any cause but the
 * deployment's spend cap (projectReportsPlans); such a halted project's revision is reported once it
 * resumes. A revision written before the project's first plan was reported is not listed here:
 * that report describes it (listDuePlanReports), so the client never reads a revision of a plan it
 * was not told about. A revision whose row does not read is its UnreadSubject (readEach).
 */
export async function listDuePlanRevisionReports(db: DbHandle): Promise<Array<DuePlanRevision | UnreadSubject>> {
  const rows = await db
    .select({
      id: planRevisions.id,
      projectId: planRevisions.projectId,
      revision: planRevisions.revision,
      summary: planRevisions.summary,
      answersTaken: answersTakenBy(planRevisions.id),
    })
    .from(planRevisions)
    .innerJoin(projects, eq(projects.id, planRevisions.projectId))
    .where(
      and(
        sql`NOT ${planRevisionTold(planRevisions.id)}`,
        projectReportsPlans(),
        noOpenStop(projects.id),
        firstPlanTold(projects.id),
      ),
    )
    .orderBy(asc(planRevisions.createdAt), asc(planRevisions.id));
  return readEach(
    rows,
    (row) => ({ id: row.id, projectId: parseProjectId(row.projectId, "plan_revisions.project_id") }),
    (row) => ({
      revisionId: row.id,
      projectId: parseProjectId(row.projectId, "plan_revisions.project_id"),
      revision: row.revision,
      summary: row.summary,
      answersTaken: parseAnswersTaken(row.id, row.answersTaken),
    }),
  );
}

/** A plan revision as its report is posted: its project and the client message whose correction it took in (null for a repair). */
export interface PlanRevisionToTell {
  readonly revisionId: string;
  readonly projectId: string;
  readonly requestedBy: string | null;
}

/** A report was asked to be posted for a plan revision that does not exist. */
class PlanRevisionNotFound extends Error {
  constructor(readonly revisionId: string) {
    super(`cannot post a report on plan revision ${revisionId}: no such plan_revisions row`);
    this.name = "PlanRevisionNotFound";
  }
}

/**
 * A plan revision as its report is told: its project and the earliest client message whose
 * correction it took in, which the report replies to (null for a plan repair, which no client asked
 * for). An id with no revision throws.
 */
export async function planRevisionToTell(
  db: DbHandle,
  revisionId: string,
): Promise<PlanRevisionToTell> {
  const [revision] = await db
    .select({ projectId: planRevisions.projectId, requestedBy: planRevisions.requestedBy })
    .from(planRevisions)
    .where(eq(planRevisions.id, revisionId));
  if (!revision) throw new PlanRevisionNotFound(revisionId);
  return { revisionId, ...revision };
}
