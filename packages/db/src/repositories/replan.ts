import { and, asc, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { InvalidStatusTransition, parseProjectId, type DomainEvent, type ProjectId } from "@ashara/shared";
import type { Database, DbHandle } from "../connection.js";
import { clientMessages, domainEvents, planRevisions, projects, visionDocuments, workItems } from "../schema.js";
import { ContractRepository } from "./contract.js";
import { noOpenAnswer, tasksWithoutRosterOwner } from "./first-plan.js";
import type { PlanningTransactionRepos } from "./planning-transaction.js";
import { noOpenStop } from "./project.js";
import { WorkItemRepository } from "./work-item.js";

// Delivery's revisions of a plan under way (migration 042). A project awaits a revision while
// it is active, planned, flagged by a client answer (migration 038), has no task in progress,
// no unread answer and no stop awaiting the Liaison. Only a Task has a live attempt: an Epic is
// InProgress from its first started task until every child settles, so a plan under way always
// has one, and counting it would keep a flagged project from ever being revised. A revision
// supersedes the open work, writes the new work, records itself and clears the flag in one
// transaction.

interface ProjectAwaitingReplanRow {
  readonly projectId: ProjectId;
  readonly projectName: string;
  readonly requestedBy: string;
  readonly replanAttempts: number;
  readonly replanLastError: string | null;
  readonly revisionsSinceReview: number;
  readonly nextRevision: number;
  readonly vision: typeof visionDocuments.$inferSelect;
}

const CountsSchema = z.object({
  revisionsSinceReview: z.number().int().min(0),
  nextRevision: z.number().int().min(2),
});

/**
 * Flagged projects ready to be revised, oldest first, each with its current vision. One
 * statement, so a project and the vision it is listed with are read from the same snapshot.
 * `revisionsSinceReview` counts the revisions written after the operator last ended a
 * replan_bound block, every revision when none was.
 */
export async function listProjectsAwaitingReplan(db: DbHandle): Promise<ProjectAwaitingReplanRow[]> {
  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      requestedBy: projects.replanRequestedBy,
      replanAttempts: projects.replanAttempts,
      replanLastError: projects.replanLastError,
      revisionsSinceReview: sql<unknown>`(SELECT count(*)::int FROM plan_revisions r WHERE r.project_id = projects.id
        AND r.created_at > COALESCE((SELECT max(b.ended_at) FROM project_blocks b WHERE b.project_id = projects.id
          AND b.kind = 'replan_bound' AND b.end_kind = 'unblocked'), '-infinity'::timestamptz))`,
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
        eq(projects.status, "active"),
        isNotNull(projects.firstPlannedAt),
        isNotNull(projects.replanRequestedBy),
        noOpenStop(projects.id),
        noOpenAnswer(),
        sql`NOT EXISTS (SELECT 1 FROM work_items w WHERE w.project_id = projects.id AND w.level = 'Task' AND w.status = 'InProgress')`,
      ),
    )
    .orderBy(asc(projects.createdAt), asc(projects.id));

  return rows.flatMap((row) => {
    if (row.requestedBy === null) return [];
    const counts = CountsSchema.parse({ revisionsSinceReview: row.revisionsSinceReview, nextRevision: row.nextRevision });
    return [
      {
        projectId: parseProjectId(row.id, "projects.id"),
        projectName: row.name,
        requestedBy: row.requestedBy,
        replanAttempts: row.replanAttempts,
        replanLastError: row.replanLastError,
        ...counts,
        vision: row.vision,
      },
    ];
  });
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
  readonly requestedBy: string;
  readonly summary: unknown;
  readonly events: readonly DomainEvent[];
}

/**
 * Runs the revision in one transaction with the project row locked (the answer and first-plan
 * transactions lock it too): the project must still be active, flagged by the same answer, on
 * the same vision version, with no task in progress and no stop awaiting the Liaison. `fn`
 * supersedes and writes the items; then every task must have a roster owner, and the revision,
 * its domain events, the cleared flag and the reset attempts are written. A moved read, or an
 * item that left the status it was read in, writes nothing and returns "moved".
 */
export async function withPlanRevisionTransaction(
  db: Database,
  record: PlanRevisionRecord,
  fn: (repos: PlanningTransactionRepos) => Promise<void>,
): Promise<"written" | "moved"> {
  const { projectId } = record;
  try {
    await db.transaction(async (tx) => {
      const [locked] = await tx
        .select({ status: projects.status, requestedBy: projects.replanRequestedBy })
        .from(projects)
        .where(eq(projects.id, projectId))
        .for("update");
      if (!locked) throw new RevisionReadMoved(projectId, "the project does not exist");
      if (locked.status !== "active") throw new RevisionReadMoved(projectId, `the project is ${locked.status}`);
      if (locked.requestedBy !== record.requestedBy) {
        throw new RevisionReadMoved(projectId, `replanning is requested by ${locked.requestedBy ?? "nothing"}, not ${record.requestedBy}`);
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

      await fn({ workItemRepo: new WorkItemRepository(tx), contractRepo: new ContractRepository(tx) });

      const unowned = await tasksWithoutRosterOwnerAmongOpen(tx, projectId);
      if (unowned.length > 0) throw new RevisionTaskUnowned(projectId, unowned);
      await tx.insert(planRevisions).values({
        projectId,
        revision: record.revision,
        visionVersion: record.visionVersion,
        requestedBy: record.requestedBy,
        summary: record.summary,
      });
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
        .set({ replanRequestedBy: null, replanAttempts: 0, replanLastError: null })
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
    .where(and(eq(projects.id, projectId), eq(projects.status, "active"), isNotNull(projects.replanRequestedBy)))
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
}

/**
 * Plan revisions the client has not been told about, oldest first. A project the client
 * stopped, or that has a stop awaiting the Liaison, is not reported on.
 */
export async function listDuePlanRevisionReports(db: DbHandle): Promise<DuePlanRevisionRow[]> {
  const rows = await db
    .select({ id: planRevisions.id, projectId: planRevisions.projectId, revision: planRevisions.revision, summary: planRevisions.summary })
    .from(planRevisions)
    .innerJoin(projects, eq(projects.id, planRevisions.projectId))
    .where(and(isNull(planRevisions.reportId), sql`${projects.status} <> 'stopped'`, noOpenStop(projects.id)))
    .orderBy(asc(planRevisions.createdAt), asc(planRevisions.id));
  return rows.map((row) => ({
    revisionId: row.id,
    projectId: parseProjectId(row.projectId, "plan_revisions.project_id"),
    revision: row.revision,
    summary: row.summary,
  }));
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
 * Posts the Liaison's one report on a plan revision, in reply to the answer that asked for it,
 * and records it on the revision in the same transaction; a revision already reported on gets
 * nothing new.
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
