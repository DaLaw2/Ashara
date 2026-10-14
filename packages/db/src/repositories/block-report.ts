import { and, asc, count, desc, eq, gt, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { BLOCKED_REASON_SOURCES, parseProjectId, type ProjectId, type StoredBlockedReason } from "@ashara/shared";
import type { Database, DbHandle } from "../connection.js";
import { checkDisputes, clientMessages, planRepairs, projectBlocks, projects, workItems } from "../schema.js";
import { noOpenStop } from "./project.js";
import { blockingReview } from "./suite-review.js";

// The Liaison's reports on project halts (migrations 040, 048): one when a project is halted, one
// when it returns to work (an owner's unblock, or the substrate probe passing after an
// infrastructure halt). Each is due while its episode (a project_blocks row) has no report, and
// posting one records it against that episode in the same transaction, so a retried or concurrent
// post tells the client once.

/**
 * Every kind a project block episode can record.
 */
export const PROJECT_BLOCK_KINDS = [
  "budget_cap",
  "configuration",
  "fault",
  "planning_stopped",
  "check_dispute",
  "replan_bound",
  "suite_review",
  "plan_repair",
  "infrastructure",
] as const;

const ProjectBlockKindSchema = z.enum(PROJECT_BLOCK_KINDS);
type ProjectBlockKind = Exclude<z.infer<typeof ProjectBlockKindSchema>, "check_dispute" | "suite_review" | "plan_repair" | "infrastructure">;

/** A task given up whose repair a plan_repair block left awaited, with the cause it was given up for. */
interface BlockingAbandonmentRow {
  readonly title: string;
  readonly attempts: number;
  readonly cause: StoredBlockedReason["source"];
}

const GivenUpCauseSchema = z.enum(BLOCKED_REASON_SOURCES);

/** A given-up task's stored blocked_reason names no known cause: the halt cannot be reported truthfully. */
class GivenUpCauseUnreadable extends Error {
  constructor(
    readonly episodeId: string,
    readonly workItemId: string,
    readonly source: string | null,
  ) {
    super(`project_blocks row ${episodeId}: given-up task ${workItemId} records cause ${JSON.stringify(source)}, which is no blocked-reason source`);
    this.name = "GivenUpCauseUnreadable";
  }
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
    .select({ id: workItems.id, title: workItems.title, attempts: workItems.dispatchCount, source: sql<string | null>`${workItems.blockedReason}->>'source'` })
    .from(planRepairs)
    .innerJoin(workItems, eq(workItems.id, planRepairs.workItemId))
    .where(and(eq(planRepairs.projectId, projectId), isNull(planRepairs.planRevisionId), lte(planRepairs.createdAt, blockedAt)))
    .orderBy(asc(planRepairs.createdAt), asc(planRepairs.workItemId));
  if (rows.length === 0) throw new BlockingRepairMissing(episodeId, projectId);
  return rows.map((row) => {
    const cause = GivenUpCauseSchema.safeParse(row.source);
    if (!cause.success) throw new GivenUpCauseUnreadable(episodeId, row.id, row.source);
    return { title: row.title, attempts: row.attempts, cause: cause.data };
  });
}

/** The task whose infrastructure faults an infrastructure halt was written on. */
interface BlockingFaultRow {
  readonly taskTitle: string;
  readonly faults: number;
}

/** An infrastructure block has no task of its project with a recorded fault: nothing to report it by. */
class BlockingFaultMissing extends Error {
  constructor(
    readonly episodeId: string,
    readonly projectId: string,
  ) {
    super(`project_blocks row ${episodeId} (project ${projectId}) is an infrastructure block, but no task of the project records an infrastructure fault`);
    this.name = "BlockingFaultMissing";
  }
}

/** The project's task with the most infrastructure faults (migration 048), the latest written on a tie. */
async function blockingFault(db: DbHandle, episodeId: string, projectId: string): Promise<BlockingFaultRow> {
  const [row] = await db
    .select({ taskTitle: workItems.title, faults: workItems.infrastructureFaults })
    .from(workItems)
    .where(and(eq(workItems.projectId, projectId), eq(workItems.level, "Task"), gt(workItems.infrastructureFaults, 0)))
    .orderBy(desc(workItems.infrastructureFaults), desc(workItems.updatedAt), asc(workItems.id))
    .limit(1);
  if (!row) throw new BlockingFaultMissing(episodeId, projectId);
  return row;
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
  | {
      readonly subject: "project-blocked";
      readonly episodeId: string;
      readonly projectId: ProjectId;
      readonly kind: "infrastructure";
      readonly fault: BlockingFaultRow;
    }
  | { readonly subject: "project-resumed"; readonly episodeId: string; readonly projectId: ProjectId; readonly how: "unblocked" | "probe_passed" };

const ResumeKindSchema = z.enum(["unblocked", "probe_passed"]);

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
 * stopped, or has a stop awaiting the Liaison, is not reported on.
 */
export async function listDueBlockReports(db: DbHandle): Promise<DueBlockReportRow[]> {
  const due: DueBlockReportRow[] = [];

  const resumed = await db
    .select({ id: projectBlocks.id, projectId: projectBlocks.projectId, endKind: projectBlocks.endKind })
    .from(projectBlocks)
    .innerJoin(projects, eq(projects.id, projectBlocks.projectId))
    .where(
      and(
        inArray(projectBlocks.endKind, ["unblocked", "probe_passed"]),
        isNull(projectBlocks.resumedReportId),
        ne(projects.status, "stopped"),
        noOpenStop(projects.id),
      ),
    )
    .orderBy(asc(projectBlocks.endedAt), asc(projectBlocks.id));
  for (const row of resumed) {
    const how = ResumeKindSchema.parse(row.endKind);
    due.push({ subject: "project-resumed", episodeId: row.id, projectId: parseProjectId(row.projectId, "project_blocks.project_id"), how });
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
    } else if (kind.data === "infrastructure") {
      const fault = await blockingFault(db, row.id, row.projectId);
      due.push({ subject: "project-blocked", episodeId: row.id, projectId, kind: kind.data, fault });
    } else {
      due.push({ subject: "project-blocked", episodeId: row.id, projectId, kind: kind.data });
    }
  }

  return due;
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
