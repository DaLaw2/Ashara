import { and, asc, desc, eq, inArray, isNotNull, isNull, sql, type AnyColumn } from "drizzle-orm";
import { z } from "zod";
import { parseProjectId, readEach, type DomainEvent, type ProjectId, type UnreadSubject } from "@ashara/shared";
import type { Database, DbHandle } from "@ashara/db";
import { clientMessages, domainEvents, planRepairs, planRevisions, projects, replanRequests, visionDocuments, workItems, noOpenAnswer, noOpenStop, pendingChange, pendingRepair, projectAtWork } from "@ashara/db";
import { InvalidStatusTransition } from "../work-item-language/transitions.js";
import { tasksWithoutRosterOwner } from "./first-plan.js";
import { WorkItemRowRepository } from "./work-item.js";

// Delivery's revisions of a plan under way (migration 042). A project awaits a revision while
// it is active, planned, awaiting the revision for a client answer that changed an assumption
// (replan_requests, migration 052) or the repair of a task the failure router gave up
// (plan_repairs, migration 045), has no task in progress, no
// unread answer and no stop awaiting the Liaison. Only a Task has a live attempt: an Epic is
// InProgress from its first started task until every child settles, so a plan under way always
// has one, and counting it would keep a flagged project from ever being revised. A revision
// supersedes the open work, writes the new work, records itself and records every answer and
// repair it takes in, in one transaction.

interface ProjectAwaitingReplanRow {
  readonly projectId: ProjectId;
  readonly projectName: string;
  /** The client answers whose revision the project awaits (replan_requests), oldest first; empty when none. */
  readonly changesAwaited: readonly string[];
  /** The tasks the failure router gave up whose repair the project awaits, oldest first; empty when none. */
  readonly repairsAwaited: readonly string[];
  readonly replanAttempts: number;
  readonly replanLastError: string | null;
  readonly revisionsSinceReview: number;
  readonly repairsSinceReview: number;
  readonly nextRevision: number;
  readonly vision: typeof visionDocuments.$inferSelect;
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
      replanAttempts: projects.replanAttempts,
      replanLastError: projects.replanLastError,
      revisionsSinceReview: revisionsSince("client_change", "replan_bound"),
      repairsSinceReview: revisionsSince("repair", "plan_repair"),
      nextRevision: sql<unknown>`(SELECT COALESCE(max(r.revision), 1) + 1 FROM plan_revisions r WHERE r.project_id = projects.id)`,
      vision: visionDocuments,
    })
    .from(projects)
    .innerJoin(
      visionDocuments,
      and(
        eq(visionDocuments.projectId, projects.id),
        sql`${visionDocuments.version} = (SELECT MAX(v.version) FROM vision_documents v WHERE v.project_id = projects.id)`,
      ),
    )
    .where(
      and(
        projectAtWork(),
        isNotNull(projects.firstPlannedAt),
        sql`(${pendingChange(projects.id)} OR ${pendingRepair(projects.id)})`,
        noOpenStop(projects.id),
        noOpenAnswer(),
        sql`NOT EXISTS (SELECT 1 FROM work_items w WHERE w.project_id = projects.id AND w.level = 'Task' AND w.status = 'InProgress')`,
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
        changesAwaited: await awaitedAnswers(db, row.id),
        repairsAwaited: awaited.map((repair) => repair.id),
        replanAttempts: row.replanAttempts,
        replanLastError: row.replanLastError,
        ...counts,
        vision: row.vision,
      };
    },
  );
}

/** The answers whose revision the project awaits, in the order the client sent them. */
async function awaitedAnswers(db: DbHandle, projectId: string): Promise<string[]> {
  const rows = await db
    .select({ id: replanRequests.answerId })
    .from(replanRequests)
    .innerJoin(clientMessages, eq(clientMessages.id, replanRequests.answerId))
    .where(and(eq(replanRequests.projectId, projectId), isNull(replanRequests.planRevisionId)))
    .orderBy(asc(clientMessages.createdAt), asc(clientMessages.id));
  return rows.map((row) => row.id);
}

/** How many client answers the revision took in (replan_requests, migration 052), as a selected column. */
export const answersTakenBy = (revisionId: AnyColumn) =>
  sql<unknown>`(SELECT count(*)::int FROM replan_requests rr WHERE rr.plan_revision_id = ${revisionId})`;

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

/** A revision was to be written that takes in neither a client's answer nor a repair: nothing asked for it. */
class RevisionCauseMissing extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly revision: number,
  ) {
    super(`plan revision ${revision} of project ${projectId} takes in no client answer and no repair; nothing is written`);
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
  /** The client answers the revision takes in, in the order the client sent them; empty for a plan repair. */
  readonly answers: readonly string[];
  /** The given-up tasks whose awaited repair the revision records; at least one for a plan repair. */
  readonly repaired: readonly string[];
  readonly summary: unknown;
  readonly events: readonly DomainEvent[];
}

/**
 * Runs the revision in one transaction with the project row locked (the answer and first-plan
 * transactions lock it too): the project must still be active, awaiting a revision for exactly the
 * answers it takes in (none, for a repair), every repair it records still awaited, on the same vision version, with no
 * task in progress and no stop awaiting the Liaison. `fn` supersedes and writes the items; then
 * every task must have a roster owner, and the revision, its domain events, the answers and
 * repairs it took in and the reset attempts are written. A revision that takes in no answer and
 * no repair throws RevisionCauseMissing: nothing asked for it. A moved read, or an item that left the
 * status it was read in, writes nothing and returns "moved".
 */
export async function withPlanRevisionTransaction(
  db: Database,
  record: PlanRevisionRecord,
  fn: (workItemRepo: WorkItemRowRepository) => Promise<void>,
): Promise<"written" | "moved"> {
  const { projectId } = record;
  if (record.answers.length === 0 && record.repaired.length === 0) throw new RevisionCauseMissing(projectId, record.revision);
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
      // The answer transaction locks the project row too: no answer is added to this set meanwhile.
      const awaited = await awaitedAnswers(tx, projectId);
      if (awaited.join(",") !== record.answers.join(",")) {
        throw new RevisionReadMoved(
          projectId,
          `the revision is awaited for answer(s) ${awaited.join(", ") || "none"}, not ${record.answers.join(", ") || "none"}`,
        );
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
      const [current] = await tx
        .select({ version: visionDocuments.version })
        .from(visionDocuments)
        .where(eq(visionDocuments.projectId, projectId))
        .orderBy(desc(visionDocuments.version))
        .limit(1);
      if (current?.version !== record.visionVersion) {
        throw new RevisionReadMoved(projectId, `planned from vision v${record.visionVersion}, current is v${current?.version ?? "none"}`);
      }
      const [running] = await tx
        .select({ id: workItems.id })
        .from(workItems)
        .where(and(eq(workItems.projectId, projectId), eq(workItems.level, "Task"), eq(workItems.status, "InProgress")))
        .limit(1);
      if (running) throw new RevisionReadMoved(projectId, `task ${running.id} is in progress`);
      // An Epic is not an attempt: it is superseded with its open tasks (supersedeWorkItem).

      await fn(new WorkItemRowRepository(tx));

      const unowned = await tasksWithoutRosterOwnerAmongOpen(tx, projectId);
      if (unowned.length > 0) throw new RevisionTaskUnowned(projectId, unowned);
      const [repliedTo] = record.answers;
      const [written] = await tx
        .insert(planRevisions)
        .values({
          projectId,
          revision: record.revision,
          visionVersion: record.visionVersion,
          requestedBy: repliedTo ?? null,
          kind: repliedTo === undefined ? "repair" : "client_change",
          summary: record.summary,
        })
        .returning({ id: planRevisions.id });
      if (!written) throw new RevisionNotInserted(projectId, record.revision);
      if (record.answers.length > 0) {
        await tx
          .update(replanRequests)
          .set({ planRevisionId: written.id })
          .where(and(eq(replanRequests.projectId, projectId), isNull(replanRequests.planRevisionId), inArray(replanRequests.answerId, [...record.answers])));
      }
      if (record.repaired.length > 0) {
        await tx
          .update(planRepairs)
          .set({ planRevisionId: written.id })
          .where(and(eq(planRepairs.projectId, projectId), isNull(planRepairs.planRevisionId), inArray(planRepairs.workItemId, [...record.repaired])));
      }
      for (const event of record.events) {
        await tx.insert(domainEvents).values({
          eventId: event.eventId,
          eventType: event.eventType,
          timestamp: event.timestamp,
          sourceContext: event.sourceContext,
          correlationId: event.correlationId ?? null,
          payload: event.payload,
        });
      }
      await tx
        .update(projects)
        .set({ replanAttempts: 0, replanLastError: null })
        .where(eq(projects.id, projectId));
    });
  } catch (err) {
    if (!(err instanceof RevisionReadMoved) && !(err instanceof InvalidStatusTransition)) throw err;
    console.warn(`[replan] project ${projectId}: revision ${record.revision} not written, retried next cycle: ${err.message}`);
    return "moved";
  }
  return "written";
}

/**
 * The open tasks lacking a roster owner. Superseded and completed work is history: a task planned
 * before owners were assigned (migration 031) stays as it is.
 */
async function tasksWithoutRosterOwnerAmongOpen(db: DbHandle, projectId: ProjectId): Promise<string[]> {
  const unowned = new Set(await tasksWithoutRosterOwner(db, projectId));
  if (unowned.size === 0) return [];
  const open = await db
    .select({ id: workItems.id })
    .from(workItems)
    .where(and(eq(workItems.projectId, projectId), sql`${workItems.status} IN ('Pending', 'Blocked', 'Failed')`));
  return open.map((row) => row.id).filter((id) => unowned.has(id));
}

/** The project was expected to await a revision and does not. */
class ProjectNotAwaitingReplan extends Error {
  constructor(readonly projectId: ProjectId) {
    super(`cannot record a failed plan revision attempt: project ${projectId} is not an active project awaiting one`);
    this.name = "ProjectNotAwaitingReplan";
  }
}

/** Counts one failed attempt to revise the plan, with its error; returns the count after it. */
export async function recordReplanFailure(db: DbHandle, projectId: ProjectId, error: string): Promise<number> {
  const [row] = await db
    .update(projects)
    .set({ replanAttempts: sql`${projects.replanAttempts} + 1`, replanLastError: error })
    .where(
      and(
        eq(projects.id, projectId),
        projectAtWork(),
        sql`(${pendingChange(projects.id)} OR ${pendingRepair(projects.id)})`,
      ),
    )
    .returning({ replanAttempts: projects.replanAttempts });
  if (!row) throw new ProjectNotAwaitingReplan(projectId);
  return row.replanAttempts;
}

interface DuePlanRevisionRow {
  readonly revisionId: string;
  readonly projectId: ProjectId;
  readonly revision: number;
  /** plan_revisions.summary as stored; Engagement parses it. */
  readonly summary: unknown;
  /** The client answers recorded as taken in by it (replan_requests); Engagement checks the summary names each. */
  readonly answersTaken: number;
}

/**
 * Plan revisions the client has not been told about, oldest first. Only an active project's: a
 * report saying what the team will now do is not posted while the project is halted or stopped,
 * nor while a stop awaits the Liaison; a halted project's revision is reported once it
 * resumes. A revision written before the project's first plan was reported is not listed here:
 * that report describes it (listDuePlanReports), so the client never reads a revision of a plan it
 * was not told about. A revision whose row does not read is its UnreadSubject (readEach).
 */
export async function listDuePlanRevisionReports(db: DbHandle): Promise<Array<DuePlanRevisionRow | UnreadSubject>> {
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
        isNull(planRevisions.reportId),
        projectAtWork(),
        noOpenStop(projects.id),
        sql`EXISTS (SELECT 1 FROM client_messages m WHERE m.project_id = ${projects.id} AND m.reports_on = 'first-plan')`,
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

/** A report was asked to be posted for a plan revision that does not exist. */
class PlanRevisionNotFound extends Error {
  constructor(readonly revisionId: string) {
    super(`cannot post a report on plan revision ${revisionId}: no such plan_revisions row`);
    this.name = "PlanRevisionNotFound";
  }
}

/** The report's insert returned no row: nothing is recorded on the revision. */
class PlanRevisionReportNotInserted extends Error {
  constructor(readonly revisionId: string) {
    super(`the report on plan revision ${revisionId} was not inserted: the INSERT returned no row`);
    this.name = "PlanRevisionReportNotInserted";
  }
}

/**
 * Posts the Liaison's one report on a plan revision, in reply to the earliest answer it took in (in
 * reply to nothing for a plan repair, which no answer asked for), and records it on the revision in
 * the same transaction; a revision already reported on gets nothing new.
 */
export async function postPlanRevisionReport(db: DbHandle, revisionId: string, body: string): Promise<"posted" | "already-posted"> {
  return db.transaction(async (tx) => {
    const [revision] = await tx
      .select({ projectId: planRevisions.projectId, requestedBy: planRevisions.requestedBy, reportId: planRevisions.reportId })
      .from(planRevisions)
      .where(eq(planRevisions.id, revisionId))
      .for("update");
    if (!revision) throw new PlanRevisionNotFound(revisionId);
    if (revision.reportId !== null) return "already-posted";
    const [message] = await tx
      .insert(clientMessages)
      .values({ projectId: revision.projectId, direction: "outbound", kind: "report", body, inReplyTo: revision.requestedBy })
      .returning({ id: clientMessages.id });
    if (!message) throw new PlanRevisionReportNotInserted(revisionId);
    await tx.update(planRevisions).set({ reportId: message.id }).where(eq(planRevisions.id, revisionId));
    return "posted";
  });
}
