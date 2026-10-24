import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { parseProjectId, readEach, type ProjectId, type UnreadSubject } from "@ashara/shared";
import type { DbHandle } from "@ashara/db";
import { projects } from "@ashara/db";
import { planRevisions, projectPlans, workItems } from "@ashara/db/schema/delivery";
import { firstPlanTold, noOpenStop, planRevisionTold } from "../acl/engagement-predicates-acl.js";
import { REPORT_SUBJECT } from "../acl/engagement-report-subjects-acl.js";
import { isSupersededItem, pendingCorrection } from "../predicates.js";
import { parseWorkItemJsonb, WorkItemRowCorrupt } from "../work-item-language/work-item-row.js";
import { projectBlockCause } from "../project-halt.js";
import type { ProjectBlockCause } from "../project-halt.js";
import type { PlanTaskCounts } from "../published-reads.js";
import type { DroppedPlanDependency } from "./project-plan.js";
import { projectReportsPlans } from "./project-halt.js";
import { answersTakenBy, parseAnswersTaken } from "./replan.js";

// Delivery's published reads of its planning outcomes the Liaison reports on. A report is due
// while the outcome is stamped on the project's planning record and Engagement's told record holds
// no report on it; the report itself is Engagement's write.

/** A revision of the plan written before the first plan was reported; `summary` as stored. */
interface RevisionBeforeReport {
  readonly revisionId: string;
  readonly revision: number;
  readonly summary: unknown;
  /** The client corrections recorded as taken in by it (correction_holds). */
  readonly answersTaken: number;
}

/** How many ordering hints the plan dropped; unrecorded on a project planned before they were recorded. */
type DroppedOrderingHints = { readonly kind: "recorded"; readonly count: number } | { readonly kind: "unrecorded" };

const DroppedPlanDependenciesSchema: z.ZodType<DroppedPlanDependency[]> = z.array(
  z.object({ dependentTaskTitle: z.string(), unresolvedRef: z.string() }),
);

/** project_plans.plan_dropped_dependencies holds something other than a list of dropped dependencies. */
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
      readonly subject: typeof REPORT_SUBJECT.firstPlan;
      readonly projectId: ProjectId;
      readonly epicTitles: readonly string[];
      readonly tasks: PlanTaskCounts;
      readonly droppedOrderingHints: DroppedOrderingHints;
      /** Revisions written before this report, oldest first: the report describes the plan they left. */
      readonly revisions: readonly RevisionBeforeReport[];
      /** The behaviour the standing plan's tasks add beyond what the contract states, once each, in the order the tasks cite it. */
      readonly assumptions: ReadonlyArray<{ readonly key: string; readonly statement: string }>;
    }
  /**
   * A planned project with a work item whose jsonb does not parse (WorkItemRowCorrupt), or whose
   * recorded dropped ordering hints do not (PlanDroppedDependenciesCorrupt).
   */
  | { readonly subject: "first-plan-unreadable"; readonly projectId: ProjectId; readonly cause: ProjectBlockCause };

/**
 * Planning outcomes the client has not been told about, oldest project first.
 * A first plan is reported as the plan that stands when the report is written:
 * its epics and tasks are the project's work items that no revision superseded
 * (a superseded item belongs to the revision that replaced it, whose
 * blocked_reason names it). A revision written before the first plan was
 * reported (answers read in the cycle that wrote the plan) is returned
 * with it, so the client gets one report of the plan that stands, not one of a
 * plan already replaced followed by its revision. Only the first plan of a
 * project at work, or halted at the deployment's spend cap (projectReportsPlans),
 * is due, and none while the project awaits a revision: the client is
 * not told of a plan already known to be changing. A first planning that
 * stopped is a terminal message, read through stoppedPlanningsWhere. A work item
 * whose jsonb does not parse is that one project's bad record, so it is
 * returned as that project's row instead of failing the listing for every
 * project; any other planned project whose rows do
 * not read is its UnreadSubject (readEach).
 */
export async function listDuePlanReports(db: DbHandle): Promise<Array<DuePlanReportRow | UnreadSubject>> {
  const planned = await db
    .select({ id: projects.id, droppedDependencies: projectPlans.planDroppedDependencies })
    .from(projects)
    .innerJoin(projectPlans, eq(projectPlans.projectId, projects.id))
    .where(
      and(
        projectReportsPlans(),
        isNotNull(projectPlans.firstPlannedAt),
        sql`NOT ${pendingCorrection(projects.id)}`,
        sql`NOT ${firstPlanTold(projects.id)}`,
        noOpenStop(projects.id),
      ),
    )
    .orderBy(asc(projects.createdAt), asc(projects.id));
  const firstPlans = await readEach(planned, (row) => ({ id: `first-plan:${row.id}`, projectId: parseProjectId(row.id, "projects.id") }), async (row): Promise<DuePlanReportRow> => {
    const items = await db
      .select({
        id: workItems.id,
        projectId: workItems.projectId,
        level: workItems.level,
        status: workItems.status,
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
    let standing: Array<{
      readonly level: string;
      readonly title: string;
      readonly origin: string | undefined;
      readonly dispatchCount: number;
      readonly added: ReadonlyArray<{ readonly key: string; readonly statement: string }>;
    }>;
    let dropped: DroppedOrderingHints;
    try {
      standing = items
        .map((i) => ({ item: i, parsed: parseWorkItemJsonb(i) }))
        .filter(({ item, parsed }) => !isSupersededItem({ status: item.status, blockedReason: parsed.blockedReason }))
        .map(({ item, parsed }) => ({
          level: item.level,
          title: item.title,
          origin: parsed.taskSpec?.origin,
          dispatchCount: item.dispatchCount,
          // eslint-disable-next-line no-restricted-syntax -- policy default: a task written before plans recorded the behaviour they add cites none it adds
          added: parsed.taskSpec?.addedAssumptions ?? [],
        }));
      dropped = droppedOrderingHints(projectId, row.droppedDependencies);
    } catch (err) {
      if (!(err instanceof WorkItemRowCorrupt) && !(err instanceof PlanDroppedDependenciesCorrupt)) throw err;
      return { subject: "first-plan-unreadable", projectId, cause: projectBlockCause(err) };
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
        .where(and(eq(planRevisions.projectId, row.id), sql`NOT ${planRevisionTold(planRevisions.id)}`))
        .orderBy(asc(planRevisions.revision))
    ).map((revision) => ({ ...revision, answersTaken: parseAnswersTaken(revision.revisionId, revision.answersTaken) }));
    return {
      subject: REPORT_SUBJECT.firstPlan,
      projectId,
      epicTitles: standing.filter((i) => i.level === "Epic").map((i) => i.title),
      revisions,
      assumptions: [...new Map(tasks.flatMap((i) => i.added).map((added) => [added.key, added] as const)).values()],
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
    };
  });
  return firstPlans;
}

