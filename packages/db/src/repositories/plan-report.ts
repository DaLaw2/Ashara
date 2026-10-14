import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
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
import type { DroppedPlanDependency } from "./first-plan.js";
import { noOpenStop } from "./project.js";

// The Liaison's reports on planning outcomes (migration 020). A report is due
// while the outcome is stamped on the project and no report on it exists.

type PlanReportSubject = "first-plan" | "planning-stopped";

/** A plan's tasks counted by the producer task_spec.origin records. */
interface TaskCounts {
  /** Tasks the decomposition of the client's goal produced. */
  readonly decomposition: number;
  /** The Sprint 0 task decomposition adds to every plan: the project environment. */
  readonly sprint0: number;
  /** The product scaffold decomposition adds after Sprint 0: the product's layout (ADR-074 addendum 2 d72 B2). */
  readonly scaffolds: number;
  /** The check task decomposition adds for each task it produced. */
  readonly checks: number;
  /** The review of every check of the plan, read together before any of its work starts (ADR-074 addendum 2 d71 c). */
  readonly reviews: number;
  /** Tasks whose task_spec records no origin (written before origin was recorded). */
  readonly unrecorded: number;
}

/** How many ordering hints the plan dropped; unrecorded on a project planned before migration 033. */
type DroppedOrderingHints = { readonly kind: "recorded"; readonly count: number } | { readonly kind: "unrecorded" };

const DroppedPlanDependenciesSchema: z.ZodType<DroppedPlanDependency[]> = z.array(
  z.object({ dependentTaskTitle: z.string(), unresolvedRef: z.string() }),
);

/** projects.plan_dropped_dependencies holds something other than migration 033's list. */
class PlanDroppedDependenciesCorrupt extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly issues: string,
  ) {
    super(`project ${projectId}: plan_dropped_dependencies does not parse: ${issues}`);
    this.name = "PlanDroppedDependenciesCorrupt";
  }
}

function droppedOrderingHints(projectId: ProjectId, raw: unknown): DroppedOrderingHints {
  if (raw === null) return { kind: "unrecorded" };
  const parsed = DroppedPlanDependenciesSchema.safeParse(raw);
  if (!parsed.success) throw new PlanDroppedDependenciesCorrupt(projectId, z.prettifyError(parsed.error));
  return { kind: "recorded", count: parsed.data.length };
}

type DuePlanReportRow =
  | {
      readonly subject: "first-plan";
      readonly projectId: ProjectId;
      readonly epicTitles: readonly string[];
      readonly tasks: TaskCounts;
      readonly droppedOrderingHints: DroppedOrderingHints;
    }
  | { readonly subject: "planning-stopped"; readonly projectId: ProjectId; readonly attempts: number }
  /**
   * A planned project with a work item whose jsonb does not parse (WorkItemRowCorrupt), or whose
   * recorded dropped ordering hints do not (PlanDroppedDependenciesCorrupt).
   */
  | { readonly subject: "first-plan-unreadable"; readonly projectId: ProjectId; readonly cause: ProjectBlockCause };

const unreported = (subject: PlanReportSubject) =>
  sql`NOT EXISTS (SELECT 1 FROM client_messages m WHERE m.project_id = projects.id AND m.reports_on = ${subject})`;

/**
 * Planning outcomes the client has not been told about, oldest project first.
 * A first plan is summarised from the project's work items as they are now; the
 * report is normally posted in the cycle that wrote the plan. Only an active
 * project's first plan is due: a blocked one is not reported on. Planning that
 * stopped is due only while the project is blocked: a project the client has
 * stopped (migration 028), or has a stop awaiting the Liaison, gets the stop
 * report and nothing more. A work item
 * whose jsonb does not parse is that one project's bad record, so it is
 * returned as that project's row instead of failing the listing for every
 * project (story s-loop-never-stop-m1).
 */
export async function listDuePlanReports(db: DbHandle): Promise<DuePlanReportRow[]> {
  const due: DuePlanReportRow[] = [];

  const planned = await db
    .select({ id: projects.id, droppedDependencies: projects.planDroppedDependencies })
    .from(projects)
    .where(and(eq(projects.status, "active"), isNotNull(projects.firstPlannedAt), unreported("first-plan"), noOpenStop(projects.id)))
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
    const projectId = parseProjectId(row.id, "projects.id");
    let origins: Array<string | undefined>;
    let dropped: DroppedOrderingHints;
    try {
      origins = items.map((i) => ({ level: i.level, spec: parseWorkItemJsonb(i).taskSpec }))
        .filter((i) => i.level === "Task")
        .map((i) => i.spec?.origin);
      dropped = droppedOrderingHints(projectId, row.droppedDependencies);
    } catch (err) {
      if (!(err instanceof WorkItemRowCorrupt) && !(err instanceof PlanDroppedDependenciesCorrupt)) throw err;
      due.push({ subject: "first-plan-unreadable", projectId, cause: projectBlockCause(err) });
      continue;
    }
    due.push({
      subject: "first-plan",
      projectId,
      epicTitles: items.filter((i) => i.level === "Epic").map((i) => i.title),
      tasks: {
        decomposition: origins.filter((o) => o === "decomposition").length,
        sprint0: origins.filter((o) => o === "sprint0").length,
        scaffolds: origins.filter((o) => o === "product-scaffold").length,
        checks: origins.filter((o) => o === "check").length,
        reviews: origins.filter((o) => o === "review").length,
        unrecorded: origins.filter((o) => o === undefined).length,
      },
      droppedOrderingHints: dropped,
    });
  }

  const stopped = await db
    .select({ id: projects.id, attempts: projects.planAttempts })
    .from(projects)
    .where(
      and(eq(projects.status, "blocked"), isNotNull(projects.planStoppedAt), unreported("planning-stopped"), noOpenStop(projects.id)),
    )
    .orderBy(asc(projects.createdAt), asc(projects.id));
  for (const row of stopped) {
    due.push({ subject: "planning-stopped", projectId: parseProjectId(row.id, "projects.id"), attempts: row.attempts });
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
