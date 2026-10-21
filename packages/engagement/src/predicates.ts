import { sql, type AnyColumn, type SQL } from "drizzle-orm";
import { projects, qualifiedColumn } from "@ashara/db";
import { projectHalted, projectHaltedOnModelWork } from "@ashara/delivery/predicates";

// Engagement's published predicates: the facts about a project's engagement lifecycle and the
// client's messages that other contexts read the shared tables by. Each is spelled here once; a
// reader in another context imports it (`@ashara/engagement/predicates`) instead of writing the SQL
// again. A halt is Delivery's, read in its published predicates. This module imports nothing else
// of Engagement, so a context Engagement reads can import it without a cycle at load time.

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
export const noOpenStop = (projectId: AnyColumn): SQL =>
  sql`NOT EXISTS (SELECT 1 FROM client_messages s WHERE s.project_id = ${projectId}
    AND s.direction = 'inbound' AND s.kind = 'stop' AND s.consumed_at IS NULL)`;

/** No answer the Liaison has yet to read: one may change the vision, so the project is planned once its answers are in. */
export const noOpenAnswer = (): SQL =>
  sql`NOT EXISTS (SELECT 1 FROM client_messages a WHERE a.project_id = projects.id
    AND a.direction = 'inbound' AND a.kind = 'answer' AND a.consumed_at IS NULL)`;

/** The Liaison's report of the project's first plan (reports_on 'first-plan') is posted. */
export const firstPlanTold = (projectId: AnyColumn): SQL =>
  sql`EXISTS (SELECT 1 FROM client_messages fr WHERE fr.project_id = ${qualifiedColumn(projectId)} AND fr.reports_on = 'first-plan')`;

/**
 * The project's first plan is written and the Liaison's report of it is not yet posted. Its dispatch
 * is held until the report is: the report tells the client that none of the plan's tasks has
 * started, and refuses to be posted once one has, so a task dispatched while a faulted post waits
 * for its retry would leave the plan unreportable and the project blocked.
 */
export const firstPlanUnreported = (): SQL =>
  sql`(${qualifiedColumn(projects.firstPlannedAt)} IS NOT NULL AND NOT ${firstPlanTold(projects.id)})`;
