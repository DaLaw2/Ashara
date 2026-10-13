import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import {
  parseProjectId,
  parseWorkItemJsonb,
  projectBlockCause,
  WorkItemRowCorrupt,
  type ProjectBlockCause,
  type ProjectId,
} from "@ashara/shared";
import type { DbHandle } from "../connection.js";
import { clientMessages, projects, workItems } from "../schema.js";

// The Liaison's reports on planning outcomes (migration 020). A report is due
// while the outcome is stamped on the project and no report on it exists.

type PlanReportSubject = "first-plan" | "planning-stopped";

/** A plan's tasks counted by the producer task_spec.origin records. */
interface TaskCounts {
  /** Tasks the decomposition of the client's goal produced. */
  readonly decomposition: number;
  /** The generic project scaffold decomposition adds to every plan. */
  readonly scaffold: number;
  /** Tasks whose task_spec records no origin (written before origin was recorded). */
  readonly unrecorded: number;
}

type DuePlanReportRow =
  | {
      readonly subject: "first-plan";
      readonly projectId: ProjectId;
      readonly epicTitles: readonly string[];
      readonly tasks: TaskCounts;
    }
  | { readonly subject: "planning-stopped"; readonly projectId: ProjectId; readonly attempts: number }
  /** A planned project with a work item whose jsonb does not parse (WorkItemRowCorrupt). */
  | { readonly subject: "first-plan-unreadable"; readonly projectId: ProjectId; readonly cause: ProjectBlockCause };

const unreported = (subject: PlanReportSubject) =>
  sql`NOT EXISTS (SELECT 1 FROM client_messages m WHERE m.project_id = projects.id AND m.reports_on = ${subject})`;

/**
 * Planning outcomes the client has not been told about, oldest project first.
 * A first plan is summarised from the project's work items as they are now; the
 * report is normally posted in the cycle that wrote the plan. Only an active
 * project's first plan is due: a blocked one is not reported on. A work item
 * whose jsonb does not parse is that one project's bad record, so it is
 * returned as that project's row instead of failing the listing for every
 * project (story s-loop-never-stop-m1).
 */
export async function listDuePlanReports(db: DbHandle): Promise<DuePlanReportRow[]> {
  const due: DuePlanReportRow[] = [];

  const planned = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.status, "active"), isNotNull(projects.firstPlannedAt), unreported("first-plan")))
    .orderBy(asc(projects.createdAt), asc(projects.id));
  for (const row of planned) {
    const items = await db
      .select({
        id: workItems.id,
        projectId: workItems.projectId,
        level: workItems.level,
        title: workItems.title,
        taskSpec: workItems.taskSpec,
        successCriteria: workItems.successCriteria,
        blockedReason: workItems.blockedReason,
      })
      .from(workItems)
      .where(eq(workItems.projectId, row.id))
      .orderBy(asc(workItems.createdAt), asc(workItems.id));
    const projectId = parseProjectId(row.id);
    let origins: Array<string | undefined>;
    try {
      origins = items.map((i) => ({ level: i.level, spec: parseWorkItemJsonb(i).taskSpec }))
        .filter((i) => i.level === "Task")
        .map((i) => i.spec?.origin);
    } catch (err) {
      if (!(err instanceof WorkItemRowCorrupt)) throw err;
      due.push({ subject: "first-plan-unreadable", projectId, cause: projectBlockCause(err) });
      continue;
    }
    due.push({
      subject: "first-plan",
      projectId,
      epicTitles: items.filter((i) => i.level === "Epic").map((i) => i.title),
      tasks: {
        decomposition: origins.filter((o) => o === "decomposition").length,
        scaffold: origins.filter((o) => o === "scaffold").length,
        unrecorded: origins.filter((o) => o === undefined).length,
      },
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
