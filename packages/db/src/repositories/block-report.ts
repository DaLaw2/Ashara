import { and, asc, count, desc, eq, isNotNull, isNull, lte, ne, sql } from "drizzle-orm";
import { z } from "zod";
import {
  parseProjectId,
  parseWorkItemJsonb,
  projectBlockCause,
  WorkItemRowCorrupt,
  type ProjectBlockCause,
  type ProjectId,
  type StoredBlockedReason,
} from "@ashara/shared";
import type { Database, DbHandle } from "../connection.js";
import { checkDisputes, clientMessages, planRepairs, projectBlocks, projects, workItems } from "../schema.js";
import { noOpenStop } from "./project.js";
import { blockingReview } from "./suite-review.js";

// The Liaison's reports on blocks (migration 040): one when a project is blocked, one when an
// operator returns it to work, and one each time a task is blocked. Each is due while its episode
// (a project_blocks row, or a work item's blocked_at) has no report, and posting one records it
// against that episode in the same transaction, so a retried or concurrent post tells the client
// once.

const ProjectBlockKindSchema = z.enum([
  "budget_cap",
  "configuration",
  "fault",
  "planning_stopped",
  "check_dispute",
  "replan_bound",
  "suite_review",
  "plan_repair",
]);
type ProjectBlockKind = Exclude<z.infer<typeof ProjectBlockKindSchema>, "check_dispute" | "suite_review" | "plan_repair">;

/** A task given up whose repair a plan_repair block left awaited. */
interface BlockingAbandonmentRow {
  readonly title: string;
  readonly attempts: number;
}

/** A plan_repair block has no awaited repair of its project recorded at or before it: nothing to report it by. */
class BlockingRepairMissing extends Error {
  constructor(
    readonly episodeId: string,
    readonly projectId: string,
  ) {
    super(`project_blocks row ${episodeId} (project ${projectId}) is a plan_repair block, but no awaited plan_repairs row of the project precedes it`);
    this.name = "BlockingRepairMissing";
  }
}

/** The given-up tasks whose awaited repair the plan_repair block stopped (migration 045), oldest first. */
async function blockingAbandonments(db: DbHandle, episodeId: string, projectId: string, blockedAt: Date): Promise<BlockingAbandonmentRow[]> {
  const rows = await db
    .select({ title: workItems.title, attempts: workItems.dispatchCount })
    .from(planRepairs)
    .innerJoin(workItems, eq(workItems.id, planRepairs.workItemId))
    .where(and(eq(planRepairs.projectId, projectId), isNull(planRepairs.planRevisionId), lte(planRepairs.createdAt, blockedAt)))
    .orderBy(asc(planRepairs.createdAt), asc(planRepairs.workItemId));
  if (rows.length === 0) throw new BlockingRepairMissing(episodeId, projectId);
  return rows;
}

/** The review a suite_review block was written on: the last one recorded before the block. */
interface BlockingReviewRow {
  readonly times: number;
  readonly problems: readonly string[];
}

/** A suite_review block has no review of its project recorded at or before it: nothing to report it by. */
class BlockingReviewMissing extends Error {
  constructor(
    readonly episodeId: string,
    readonly projectId: string,
  ) {
    super(`project_blocks row ${episodeId} (project ${projectId}) is a suite_review block, but no suite_review_findings row of the project precedes it`);
    this.name = "BlockingReviewMissing";
  }
}

/** The dispute a check_dispute block was written on: the last one recorded before the block. */
interface BlockingDisputeRow {
  readonly taskTitle: string;
  readonly checkName: string;
  readonly reason: string;
  readonly disputes: number;
}

type DueBlockReportRow =
  | { readonly subject: "project-blocked"; readonly episodeId: string; readonly projectId: ProjectId; readonly kind: ProjectBlockKind }
  | {
      readonly subject: "project-blocked";
      readonly episodeId: string;
      readonly projectId: ProjectId;
      readonly kind: "check_dispute";
      readonly dispute: BlockingDisputeRow;
    }
  | {
      readonly subject: "project-blocked";
      readonly episodeId: string;
      readonly projectId: ProjectId;
      readonly kind: "suite_review";
      readonly review: BlockingReviewRow;
    }
  | {
      readonly subject: "project-blocked";
      readonly episodeId: string;
      readonly projectId: ProjectId;
      readonly kind: "plan_repair";
      readonly abandoned: readonly BlockingAbandonmentRow[];
    }
  | { readonly subject: "project-resumed"; readonly episodeId: string; readonly projectId: ProjectId }
  | {
      readonly subject: "task-blocked";
      readonly projectId: ProjectId;
      readonly taskId: string;
      readonly title: string;
      readonly reason: StoredBlockedReason | undefined;
      /** Open tasks (neither Completed nor Abandoned) that depend on it, directly or through others. */
      readonly waiting: number;
    }
  /** A blocked task whose blocked_reason does not parse: that project's bad record. */
  | { readonly subject: "task-blocked-unreadable"; readonly projectId: ProjectId; readonly cause: ProjectBlockCause };

/** A project_blocks row holds a kind outside migration 040's vocabulary. */
class ProjectBlockKindUnknown extends Error {
  constructor(
    readonly episodeId: string,
    readonly kind: string,
  ) {
    super(`project_blocks row ${episodeId} has kind '${kind}', which no report is written for`);
    this.name = "ProjectBlockKindUnknown";
  }
}

/** A check_dispute block has no dispute of its project recorded at or before it: nothing to report it by. */
class BlockingDisputeMissing extends Error {
  constructor(
    readonly episodeId: string,
    readonly projectId: string,
  ) {
    super(`project_blocks row ${episodeId} (project ${projectId}) is a check_dispute block, but no check_disputes row of the project precedes it`);
    this.name = "BlockingDisputeMissing";
  }
}

/** The last dispute of the project recorded at or before `blockedAt`, with its check task's count then. */
async function blockingDispute(db: DbHandle, episodeId: string, projectId: string, blockedAt: Date): Promise<BlockingDisputeRow> {
  const [last] = await db
    .select({ checkTaskId: checkDisputes.checkTaskId, checkName: checkDisputes.checkName, reason: checkDisputes.reason, taskTitle: workItems.title })
    .from(checkDisputes)
    .innerJoin(workItems, eq(workItems.id, checkDisputes.taskId))
    .where(and(eq(checkDisputes.projectId, projectId), lte(checkDisputes.createdAt, blockedAt)))
    .orderBy(desc(checkDisputes.createdAt), desc(checkDisputes.id))
    .limit(1);
  if (!last) throw new BlockingDisputeMissing(episodeId, projectId);
  const [counted] = await db
    .select({ disputes: count() })
    .from(checkDisputes)
    .where(and(eq(checkDisputes.checkTaskId, last.checkTaskId), lte(checkDisputes.createdAt, blockedAt)));
  if (counted === undefined || counted.disputes < 1) throw new BlockingDisputeMissing(episodeId, projectId);
  return { taskTitle: last.taskTitle, checkName: last.checkName, reason: last.reason, disputes: counted.disputes };
}

/** A report was asked to be posted for a block episode that does not exist. */
class BlockEpisodeNotFound extends Error {
  constructor(readonly episodeId: string) {
    super(`cannot post a report on block episode ${episodeId}: no such project_blocks row`);
    this.name = "BlockEpisodeNotFound";
  }
}

/**
 * A planning_stopped block is first told by the planning-stopped report (plan-report.ts), one per
 * project; only a later stop, blocked after that report was posted, is due here.
 */
const notCoveredByPlanningStoppedReport = sql`(${projectBlocks.kind} <> 'planning_stopped' OR EXISTS (
  SELECT 1 FROM client_messages m WHERE m.project_id = ${projectBlocks.projectId}
    AND m.reports_on = 'planning-stopped' AND m.created_at < ${projectBlocks.blockedAt}))`;

/**
 * Every block report not yet posted, oldest first within each subject. A project the client
 * stopped, or has a stop awaiting the Liaison, is not reported on. A task is reported only while
 * its project is active: a blocked project's report already says nothing moves.
 */
export async function listDueBlockReports(db: DbHandle): Promise<DueBlockReportRow[]> {
  const due: DueBlockReportRow[] = [];

  const resumed = await db
    .select({ id: projectBlocks.id, projectId: projectBlocks.projectId })
    .from(projectBlocks)
    .innerJoin(projects, eq(projects.id, projectBlocks.projectId))
    .where(
      and(
        eq(projectBlocks.endKind, "unblocked"),
        isNull(projectBlocks.resumedReportId),
        ne(projects.status, "stopped"),
        noOpenStop(projects.id),
      ),
    )
    .orderBy(asc(projectBlocks.endedAt), asc(projectBlocks.id));
  for (const row of resumed) {
    due.push({ subject: "project-resumed", episodeId: row.id, projectId: parseProjectId(row.projectId, "project_blocks.project_id") });
  }

  const blocked = await db
    .select({ id: projectBlocks.id, projectId: projectBlocks.projectId, kind: projectBlocks.kind, blockedAt: projectBlocks.blockedAt })
    .from(projectBlocks)
    .innerJoin(projects, eq(projects.id, projectBlocks.projectId))
    .where(
      and(
        isNull(projectBlocks.endedAt),
        isNull(projectBlocks.reportId),
        eq(projects.status, "blocked"),
        noOpenStop(projects.id),
        notCoveredByPlanningStoppedReport,
      ),
    )
    .orderBy(asc(projectBlocks.blockedAt), asc(projectBlocks.id));
  for (const row of blocked) {
    const kind = ProjectBlockKindSchema.safeParse(row.kind);
    if (!kind.success) throw new ProjectBlockKindUnknown(row.id, row.kind);
    const projectId = parseProjectId(row.projectId, "project_blocks.project_id");
    if (kind.data === "check_dispute") {
      const dispute = await blockingDispute(db, row.id, row.projectId, row.blockedAt);
      due.push({ subject: "project-blocked", episodeId: row.id, projectId, kind: kind.data, dispute });
    } else if (kind.data === "suite_review") {
      const review = await blockingReview(db, row.projectId, row.blockedAt);
      if (review === null) throw new BlockingReviewMissing(row.id, row.projectId);
      due.push({ subject: "project-blocked", episodeId: row.id, projectId, kind: kind.data, review });
    } else if (kind.data === "plan_repair") {
      const abandoned = await blockingAbandonments(db, row.id, row.projectId, row.blockedAt);
      due.push({ subject: "project-blocked", episodeId: row.id, projectId, kind: kind.data, abandoned });
    } else {
      due.push({ subject: "project-blocked", episodeId: row.id, projectId, kind: kind.data });
    }
  }

  const tasks = await db
    .select({
      id: workItems.id,
      projectId: workItems.projectId,
      title: workItems.title,
      taskSpec: workItems.taskSpec,
      successCriteria: workItems.successCriteria,
      blockedReason: workItems.blockedReason,
    })
    .from(workItems)
    .innerJoin(projects, eq(projects.id, workItems.projectId))
    .where(
      and(
        eq(workItems.status, "Blocked"),
        eq(workItems.level, "Task"),
        isNotNull(workItems.blockedAt),
        eq(projects.status, "active"),
        noOpenStop(projects.id),
        sql`NOT EXISTS (SELECT 1 FROM blocked_task_reports r
          WHERE r.work_item_id = ${workItems.id} AND r.blocked_at = ${workItems.blockedAt})`,
      ),
    )
    .orderBy(asc(workItems.blockedAt), asc(workItems.id));
  const unreadable = new Set<string>();
  for (const row of tasks) {
    if (unreadable.has(row.projectId)) continue;
    const projectId = parseProjectId(row.projectId, "work_items.project_id");
    let reason: StoredBlockedReason | undefined;
    try {
      reason = parseWorkItemJsonb(row).blockedReason;
    } catch (err) {
      if (!(err instanceof WorkItemRowCorrupt)) throw err;
      unreadable.add(row.projectId);
      due.push({ subject: "task-blocked-unreadable", projectId, cause: projectBlockCause(err) });
      continue;
    }
    due.push({ subject: "task-blocked", projectId, taskId: row.id, title: row.title, reason, waiting: await openDependentsOf(db, row.id) });
  }
  return due;
}

/**
 * The open tasks that depend on `taskId` through any chain of dependencies: the work its block
 * holds back. UNION, not UNION ALL, so a dependency cycle ends the recursion.
 */
async function openDependentsOf(db: DbHandle, taskId: string): Promise<number> {
  const result = await db.execute(sql`
    WITH RECURSIVE dependents(id) AS (
      SELECT d.from_id FROM dependencies d WHERE d.to_id = ${taskId}
      UNION
      SELECT d.from_id FROM dependencies d JOIN dependents ON d.to_id = dependents.id
    )
    SELECT count(*)::int AS "waiting" FROM work_items w
    WHERE w.id IN (SELECT id FROM dependents) AND w.id <> ${taskId}
      AND w.status NOT IN ('Completed', 'Abandoned')`);
  const [row] = z.tuple([z.object({ waiting: z.number().int().nonnegative() })]).parse(result.rows);
  return row.waiting;
}

async function insertReport(tx: DbHandle, projectId: string, body: string): Promise<string> {
  const [message] = await tx
    .insert(clientMessages)
    .values({ projectId, direction: "outbound", kind: "report", body, inReplyTo: null })
    .returning({ id: clientMessages.id });
  return message.id;
}

/**
 * Posts the report on one project block episode, `on` the block itself or its resumption, and
 * records it on the episode, in one transaction with the episode row locked. An episode already
 * reported on gets nothing.
 */
export async function postProjectBlockReport(
  db: Database,
  episodeId: string,
  on: "blocked" | "resumed",
  body: string,
): Promise<"posted" | "already-posted"> {
  return db.transaction(async (tx) => {
    const [episode] = await tx
      .select({ projectId: projectBlocks.projectId, reportId: projectBlocks.reportId, resumedReportId: projectBlocks.resumedReportId })
      .from(projectBlocks)
      .where(eq(projectBlocks.id, episodeId))
      .for("update");
    if (!episode) throw new BlockEpisodeNotFound(episodeId);
    const existing = on === "blocked" ? episode.reportId : episode.resumedReportId;
    if (existing !== null) return "already-posted";
    const reportId = await insertReport(tx, episode.projectId, body);
    await tx
      .update(projectBlocks)
      .set(on === "blocked" ? { reportId } : { resumedReportId: reportId })
      .where(eq(projectBlocks.id, episodeId));
    return "posted";
  });
}

/**
 * Posts the report on a task's current block and records it against the task's blocked_at, in one
 * transaction with the work item row locked. The key is read and written in SQL, never through a
 * JS Date, so its microseconds survive. A task no longer Blocked, or whose block is already
 * reported, gets nothing.
 */
export async function postTaskBlockedReport(
  db: Database,
  taskId: string,
  body: string,
): Promise<"posted" | "already-posted" | "not-blocked"> {
  return db.transaction(async (tx) => {
    const [task] = await tx
      .select({
        projectId: workItems.projectId,
        status: workItems.status,
        // Spelled out: drizzle renders a column in the select list unqualified, which inside this
        // subquery would name r's own blocked_at.
        reported: sql<unknown>`EXISTS (SELECT 1 FROM blocked_task_reports r
          WHERE r.work_item_id = work_items.id AND r.blocked_at = work_items.blocked_at)`,
      })
      .from(workItems)
      .where(eq(workItems.id, taskId))
      .for("update");
    if (!task || task.status !== "Blocked") return "not-blocked";
    if (z.boolean().parse(task.reported)) return "already-posted";
    const reportId = await insertReport(tx, task.projectId, body);
    await tx.execute(sql`
      INSERT INTO blocked_task_reports (work_item_id, blocked_at, report_id)
      SELECT id, blocked_at, ${reportId} FROM work_items WHERE id = ${taskId}`);
    return "posted";
  });
}
