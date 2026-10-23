import { SQL, and, asc, desc, eq, inArray, isNotNull, isNull, lte, ne, sql, type AnyColumn } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { projects, qualifiedColumn } from "@ashara/db";
import { dependencies, planRepairs, planRevisions, projectPlans, workItems } from "@ashara/db/schema/delivery";
import type { DbHandle } from "@ashara/db";
import { givenUpItem, goalTaskSql, inCurrentPlan, liveInCurrentPlan, productScaffoldTask, projectHalted, reviewTask } from "./predicates.js";
import { SETTLED_WORK_ITEM_STATUSES } from "./work-item-language/index.js";

// Delivery's published reads: what another context reads of the board (work_items, its dependency
// edges, plan revisions and repairs, the planning record) goes through these, never a query of Delivery's tables of its
// own. Each returns Delivery's rows as stored, its jsonb unread; the reader parses them in Delivery's
// work-item language. This module imports nothing of Delivery but its predicates and its status
// vocabulary, which import nothing else, so a context Delivery itself reads can import it without a
// cycle at load time.

/** A reference to the project a published scalar or predicate is about: a column, or an expression. */
type ProjectRef = AnyColumn | SQL;

const named = (ref: ProjectRef): SQL => (ref instanceof SQL ? ref : qualifiedColumn(ref));

/** A work item as other contexts name it: its title, its status and when it was planned. */
export interface WorkItemSummary {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly createdAt: Date;
}

/** The work items `ids` names that exist, in no particular order; an id with no row is absent. */
export async function workItemSummaries(db: DbHandle, ids: readonly string[]): Promise<WorkItemSummary[]> {
  if (ids.length === 0) return [];
  return db
    .select({ id: workItems.id, title: workItems.title, status: workItems.status, createdAt: workItems.createdAt })
    .from(workItems)
    .where(inArray(workItems.id, [...ids]));
}

/** A task given up whose repair is awaited, with the reason it was given up for as stored. */
export interface AwaitedRepair {
  readonly workItemId: string;
  readonly title: string;
  readonly attempts: number;
  readonly blockedReason: unknown;
}

/** The project's given-up tasks whose repair is awaited and was recorded at or before `at`, oldest first. */
export async function awaitedRepairsRecordedBy(db: DbHandle, projectId: string, at: Date): Promise<AwaitedRepair[]> {
  const rows = await db
    .select({ id: workItems.id, title: workItems.title, attempts: workItems.dispatchCount, reason: workItems.blockedReason })
    .from(planRepairs)
    .innerJoin(workItems, eq(workItems.id, planRepairs.workItemId))
    .where(and(eq(planRepairs.projectId, projectId), isNull(planRepairs.planRevisionId), lte(planRepairs.createdAt, at)))
    .orderBy(asc(planRepairs.createdAt), asc(planRepairs.workItemId));
  return rows.map((row) => ({ workItemId: row.id, title: row.title, attempts: row.attempts, blockedReason: row.reason }));
}

const w = alias(workItems, "w");

const CitingRowsSchema = z.array(z.object({ id: z.string(), title: z.string(), status: z.string(), cites: z.array(z.string()) }));

/**
 * The implementation tasks live in the project's current plan (liveInCurrentPlan) that cite any of
 * the vision keys `keys` names, each with the keys of them it cites, oldest first. A given-up task is
 * not one: the plan was repaired around it.
 */
export async function currentTasksCiting(db: DbHandle, projectId: string, keys: readonly string[]): Promise<Array<z.infer<typeof CitingRowsSchema>[number]>> {
  // The keys are vision keys (a letter and a number), so the array literal needs no quoting.
  const keyArray = `{${keys.join(",")}}`;
  const citing = await db.execute(sql`
    SELECT w.id, w.title, w.status,
      ARRAY(SELECT DISTINCT s->>'id' FROM jsonb_array_elements(w.task_spec->'sources') s
            WHERE s->>'id' = ANY(${keyArray}::text[])) AS cites
    FROM work_items w
    WHERE w.project_id = ${projectId} AND w.level = 'Task' AND w.work_kind = 'implementation' AND ${liveInCurrentPlan(w)}
      AND jsonb_typeof(w.task_spec->'sources') = 'array'
    ORDER BY w.created_at, w.id`);
  return CitingRowsSchema.parse(citing.rows).filter((row) => row.cites.length > 0);
}

/**
 * The project's Completed implementation tasks but `exceptTaskId` (none when null): oldest planned
 * first, or oldest completion first.
 */
export async function completedImplementationTaskIds(db: DbHandle, projectId: string, exceptTaskId: string | null, order: "planned" | "completed"): Promise<string[]> {
  const rows = await db
    .select({ id: workItems.id })
    .from(workItems)
    .where(
      and(
        eq(workItems.projectId, projectId),
        eq(workItems.level, "Task"),
        eq(workItems.workKind, "implementation"),
        eq(workItems.status, "Completed"),
        exceptTaskId === null ? undefined : ne(workItems.id, exceptTaskId),
      ),
    )
    .orderBy(order === "planned" ? asc(workItems.createdAt) : asc(workItems.updatedAt), asc(workItems.id));
  return rows.map((row) => row.id);
}

/** A task with a commit on record, and how its merge recorded it closed (null on a record from before merge kinds were). */
export interface RecordedMerge {
  readonly id: string;
  readonly title: string;
  readonly commit: string | null;
  readonly kind: string | null;
}

/** Every Task of the project with a merge commit on record, oldest first. */
export async function tasksWithMerge(db: DbHandle, projectId: string): Promise<RecordedMerge[]> {
  return db
    .select({ id: workItems.id, title: workItems.title, commit: workItems.mergeCommit, kind: workItems.mergeKind })
    .from(workItems)
    .where(and(eq(workItems.projectId, projectId), eq(workItems.level, "Task"), isNotNull(workItems.mergeCommit)))
    .orderBy(asc(workItems.updatedAt), asc(workItems.id));
}

/** The title and commit of every work item of the project whose merge made a commit of its own (merge kind 'merged'). */
export async function mergedCommitsOf(db: DbHandle, projectId: string): Promise<Array<{ readonly title: string; readonly commit: string | null }>> {
  return db
    .select({ title: workItems.title, commit: workItems.mergeCommit })
    .from(workItems)
    .where(and(eq(workItems.projectId, projectId), eq(workItems.mergeKind, "merged")));
}

/** A project whose first planning stopped, with the attempts its planning record counts. */
export interface StoppedPlanning {
  readonly projectId: string;
  readonly attempts: number;
}

/**
 * Every project whose first planning stopped and which Delivery still has halted, that `where`
 * admits (an expression over the project's id), oldest project first.
 */
export async function stoppedPlanningsWhere(db: DbHandle, where: (projectId: SQL) => SQL | undefined): Promise<StoppedPlanning[]> {
  return db
    .select({ projectId: projects.id, attempts: projectPlans.planAttempts })
    .from(projects)
    .innerJoin(projectPlans, eq(projectPlans.projectId, projects.id))
    .where(and(projectHalted(projects.id), isNotNull(projectPlans.planStoppedAt), where(qualifiedColumn(projects.id))))
    .orderBy(asc(projects.createdAt), asc(projects.id));
}

/**
 * The titles of the project's goal tasks given up (givenUpItem), oldest first: each a task the plan
 * was repaired around. A task a plan revision superseded was set aside, not given up.
 */
export async function givenUpGoalTitles(db: DbHandle, projectId: string): Promise<string[]> {
  const rows = await db
    .select({ title: workItems.title })
    .from(workItems)
    .where(and(eq(workItems.projectId, projectId), goalTaskSql, givenUpItem(workItems)))
    .orderBy(asc(workItems.updatedAt), asc(workItems.id));
  return rows.map((row) => row.title);
}

/** The project's goal tasks of its current plan (inCurrentPlan), with their status and task_spec as stored, by id. */
export async function currentGoalTasks(db: DbHandle, projectId: string): Promise<Array<{ readonly id: string; readonly status: string; readonly taskSpec: unknown }>> {
  return db
    .select({ id: workItems.id, status: workItems.status, taskSpec: workItems.taskSpec })
    .from(workItems)
    .where(and(eq(workItems.projectId, projectId), goalTaskSql, inCurrentPlan(workItems)))
    .orderBy(asc(workItems.id));
}

/**
 * The project's latest completed environment task whose statement and merge are on record: only a
 * task whose merge is on record set the environment up, not one an operator marked Completed. Null
 * when there is none.
 */
export async function latestEnvironmentStatement(db: DbHandle, projectId: string): Promise<{ readonly taskId: string; readonly statement: string } | null> {
  const [task] = await db
    .select({ id: workItems.id, statement: workItems.environmentStatement })
    .from(workItems)
    .where(
      and(
        eq(workItems.projectId, projectId),
        eq(workItems.workKind, "environment"),
        eq(workItems.status, "Completed"),
        isNotNull(workItems.environmentStatement),
        isNotNull(workItems.mergeCommit),
      ),
    )
    .orderBy(desc(workItems.updatedAt), desc(workItems.id))
    .limit(1);
  if (task === undefined || task.statement === null) return null;
  return { taskId: task.id, statement: task.statement };
}

/** The number of the project's current plan revision, a scalar subquery: 1 for the first plan, else the latest revision's. */
export const currentPlanRevision = (projectId: ProjectRef): SQL<unknown> =>
  sql<unknown>`(SELECT COALESCE(max(r.revision), 1) FROM plan_revisions r WHERE r.project_id = ${named(projectId)})`;

/**
 * The count of the project's implementation tasks in its current plan (inCurrentPlan: given-up tasks
 * count, superseded ones do not), every one or only the Completed, a scalar subquery.
 */
export const currentPlanImplementationTasks = (projectId: ProjectRef, which: "planned" | "completed"): SQL<unknown> =>
  sql<unknown>`(SELECT count(*) FROM work_items w WHERE w.project_id = ${named(projectId)} AND w.level = 'Task'
    AND w.work_kind = 'implementation' AND ${inCurrentPlan(w)}${which === "completed" ? sql` AND w.status = 'Completed'` : sql``})`;

/** A status Delivery does not name settled reads as open, so a status it adds never lets a project read settled. */
const settledStatuses = sql.join(SETTLED_WORK_ITEM_STATUSES.map((status) => sql`${status}`), sql`, `);

/** No Task of the project is open: every one is in a status Delivery names settled. */
export const noTaskOpen = (projectId: ProjectRef): SQL =>
  sql`NOT EXISTS (SELECT 1 FROM work_items w WHERE w.project_id = ${named(projectId)} AND w.level = 'Task' AND w.status NOT IN (${settledStatuses}))`;

/** A goal task of the project (isGoalTask) is Completed. */
export const completedGoalTaskExists = (projectId: ProjectRef): SQL =>
  sql`EXISTS (SELECT 1 FROM ${workItems} WHERE ${workItems.projectId} = ${named(projectId)} AND ${workItems.status} = 'Completed' AND ${goalTaskSql})`;

/** The project's Completed product scaffolds, each with the merge its completion recorded, oldest completion first. */
export async function completedScaffolds(db: DbHandle, projectId: string): Promise<Array<{ readonly taskId: string; readonly mergeCommit: string | null }>> {
  return db
    .select({ taskId: workItems.id, mergeCommit: workItems.mergeCommit })
    .from(workItems)
    .where(and(eq(workItems.projectId, projectId), eq(workItems.level, "Task"), eq(workItems.status, "Completed"), productScaffoldTask(workItems)))
    .orderBy(asc(workItems.updatedAt), asc(workItems.id));
}

/**
 * The review tasks the task `taskId` names depends on, a relation for a FROM clause with the columns
 * `id` and `project_id`.
 */
export const reviewTasksHeldBy = (taskId: SQL): SQL => {
  const review = alias(workItems, "review");
  return sql`(SELECT review.id, review.project_id FROM dependencies held JOIN work_items review ON review.id = held.to_id
    WHERE held.from_id = ${taskId} AND ${reviewTask(review)})`;
};

/**
 * The check tasks the review task `reviewTaskId` names depends on, a relation for a FROM clause with
 * the columns `id`, `checks_for` (task_spec.checksFor as jsonb), `cited` (task_spec.sources as
 * jsonb) and `created_at`.
 */
export const checkTasksUnderReview = (reviewTaskId: SQL): SQL =>
  sql`(SELECT checker.id, checker.task_spec->'checksFor' AS checks_for, checker.task_spec->'sources' AS cited, checker.created_at
    FROM dependencies under_review JOIN work_items checker ON checker.id = under_review.to_id
    WHERE under_review.from_id = ${reviewTaskId} AND checker.work_kind = 'check')`;

/**
 * The implementation task the check task's `task_spec.checksFor` names, when one exists: the task
 * its checks decide. Not read from the dependency edges: every implementation task of a plan
 * revision depends on every check task of it.
 */
export async function implementationTasksCheckedBy(db: DbHandle, checkTaskId: string): Promise<string[]> {
  const rows = await db
    .select({ id: workItems.id })
    .from(workItems)
    .where(
      and(
        eq(workItems.workKind, "implementation"),
        sql`${workItems.id}::text = (SELECT check_task.task_spec->>'checksFor' FROM work_items check_task WHERE check_task.id = ${checkTaskId})`,
      ),
    )
    .orderBy(asc(workItems.id));
  return rows.map((row) => row.id);
}

const FoundationRowSchema = z.object({
  id: z.string(),
  status: z.string(),
  mergeCommit: z.string().nullable(),
  origin: z.string().nullable(),
  workKind: z.string().nullable(),
  completedAt: z.coerce.date(),
  scaffoldCompletedAt: z.coerce.date().nullable(),
});

/** A task a check task depends on, as a candidate for its foundation. */
export type FoundationCandidate = z.infer<typeof FoundationRowSchema>;

/**
 * Every task the check task depends on, latest update first, each with its status, its recorded
 * merge, its origin and kind, when it was last updated, and when the project's latest Completed
 * product scaffold was (null when none was).
 */
export async function foundationCandidates(db: DbHandle, checkTaskId: string): Promise<FoundationCandidate[]> {
  const scaffolds = alias(workItems, "s");
  const result = await db.execute(sql`
    SELECT w.id, w.status, w.merge_commit AS "mergeCommit", w.task_spec->>'origin' AS origin, w.work_kind AS "workKind",
           w.updated_at AS "completedAt",
           (SELECT max(s.updated_at) FROM work_items s
             WHERE s.project_id = w.project_id AND s.status = 'Completed'
               AND ${productScaffoldTask(scaffolds)}) AS "scaffoldCompletedAt"
    FROM dependencies d JOIN work_items w ON w.id = d.to_id
    WHERE d.from_id = ${checkTaskId}
    ORDER BY w.updated_at DESC, w.id`);
  return z.array(FoundationRowSchema).parse(result.rows);
}

const CorrectedTaskRowSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  taskSpec: z.unknown(),
  successCriteria: z.unknown(),
  blockedReason: z.unknown(),
  corrected: z.array(z.string().min(1)),
});

/** A task as stored, with the keys the client corrections taken in by a plan revision written at or before it affect. */
export type CorrectedTask = z.infer<typeof CorrectedTaskRowSchema>;

/**
 * The task `taskId` names, its jsonb unread, with every key a client correction affects
 * (correction_holds.affected) whose plan revision was written at or before the task was: the keys
 * a revision put in scope when the task was planned. null when no such task exists.
 */
export async function correctedTaskOf(db: DbHandle, taskId: string): Promise<CorrectedTask | null> {
  const result = await db.execute(sql`
    SELECT w.id, w.project_id AS "projectId", w.task_spec AS "taskSpec", w.success_criteria AS "successCriteria",
           w.blocked_reason AS "blockedReason",
           COALESCE((SELECT json_agg(DISTINCT k.key ORDER BY k.key)
             FROM correction_holds ch JOIN plan_revisions r ON r.id = ch.plan_revision_id, unnest(ch.affected) k(key)
             WHERE ch.project_id = w.project_id AND r.created_at <= w.created_at), '[]'::json) AS corrected
    FROM work_items w WHERE w.id = ${taskId}`);
  const [row] = z.array(CorrectedTaskRowSchema).parse(result.rows);
  return row ?? null;
}

/** A check task a review task depends on, as stored, with the title of the task its checks decide (null when task_spec.checksFor names no work item). */
export interface ReviewedCheckTask {
  readonly id: string;
  readonly projectId: string;
  readonly status: string;
  readonly taskSpec: unknown;
  readonly successCriteria: unknown;
  readonly blockedReason: unknown;
  readonly checkedTitle: string | null;
}

/** The check tasks the review task depends on, oldest first. */
export async function checkTasksOfReview(db: DbHandle, reviewTaskId: string): Promise<ReviewedCheckTask[]> {
  return db
    .select({
      id: workItems.id,
      projectId: workItems.projectId,
      status: workItems.status,
      taskSpec: workItems.taskSpec,
      successCriteria: workItems.successCriteria,
      blockedReason: workItems.blockedReason,
      checkedTitle: sql<string | null>`(SELECT checked.title FROM work_items checked WHERE checked.id::text = ${workItems.taskSpec}->>'checksFor')`,
    })
    .from(dependencies)
    .innerJoin(workItems, eq(workItems.id, dependencies.toId))
    .where(and(eq(dependencies.fromId, reviewTaskId), eq(workItems.workKind, "check")))
    .orderBy(asc(workItems.createdAt), asc(workItems.id));
}

/**
 * Locks the task's row until the caller's transaction ends; false when there is no such task. The
 * port by which a context whose own invariant is per task (a task's check revisions) serializes on
 * the task, inside its own transaction.
 */
export type LockTask = (tx: DbHandle, taskId: string) => Promise<boolean>;

export const lockTask: LockTask = async (tx, taskId) => {
  const locked = await tx.select({ id: workItems.id }).from(workItems).where(eq(workItems.id, taskId)).for("update");
  return locked.length === 1;
};

/** The project of each plan revision `ids` names that exists. */
export async function planRevisionProjects(db: DbHandle, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select({ id: planRevisions.id, projectId: planRevisions.projectId }).from(planRevisions).where(inArray(planRevisions.id, [...ids]));
  return new Map(rows.map((row) => [row.id, row.projectId]));
}

/** A work item of a project as the run report reads it; origin and checksFor are task_spec's, as text. */
export interface ProjectWorkItem {
  readonly id: string;
  readonly level: string;
  readonly parentId: string | null;
  readonly title: string;
  readonly status: string;
  readonly workKind: string | null;
  readonly origin: string | null;
  readonly checksFor: string | null;
  readonly repairsTaskId: string | null;
}

/** Every work item of the project, oldest first. */
export async function projectWorkItems(db: DbHandle, projectId: string): Promise<ProjectWorkItem[]> {
  return db
    .select({
      id: workItems.id,
      level: workItems.level,
      parentId: workItems.parentId,
      title: workItems.title,
      status: workItems.status,
      workKind: workItems.workKind,
      origin: sql<string | null>`${workItems.taskSpec}->>'origin'`,
      checksFor: sql<string | null>`${workItems.taskSpec}->>'checksFor'`,
      repairsTaskId: workItems.repairsTaskId,
    })
    .from(workItems)
    .where(eq(workItems.projectId, projectId))
    .orderBy(asc(workItems.createdAt), asc(workItems.id));
}

/** A project as other contexts name it: its lifecycle reads 'blocked' while Delivery's halt holds of it. */
export interface ProjectStatus {
  readonly id: string;
  readonly name: string;
  readonly status: string;
}

/** The project `projectId` names, or null when no project has that id. */
export async function projectStatusOf(db: DbHandle, projectId: string): Promise<ProjectStatus | null> {
  const [row] = await db
    .select({ id: projects.id, name: projects.name, status: sql<string>`CASE WHEN ${projectHalted(projects.id)} THEN 'blocked' ELSE ${projects.lifecycle} END` })
    .from(projects)
    .where(eq(projects.id, projectId));
  return row ?? null;
}
