import { SQL, and, asc, eq, inArray, isNotNull, sql, type AnyColumn } from "drizzle-orm";
import { clientMessages, projects, qualifiedColumn } from "@ashara/db";
import type { DbHandle } from "@ashara/db";
import { projectHalted, projectHaltedOnModelWork } from "@ashara/delivery/predicates";
import { REPORT_SUBJECT } from "./report-subjects.js";

// Engagement's published predicates: the facts about a project's engagement lifecycle and the
// client's messages that other contexts read the shared tables by. Each is spelled here once; a
// reader in another context imports it (`@ashara/engagement/predicates`) instead of writing the SQL
// again. A halt is Delivery's, read in its published predicates. This module imports nothing else
// of Engagement but its report-subject vocabulary, which imports nothing, so a context Engagement
// reads can import it without a cycle at load time.

/** Engagement's lifecycle is 'active': neither stopped by the client nor accepted, halted or not. */
export const projectActive = (): SQL => sql`${qualifiedColumn(projects.lifecycle)} = 'active'`;

/**
 * The project is at work: Engagement's lifecycle is 'active' (its lifecycle guard is the column's
 * only writer) and Delivery has not halted it. What every reader that gates, plans, takes in or
 * reports on work admits.
 */
export const projectAtWork = (): SQL => sql`(${projectActive()} AND NOT ${projectHalted(projects.id)})`;

/**
 * The project reads the client's answers and changes: Engagement's lifecycle is 'active', halted or
 * not, since a halt pauses the work and never the reading of what the client said; except under a
 * halt on the project's model work (projectHaltedOnModelWork), which the reading's own model call
 * cannot get past: a budget halt refuses it, and a model's or provider's failure would charge it an
 * attempt for meeting that failure again. Whether the work resumes stays with the halt's own exits.
 */
export const projectReadsClientInput = (): SQL => sql`(${projectActive()} AND NOT ${projectHaltedOnModelWork(projects.id)})`;

/**
 * True while the project has no inbound stop the Liaison has yet to consume.
 * The Liaison consumes stops once per cycle, at its top; a stop the client sends later in the cycle
 * must already hold, so every reader that admits only active projects to take in, plan, report on
 * or dispatch also requires this. A stop committed before such a read is honoured by it.
 */
export const noOpenStop = (projectId: AnyColumn | SQL): SQL =>
  sql`NOT EXISTS (SELECT 1 FROM client_messages s WHERE s.project_id = ${projectId}
    AND s.direction = 'inbound' AND s.kind = 'stop' AND s.consumed_at IS NULL)`;

/** No answer the Liaison has yet to read: one may change the vision, so the project is planned once its answers are in. */
export const noOpenAnswer = (): SQL =>
  sql`NOT EXISTS (SELECT 1 FROM client_messages a WHERE a.project_id = projects.id
    AND a.direction = 'inbound' AND a.kind = 'answer' AND a.consumed_at IS NULL)`;

/** The Liaison's report of the project's first plan (reports_on 'first-plan') is posted. */
export const firstPlanTold = (projectId: AnyColumn): SQL =>
  sql`EXISTS (SELECT 1 FROM client_messages fr WHERE fr.project_id = ${qualifiedColumn(projectId)} AND fr.reports_on = ${REPORT_SUBJECT.firstPlan})`;

/**
 * The project's first plan is written and the Liaison's report of it is not yet posted. Its dispatch
 * is held until the report is: the report tells the client that none of the plan's tasks has
 * started, and refuses to be posted once one has, so a task dispatched while a faulted post waits
 * for its retry would leave the plan unreportable and the project blocked.
 */
export const firstPlanUnreported = (): SQL =>
  sql`(${qualifiedColumn(projects.firstPlannedAt)} IS NOT NULL AND NOT ${firstPlanTold(projects.id)})`;

/** The subjects the Liaison keeps a told record of (told_reports), each told once. */
const TOLD_SUBJECT_KINDS = ["project-blocked", "project-resumed", "delivered", "plan-revision"] as const;
export type ToldSubjectKind = (typeof TOLD_SUBJECT_KINDS)[number];

/** The report on the subject `subjectId` of `kind` is posted: its told record is on file. */
export const reportTold = (kind: ToldSubjectKind, subjectId: AnyColumn | SQL): SQL =>
  sql`EXISTS (SELECT 1 FROM told_reports tr WHERE tr.subject_kind = ${kind} AND tr.subject_id = ${subjectId instanceof SQL ? subjectId : qualifiedColumn(subjectId)})`;

/** The halt episode's own report is posted. Delivery resumes an infrastructure halt only once it is. */
export const haltReported = (episodeId: AnyColumn | SQL): SQL => reportTold("project-blocked", episodeId);

/** The plan revision's report is posted: its own, or the first-plan report that described it. */
export const planRevisionTold = (revisionId: AnyColumn | SQL): SQL => reportTold("plan-revision", revisionId);

/** The Liaison's report on the project's planning-stopped outcome (reports_on 'planning-stopped') is posted. */
export const planningStoppedTold = (projectId: AnyColumn): SQL =>
  sql`EXISTS (SELECT 1 FROM client_messages ps WHERE ps.project_id = ${qualifiedColumn(projectId)} AND ps.reports_on = ${REPORT_SUBJECT.planningStopped})`;

/** The words of each client message `ids` names that exists. */
export async function clientMessageBodies(db: DbHandle, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select({ id: clientMessages.id, body: clientMessages.body }).from(clientMessages).where(inArray(clientMessages.id, [...ids]));
  return new Map(rows.map((row) => [row.id, row.body]));
}

/** A consumed stop as a reader's filter names it: its id, an SQL expression over the stop the read is of. */
export interface StopRef {
  readonly id: SQL;
}

/**
 * Every consumed stop that stopped its project, the project still stopped, that `where` admits,
 * earliest consumed first. The stop that stopped the project is the one that records it
 * (stop_found_halted), or, on a stop that records nothing of it, the one its stop report answers; a
 * second stop of a project already stopped stopped nothing.
 */
export async function stopsThatStopped(db: DbHandle, where: (stop: StopRef) => SQL | undefined): Promise<Array<{ readonly stopId: string; readonly projectId: string }>> {
  return db
    .select({ stopId: clientMessages.id, projectId: clientMessages.projectId })
    .from(clientMessages)
    .innerJoin(projects, eq(projects.id, clientMessages.projectId))
    .where(
      and(
        eq(clientMessages.direction, "inbound"),
        eq(clientMessages.kind, "stop"),
        isNotNull(clientMessages.consumedAt),
        eq(projects.lifecycle, "stopped"),
        sql`(${clientMessages.stopFoundHalted} IS NOT NULL OR EXISTS (SELECT 1 FROM client_messages r WHERE r.in_reply_to = ${clientMessages.id} AND r.reports_on = ${REPORT_SUBJECT.clientStop}))`,
        where({ id: qualifiedColumn(clientMessages.id) }),
      ),
    )
    .orderBy(asc(clientMessages.consumedAt), asc(clientMessages.id));
}
