import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { parseProjectId, type ProjectId } from "@ashara/shared";
import type { DbHandle } from "@ashara/db";
import { clientMessages, planRevisions, projects, workItems, noOpenStop, pendingChange } from "@ashara/db";
import { parseWorkItemJsonb, WorkItemRowCorrupt } from "../work-item-language/work-item-row.js";
import { projectBlockCause } from "../project-halt.js";
import type { ProjectBlockCause } from "../project-halt.js";
import type { DroppedPlanDependency } from "./first-plan.js";
import { answersTakenBy, parseAnswersTaken } from "./replan.js";

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
  /** Tasks already dispatched at least once. */
  readonly started: number;
}

/** A revision of the plan written before the first plan was reported (migration 042); `summary` as stored. */
interface RevisionBeforeReport {
  readonly revisionId: string;
  readonly revision: number;
  readonly summary: unknown;
  /** The client answers recorded as taken in by it (replan_requests, migration 052). */
  readonly answersTaken: number;
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
      /** Revisions written before this report, oldest first: the report describes the plan they left. */
      readonly revisions: readonly RevisionBeforeReport[];
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
 * A first plan is reported as the plan that stands when the report is written:
 * its epics and tasks are the project's work items that no revision superseded
 * (a superseded item belongs to the revision that replaced it, whose
 * blocked_reason names it). A revision written before the first plan was
 * reported (answers read in the cycle that wrote the plan, W11 D5) is returned
 * with it, so the client gets one report of the plan that stands, not one of a
 * plan already replaced followed by its revision. Only an active project's first
 * plan is due, and none while the project awaits a revision: the client is
 * not told of a plan already known to be changing. Planning that
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
    .where(
      and(
        eq(projects.status, "active"),
        isNotNull(projects.firstPlannedAt),
        sql`NOT ${pendingChange(projects.id)}`,
        unreported("first-plan"),
        noOpenStop(projects.id),
      ),
    )
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
        dispatchCount: workItems.dispatchCount,
      })
      .from(workItems)
      .where(eq(workItems.projectId, row.id))
      .orderBy(asc(workItems.createdAt), asc(workItems.id));
    const projectId = parseProjectId(row.id, "projects.id");
    let standing: Array<{ readonly level: string; readonly title: string; readonly origin: string | undefined; readonly dispatchCount: number }>;
    let dropped: DroppedOrderingHints;
    try {
      standing = items
        .map((i) => ({ item: i, parsed: parseWorkItemJsonb(i) }))
        .filter(({ parsed }) => parsed.blockedReason?.source !== "superseded")
        .map(({ item, parsed }) => ({ level: item.level, title: item.title, origin: parsed.taskSpec?.origin, dispatchCount: item.dispatchCount }));
      dropped = droppedOrderingHints(projectId, row.droppedDependencies);
    } catch (err) {
      if (!(err instanceof WorkItemRowCorrupt) && !(err instanceof PlanDroppedDependenciesCorrupt)) throw err;
      due.push({ subject: "first-plan-unreadable", projectId, cause: projectBlockCause(err) });
      continue;
    }
    const tasks = standing.filter((i) => i.level === "Task");
    const origins = tasks.map((i) => i.origin);
    const revisions = (
      await db
        .select({
          revisionId: planRevisions.id,
          revision: planRevisions.revision,
          summary: planRevisions.summary,
          answersTaken: answersTakenBy(planRevisions.id),
        })
        .from(planRevisions)
        .where(and(eq(planRevisions.projectId, row.id), isNull(planRevisions.reportId)))
        .orderBy(asc(planRevisions.revision))
    ).map((revision) => ({ ...revision, answersTaken: parseAnswersTaken(revision.revisionId, revision.answersTaken) }));
    due.push({
      subject: "first-plan",
      projectId,
      epicTitles: standing.filter((i) => i.level === "Epic").map((i) => i.title),
      revisions,
      tasks: {
        decomposition: origins.filter((o) => o === "decomposition").length,
        sprint0: origins.filter((o) => o === "sprint0").length,
        scaffolds: origins.filter((o) => o === "product-scaffold").length,
        checks: origins.filter((o) => o === "check").length,
        reviews: origins.filter((o) => o === "review").length,
        unrecorded: origins.filter((o) => o === undefined).length,
        started: tasks.filter((i) => i.dispatchCount > 0).length,
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

/** A revision the first-plan report was to describe is gone or already reported: nothing of the report is recorded. */
class RevisionsNotFoldable extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly expected: readonly string[],
    readonly marked: number,
  ) {
    super(
      `project ${projectId}: the first-plan report describes plan revision(s) ${expected.join(", ")}, ` +
        `but ${marked} of ${expected.length} were unreported revisions of the project; no report is posted`,
    );
    this.name = "RevisionsNotFoldable";
  }
}

/**
 * Posts an outbound report on a planning outcome. The partial unique index on
 * (project_id, reports_on) admits one per outcome: a second post inserts nothing
 * and returns "already-posted". `revisionIds` are the revisions a first-plan report
 * describes (listDuePlanReports): each is recorded as reported by it in the same
 * transaction, so none of them is reported again on its own.
 */
export async function postPlanReport(
  db: DbHandle,
  projectId: ProjectId,
  subject: PlanReportSubject,
  body: string,
  revisionIds: readonly string[],
): Promise<"posted" | "already-posted"> {
  return db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(clientMessages)
      .values({ projectId, direction: "outbound", kind: "report", body, inReplyTo: null, reportsOn: subject })
      .onConflictDoNothing({
        target: [clientMessages.projectId, clientMessages.reportsOn],
        where: isNotNull(clientMessages.reportsOn),
      })
      .returning({ id: clientMessages.id });
    if (inserted === undefined) return "already-posted";
    if (revisionIds.length > 0) {
      const marked = await tx
        .update(planRevisions)
        .set({ reportId: inserted.id })
        .where(and(eq(planRevisions.projectId, projectId), isNull(planRevisions.reportId), inArray(planRevisions.id, [...revisionIds])))
        .returning({ id: planRevisions.id });
      if (marked.length !== revisionIds.length) throw new RevisionsNotFoldable(projectId, revisionIds, marked.length);
    }
    return "posted";
  });
}
