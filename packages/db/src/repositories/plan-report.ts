import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { parseProjectId, type ProjectId } from "@ashara/shared";
import type { DbHandle } from "../connection.js";
import { clientMessages, projects, workItems } from "../schema.js";

// The Liaison's reports on planning outcomes (migration 020). A report is due
// while the outcome is stamped on the project and no report on it exists.

type PlanReportSubject = "first-plan" | "planning-stopped";

type DuePlanReportRow =
  | {
      readonly subject: "first-plan";
      readonly projectId: ProjectId;
      readonly epicTitles: readonly string[];
      readonly taskCount: number;
    }
  | { readonly subject: "planning-stopped"; readonly projectId: ProjectId; readonly attempts: number };

const unreported = (subject: PlanReportSubject) =>
  sql`NOT EXISTS (SELECT 1 FROM client_messages m WHERE m.project_id = projects.id AND m.reports_on = ${subject})`;

/**
 * Planning outcomes the client has not been told about, oldest project first.
 * A first plan is summarised from the project's work items as they are now; the
 * report is normally posted in the cycle that wrote the plan.
 */
export async function listDuePlanReports(db: DbHandle): Promise<DuePlanReportRow[]> {
  const due: DuePlanReportRow[] = [];

  const planned = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(isNotNull(projects.firstPlannedAt), unreported("first-plan")))
    .orderBy(asc(projects.createdAt), asc(projects.id));
  for (const row of planned) {
    const items = await db
      .select({ level: workItems.level, title: workItems.title })
      .from(workItems)
      .where(eq(workItems.projectId, row.id))
      .orderBy(asc(workItems.createdAt), asc(workItems.id));
    due.push({
      subject: "first-plan",
      projectId: parseProjectId(row.id),
      epicTitles: items.filter((i) => i.level === "Epic").map((i) => i.title),
      taskCount: items.filter((i) => i.level === "Task").length,
    });
  }

  const stopped = await db
    .select({ id: projects.id, attempts: projects.planAttempts })
    .from(projects)
    .where(and(isNotNull(projects.planStoppedAt), unreported("planning-stopped")))
    .orderBy(asc(projects.createdAt), asc(projects.id));
  for (const row of stopped) {
    due.push({ subject: "planning-stopped", projectId: parseProjectId(row.id), attempts: row.attempts });
  }
  return due;
}

/**
 * Posts an outbound report on a planning outcome. The partial unique index on
 * (project_id, reports_on) admits one per outcome: a second post inserts nothing
 * and returns "already-posted".
 */
export async function postPlanReport(
  db: DbHandle,
  projectId: ProjectId,
  subject: PlanReportSubject,
  body: string,
): Promise<"posted" | "already-posted"> {
  const inserted = await db
    .insert(clientMessages)
    .values({ projectId, direction: "outbound", kind: "report", body, inReplyTo: null, reportsOn: subject })
    .onConflictDoNothing({
      target: [clientMessages.projectId, clientMessages.reportsOn],
      where: isNotNull(clientMessages.reportsOn),
    })
    .returning({ id: clientMessages.id });
  return inserted.length === 1 ? "posted" : "already-posted";
}
