import { and, asc, eq, isNotNull, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { qualifiedColumn } from "@ashara/db";
import { projectBlocks, workItems } from "@ashara/db/schema/delivery";
import type { DbHandle } from "@ashara/db";

// Delivery's published predicates: the facts about a project's halt, its awaited plan revisions and
// its work items that other contexts read the shared tables by. Each is spelled here once; a reader
// in another context imports it (`@ashara/delivery/predicates`) instead of writing the SQL again.
// This module imports nothing of Delivery and no other context, so any context Delivery itself
// reads can import it without a cycle at load time.

/** The columns of a work_items row a predicate reads; `workItems` itself, or an alias of it. */
export interface WorkItemColumns {
  readonly status: AnyColumn;
  readonly blockedReason: AnyColumn;
  readonly level: AnyColumn;
  readonly taskSpec: AnyColumn;
}

/** Every kind of halt episode project_blocks records: the closed list its CHECK holds. */
export { PROJECT_BLOCK_KINDS } from "@ashara/db/schema/delivery";

/** The project's open block episode, `also` narrowing which one. */
const openEpisode = (projectId: AnyColumn, also: SQL | null): SQL =>
  sql`EXISTS (SELECT 1 FROM project_blocks hb WHERE hb.project_id = ${qualifiedColumn(projectId)} AND hb.ended_at IS NULL${also === null ? sql`` : sql` AND ${also}`})`;

/** Delivery's halt as stored: the project has an open block episode, the halt's one record. */
export const projectHalted = (projectId: AnyColumn): SQL => openEpisode(projectId, null);

/**
 * The project is halted on its model work: on its budget (a spend cap's or the work ledger's halt,
 * which refuses every model call the project would make), or on a model's or its provider's failure,
 * the plan revision's among them, which a model call the project makes meanwhile would meet again.
 */
export const projectHaltedOnModelWork = (projectId: AnyColumn): SQL =>
  openEpisode(projectId, sql`hb.kind IN ('budget_cap', 'work_budget', 'model_failed', 'provider_failed', 'replan_stopped', 'replan_provider_failed')`);

/** The kind of the project's open block episode; null while it is not halted. */
export const openHaltKind = (projectId: AnyColumn): SQL<unknown> =>
  sql<unknown>`(SELECT hb.kind FROM project_blocks hb WHERE hb.project_id = ${qualifiedColumn(projectId)} AND hb.ended_at IS NULL)`;

/** The project has no work item: nothing of it was ever planned. */
export const projectUnplanned = (projectId: AnyColumn): SQL =>
  sql`NOT EXISTS (SELECT 1 FROM work_items w WHERE w.project_id = ${qualifiedColumn(projectId)})`;

/**
 * The project awaits a plan repair: a task the failure router gave up that no plan
 * revision has re-planned around yet. Its dispatch is held until one has.
 */
export const pendingRepair = (projectId: AnyColumn): SQL =>
  sql`EXISTS (SELECT 1 FROM plan_repairs pr WHERE pr.project_id = ${projectId} AND pr.plan_revision_id IS NULL)`;

/**
 * The project awaits a plan revision for a client's correction (a change, a confirmed proposal, an
 * answer that changed an assumption) that no revision has taken in yet. Only the tasks citing a key
 * it affects are held: the rest of the project still dispatches.
 */
export const pendingCorrection = (projectId: AnyColumn): SQL =>
  sql`EXISTS (SELECT 1 FROM correction_holds ch WHERE ch.project_id = ${projectId} AND ch.plan_revision_id IS NULL)`;

const ABANDONED = "Abandoned";
const SUPERSEDED = "superseded";

/**
 * A work item a plan revision replaced while it was open: Abandoned with a `superseded` reason. It
 * belongs to the revision that replaced it, not to the plan that stands; an Abandoned item with any
 * other reason, or none, was given up and stays in the plan as given up.
 */
const supersededItem = (w: WorkItemColumns): SQL =>
  sql`(${w.status} = ${ABANDONED} AND (${w.blockedReason}->>'source') IS NOT DISTINCT FROM ${SUPERSEDED})`;

/** supersededItem in memory, on a row's status and its parsed blocked reason. */
export function isSupersededItem(item: { readonly status: string; readonly blockedReason: { readonly source: string } | null | undefined }): boolean {
  return item.status === ABANDONED && item.blockedReason?.source === SUPERSEDED;
}

/**
 * The work item belongs to the project's current plan: no revision superseded it. A given-up item
 * belongs to it: the plan was repaired around it, and its share of the plan's work stays counted.
 */
export const inCurrentPlan = (w: WorkItemColumns): SQL => sql`NOT ${supersededItem(w)}`;

/** The work item was given up: Abandoned, and not by a revision that superseded it. */
export const givenUpItem = (w: WorkItemColumns): SQL => sql`(${w.status} = ${ABANDONED} AND NOT ${supersededItem(w)})`;

/**
 * The work item belongs to the current plan and is not given up: its work is yet to be done, under
 * way or done. Every Abandoned item is outside it, superseded or given up alike.
 */
export const liveInCurrentPlan = (w: WorkItemColumns): SQL => sql`${w.status} <> ${ABANDONED}`;

const GOAL_TASK_LEVEL = "Task";
const GOAL_TASK_ORIGIN = "decomposition";
const PRODUCT_SCAFFOLD_ORIGIN = "product-scaffold";
const REVIEW_ORIGIN = "review";
const SPRINT0_ORIGIN = "sprint0";

/**
 * A goal task: a Task the plan's decomposition wrote (work_items.level 'Task', task_spec.origin
 * 'decomposition'). Its work kind is not part of the definition: the plan store derives it from
 * the origin, so it restates the origin and is null on a task planned before owners were assigned.
 */
export function isGoalTask(item: { readonly level: string; readonly origin: string | null }): boolean {
  return item.level === GOAL_TASK_LEVEL && item.origin === GOAL_TASK_ORIGIN;
}

/** isGoalTask as a condition on a work_items row or an alias of it. */
const goalTask = (w: WorkItemColumns): SQL => sql`(${w.level} = ${GOAL_TASK_LEVEL} AND ${w.taskSpec}->>'origin' = ${GOAL_TASK_ORIGIN})`;

/** isGoalTask as a condition on a work_items row, for a query whose FROM names work_items unaliased. */
export const goalTaskSql: SQL = goalTask(workItems);

/** The project's Completed goal tasks (isGoalTask), oldest completion first. */
export async function completedGoalTasks(db: DbHandle, projectId: string): Promise<Array<typeof workItems.$inferSelect>> {
  return db
    .select()
    .from(workItems)
    .where(and(eq(workItems.projectId, projectId), eq(workItems.status, "Completed"), goalTaskSql))
    .orderBy(asc(workItems.updatedAt), asc(workItems.id));
}

/** The product scaffold: the task that lays out the product, which every check is red-run after. */
export const productScaffoldTask = (w: WorkItemColumns): SQL => sql`${w.taskSpec}->>'origin' = ${PRODUCT_SCAFFOLD_ORIGIN}`;

/** productScaffoldTask in memory, on a row's task_spec.origin as read. */
export function isProductScaffoldOrigin(origin: string | null): boolean {
  return origin === PRODUCT_SCAFFOLD_ORIGIN;
}

/** A Sprint 0 task, on its task_spec.origin as read: it sets up the environment before any product exists. */
export function isSprint0Origin(origin: string | null | undefined): boolean {
  return origin === SPRINT0_ORIGIN;
}

/** A plan revision's review task: the task that reviews the revision's check suites. */
export const reviewTask = (w: WorkItemColumns): SQL => sql`${w.taskSpec}->>'origin' = ${REVIEW_ORIGIN}`;

/**
 * A halt episode as a reader's filter names it: its id, project, kind and when it began, and whether
 * it is open or ended by the project's return to work, each an SQL expression over the episode the
 * read is of. A reader composes its own conditions on them and never names Delivery's columns.
 */
export interface HaltEpisodeRef {
  readonly id: SQL;
  readonly projectId: SQL;
  readonly kind: SQL;
  readonly blockedAt: SQL;
  /** Nothing ended the episode yet. */
  readonly open: SQL;
  /** An unblock or a passing probe ended it: the project returned to work. */
  readonly resumed: SQL;
}

const HALT_EPISODE: HaltEpisodeRef = {
  id: qualifiedColumn(projectBlocks.id),
  projectId: qualifiedColumn(projectBlocks.projectId),
  kind: qualifiedColumn(projectBlocks.kind),
  blockedAt: qualifiedColumn(projectBlocks.blockedAt),
  open: sql`${qualifiedColumn(projectBlocks.endedAt)} IS NULL`,
  resumed: sql`${qualifiedColumn(projectBlocks.endKind)} IN ('unblocked', 'probe_passed')`,
};

/**
 * A halt episode as Delivery publishes it to the readers that tell the client of it: what halted
 * the project, when, and why. `spend` and `work` are as stored; the reader parses them in the
 * language it states them in.
 */
export interface HaltEpisode {
  readonly id: string;
  readonly projectId: string;
  readonly kind: string;
  readonly blockedAt: Date;
  readonly errorClass: string | null;
  readonly reason: string | null;
  readonly spend: unknown;
  readonly work: unknown;
}

/** The halt episodes `where` admits, oldest halt first. */
export async function haltEpisodesWhere(db: DbHandle, where: (episode: HaltEpisodeRef) => SQL | undefined): Promise<HaltEpisode[]> {
  return db
    .select({
      id: projectBlocks.id,
      projectId: projectBlocks.projectId,
      kind: projectBlocks.kind,
      blockedAt: projectBlocks.blockedAt,
      errorClass: projectBlocks.errorClass,
      reason: projectBlocks.reason,
      spend: projectBlocks.spend,
      work: projectBlocks.work,
    })
    .from(projectBlocks)
    .where(where(HALT_EPISODE))
    .orderBy(asc(projectBlocks.blockedAt), asc(projectBlocks.id));
}

/** The open halt episodes `where` admits, each by its id and project, oldest halt first. */
export async function openHaltEpisodesWhere(db: DbHandle, where: (episode: HaltEpisodeRef) => SQL | undefined): Promise<Array<{ readonly id: string; readonly projectId: string }>> {
  return db
    .select({ id: projectBlocks.id, projectId: projectBlocks.projectId })
    .from(projectBlocks)
    .where(and(HALT_EPISODE.open, where(HALT_EPISODE)))
    .orderBy(asc(projectBlocks.blockedAt), asc(projectBlocks.id));
}

/** A halt episode that ended, and how ('unblocked', 'probe_passed' or 'client_stop', the project_blocks_end_kind_check CHECK). */
export interface EndedHaltEpisode {
  readonly id: string;
  readonly projectId: string;
  readonly endKind: string | null;
}

/** The ended halt episodes `where` admits, earliest end first. */
export async function endedHaltEpisodesWhere(db: DbHandle, where: (episode: HaltEpisodeRef) => SQL | undefined): Promise<EndedHaltEpisode[]> {
  return db
    .select({ id: projectBlocks.id, projectId: projectBlocks.projectId, endKind: projectBlocks.endKind })
    .from(projectBlocks)
    .where(and(isNotNull(projectBlocks.endedAt), where(HALT_EPISODE)))
    .orderBy(asc(projectBlocks.endedAt), asc(projectBlocks.id));
}

/** One halt episode's project and how it ended (null while it is open); null when there is no such episode. */
export async function haltEpisodeOf(db: DbHandle, episodeId: string): Promise<{ readonly endKind: string | null; readonly projectId: string } | null> {
  const [episode] = await db
    .select({ endKind: projectBlocks.endKind, projectId: projectBlocks.projectId })
    .from(projectBlocks)
    .where(eq(projectBlocks.id, episodeId));
  return episode ?? null;
}
