import { SQL, sql, type AnyColumn } from "drizzle-orm";
import { projects, qualifiedColumn } from "@ashara/db";
import { firstPlanned, HALT_KINDS, projectHalted, projectHaltedOn, type HaltKind } from "@ashara/delivery/predicates";
import { CLOSED_LIFECYCLES, inboundDecision, type InboundKind, type InboundState } from "./inbound-policy.js";
import { REPORT_SUBJECT } from "./report-subjects.js";

// Engagement's published predicates: the facts about a project's engagement lifecycle and the
// client's messages that other contexts read the shared tables by. Each is spelled here once; a
// reader in another context imports it (`@ashara/engagement/predicates`) instead of writing the SQL
// again. A halt is Delivery's, read in its published predicates. This module imports nothing else
// of Engagement but its report-subject vocabulary and its inbound-message decision, which import
// nothing of it, so a context Engagement reads can import it without a cycle at load time.

/** Engagement's lifecycle is 'active': neither stopped by the client nor accepted, halted or not. */
export const projectActive = (): SQL => sql`${qualifiedColumn(projects.lifecycle)} = 'active'`;

/**
 * The project is at work: Engagement's lifecycle is 'active' (its lifecycle guard is the column's
 * only writer) and Delivery has not halted it. What every reader that gates, plans, takes in or
 * reports on work admits.
 */
export const projectAtWork = (): SQL => sql`(${projectActive()} AND NOT ${projectHalted(projects.id)})`;

/**
 * The tender's reading has written the project's first vision: the state inboundDecision holds a
 * change by until then.
 */
export const visionWritten = (projectId: AnyColumn | SQL): SQL =>
  sql`EXISTS (SELECT 1 FROM vision_documents vw WHERE vw.project_id = ${projectId instanceof SQL ? projectId : qualifiedColumn(projectId)})`;

/**
 * A message of `kind` of the project in scope is read now, in the project's present state, by its
 * inboundDecision: its `reading`, or with `atCap` the reading of one at its cap of failed readings.
 * The SQL is derived from that decision over every lifecycle, every halt kind and both vision states,
 * so it admits exactly the states it decides are read now.
 */
export function clientMessageReadNow(kind: InboundKind, which: "reading" | "atCap" = "reading"): SQL {
  const readNow = (state: InboundState): boolean => inboundDecision(state, kind)[which] === "now";
  const lifecycle = qualifiedColumn(projects.lifecycle);
  const closed = CLOSED_LIFECYCLES.filter((closedLifecycle) => readNow({ lifecycle: closedLifecycle }));
  const activeReadNow = (written: boolean): { readonly atWork: boolean; readonly halts: readonly HaltKind[] } => ({
    atWork: readNow({ lifecycle: "active", halt: null, visionWritten: written }),
    halts: HALT_KINDS.filter((halt) => readNow({ lifecycle: "active", halt, visionWritten: written })),
  });
  const activeSql = (read: { readonly atWork: boolean; readonly halts: readonly HaltKind[] }): SQL | null => {
    const states: SQL[] = [];
    if (read.atWork) states.push(sql`NOT ${projectHalted(projects.id)}`);
    const [firstHalt, ...moreHalts] = read.halts;
    if (firstHalt !== undefined) states.push(projectHaltedOn(projects.id, [firstHalt, ...moreHalts]));
    return states.length === 0 ? null : sql`(${sql.join(states, sql` OR `)})`;
  };
  const written = activeReadNow(true);
  const unwritten = activeReadNow(false);
  const sameEither = written.atWork === unwritten.atWork && written.halts.join() === unwritten.halts.join();
  const byVision: Array<readonly [SQL | null, SQL | null]> = sameEither
    ? [[activeSql(written), null]]
    : [
        [activeSql(written), visionWritten(projects.id)],
        [activeSql(unwritten), sql`NOT ${visionWritten(projects.id)}`],
      ];
  const states: SQL[] = [];
  if (closed.length > 0) states.push(sql`${lifecycle} IN (${sql.join(closed.map((closedLifecycle) => sql`${closedLifecycle}`), sql`, `)})`);
  for (const [active, vision] of byVision) {
    if (active !== null) states.push(vision === null ? sql`(${projectActive()} AND ${active})` : sql`(${projectActive()} AND ${vision} AND ${active})`);
  }
  return states.length === 0 ? sql`FALSE` : sql`(${sql.join(states, sql` OR `)})`;
}

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
  sql`(${firstPlanned(projects.id)} AND NOT ${firstPlanTold(projects.id)})`;

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
