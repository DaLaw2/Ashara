import { and, eq, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { projects } from "@ashara/db";
import type { Database, DbHandle } from "@ashara/db";
import type { SpendAtCap, WorkAtBudget } from "@ashara/finance";
import { parseProjectId, readEach, type ProjectId, type UnreadSubject } from "@ashara/shared";
import { PROJECT_BLOCK_KINDS, endedHaltEpisodesWhere, haltEpisodeOf, type HaltEpisode, type HaltEpisodeRef } from "@ashara/delivery/predicates";
import { awaitedRepairsRecordedBy, workItemSummaries } from "@ashara/delivery/reads";
import { BlockedReasonCorrupt, parseStoredBlockedReason, type StoredBlockedReason } from "@ashara/delivery/work-item";
import { lastDisputeBy } from "@ashara/quality/published-reads";
import type { BlockingReviewRow } from "@ashara/quality/stored-checks";
import { haltReported, noOpenStop, reportTold, visionWritten } from "../predicates.js";
import { REPORT_SUBJECT } from "../report-subjects.js";
import { insertOutboundReport } from "./client-message.js";
import { tellOnce } from "./told-report.js";
import type { BlockingAbandonment, BlockingDispute, DueResumption, ProjectBlockedReport } from "../block-report.js";

// The halt report names the review a block was written on in Quality's published language, read here.
export type { BlockingReviewRow };

// The Liaison's reports on project halts: one when a project is halted, one
// when it returns to work (an owner's unblock, or the substrate probe passing after an
// infrastructure halt). Each is due while its episode (Delivery's halt episode, read in its
// published reads) has no told record, and posting one records it as told of that episode in the
// same transaction, so a retried or concurrent post tells the client once. A halt's report is a
// terminal message, listed and posted with the guarantee table of the halt's terminal sweep where
// every terminal message is (repositories/terminal-report.ts); its records are read here. A
// resumption's report is listed and posted here, after its halt's.

const ProjectBlockKindSchema = z.enum(PROJECT_BLOCK_KINDS);

/** A given-up task's stored blocked_reason is absent or unreadable: the halt cannot be reported truthfully. */
class GivenUpCauseUnreadable extends Error {
  constructor(
    readonly episodeId: string,
    readonly workItemId: string,
    readonly detail: string,
  ) {
    super(`project_blocks row ${episodeId}: given-up task ${workItemId} records no readable cause: ${detail}`);
    this.name = "GivenUpCauseUnreadable";
  }
}

/** The stored reason of a given-up task; one that is absent or does not parse throws. */
function givenUpCause(episodeId: string, workItemId: string, raw: unknown): StoredBlockedReason {
  let cause: StoredBlockedReason | undefined;
  try {
    cause = parseStoredBlockedReason(raw);
  } catch (err) {
    if (!(err instanceof BlockedReasonCorrupt)) throw err;
    throw new GivenUpCauseUnreadable(episodeId, workItemId, err.message);
  }
  if (cause === undefined) throw new GivenUpCauseUnreadable(episodeId, workItemId, "blocked_reason is NULL");
  return cause;
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

/** The given-up tasks whose awaited repair the plan_repair block stopped, oldest first. */
async function blockingAbandonments(db: DbHandle, episodeId: string, projectId: string, blockedAt: Date): Promise<BlockingAbandonment[]> {
  const rows = await awaitedRepairsRecordedBy(db, projectId, blockedAt);
  if (rows.length === 0) throw new BlockingRepairMissing(episodeId, projectId);
  return rows.map((row) => ({ workItemId: row.workItemId, title: row.title, attempts: row.attempts, cause: givenUpCause(episodeId, row.workItemId, row.blockedReason) }));
}

const WorkAtBudgetSchema = z.strictObject({
  scope: z.enum(["task", "project"]),
  budgetRequests: z.number().int().positive(),
  grantedRequests: z.number().int().nonnegative(),
  reserveRequests: z.number().int().nonnegative(),
  reserveProtected: z.boolean(),
  spentRequests: z.number().int().nonnegative(),
  inFlightRequests: z.number().int().nonnegative(),
  bySite: z.array(z.strictObject({ callSite: z.string().min(1), requests: z.number().int().positive() })),
});

/** A block episode's recorded work ledger does not parse: its figures cannot be told, and are never told as absent. */
class BlockWorkUnreadable extends Error {
  constructor(
    readonly episodeId: string,
    readonly detail: string,
  ) {
    super(`project_blocks row ${episodeId}: work does not parse: ${detail}`);
    this.name = "BlockWorkUnreadable";
  }
}

function recordedWork(episodeId: string, raw: unknown): WorkAtBudget | null {
  if (raw === null) return null;
  const parsed = WorkAtBudgetSchema.safeParse(raw);
  if (!parsed.success) throw new BlockWorkUnreadable(episodeId, z.prettifyError(parsed.error));
  return parsed.data;
}

const SpendAtCapSchema = z.strictObject({
  capUsd: z.number().nonnegative(),
  spentUsd: z.number().nonnegative(),
  inFlightUsd: z.number().nonnegative(),
  nextCallUsd: z.number().nonnegative().nullable(),
});

/** A block episode's recorded spend does not parse: the amounts cannot be told, and are never told as absent. */
class BlockSpendUnreadable extends Error {
  constructor(
    readonly episodeId: string,
    readonly detail: string,
  ) {
    super(`project_blocks row ${episodeId}: spend does not parse: ${detail}`);
    this.name = "BlockSpendUnreadable";
  }
}

function recordedSpend(episodeId: string, raw: unknown): SpendAtCap | null {
  if (raw === null) return null;
  const parsed = SpendAtCapSchema.safeParse(raw);
  if (!parsed.success) throw new BlockSpendUnreadable(episodeId, z.prettifyError(parsed.error));
  return parsed.data;
}

/**
 * Reads the last review of the project recorded at or before `blockedAt`, null when none was:
 * Quality's record, which the composition root supplies.
 */
export type BlockingReviewReader = (db: DbHandle, projectId: string, blockedAt: Date) => Promise<BlockingReviewRow | null>;

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

const ResumeKindSchema = z.enum(["unblocked", "probe_passed", "answered"]);

/** A project_blocks row holds a kind outside the vocabulary its CHECK admits. */
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
async function blockingDispute(db: DbHandle, episodeId: string, projectId: string, blockedAt: Date): Promise<BlockingDispute> {
  const last = await lastDisputeBy(db, projectId, blockedAt);
  if (last === null || last.disputes < 1) throw new BlockingDisputeMissing(episodeId, projectId);
  const [task] = await workItemSummaries(db, [last.taskId]);
  if (task === undefined) throw new BlockingDisputeMissing(episodeId, projectId);
  return { taskTitle: task.title, checkName: last.checkName, reason: last.reason, disputes: last.disputes };
}

/** A report was asked to be posted for a block episode that does not exist. */
class BlockEpisodeNotFound extends Error {
  constructor(readonly episodeId: string) {
    super(`cannot post a report on block episode ${episodeId}: Delivery publishes no such halt episode`);
    this.name = "BlockEpisodeNotFound";
  }
}

/** The project of the halt episode a report is posted on, as Delivery publishes it, and how it ended; one Delivery does not publish throws. */
export async function reportedEpisode(db: DbHandle, episodeId: string): Promise<{ readonly endKind: string | null; readonly projectId: string }> {
  const episode = await haltEpisodeOf(db, episodeId);
  if (episode === null) throw new BlockEpisodeNotFound(episodeId);
  return episode;
}

const RESUMED_END_KINDS = ["unblocked", "probe_passed", "answered"];

/** A resumption report was asked for an episode no unblock or passing probe ended. */
class BlockEpisodeNotResumed extends Error {
  constructor(
    readonly episodeId: string,
    readonly endKind: string | null,
  ) {
    super(`cannot post a resumption report on block episode ${episodeId}: it ${endKind === null ? "is still open" : `ended as '${endKind}'`}, not by an unblock, a passing probe or the client's answer`);
    this.name = "BlockEpisodeNotResumed";
  }
}

/** The project is not stopped by the client and has no stop awaiting the Liaison: its halts are told. */
export const haltsToldOf = (projectId: SQL): SQL =>
  sql`(EXISTS (SELECT 1 FROM projects hp WHERE hp.id = ${projectId} AND hp.lifecycle <> 'stopped') AND ${noOpenStop(projectId)})`;

/**
 * A planning_stopped block is first told by the planning-stopped terminal message, one per project;
 * only a later stop, blocked after that message was posted, is told as a halt.
 */
export const notCoveredByPlanningStoppedReport = (episode: HaltEpisodeRef): SQL => sql`(${episode.kind} <> 'planning_stopped' OR EXISTS (
  SELECT 1 FROM client_messages m WHERE m.project_id = ${episode.projectId}
    AND m.reports_on = ${REPORT_SUBJECT.planningStopped} AND m.created_at < ${episode.blockedAt}))`;

/**
 * The halt is told before its resumption: its own report is posted, or it is a planning_stopped
 * block the planning-stopped report tells.
 */
const haltTold = (episode: HaltEpisodeRef): SQL => sql`(${haltReported(episode.id)} OR NOT ${notCoveredByPlanningStoppedReport(episode)})`;

/** The halt's resumption is told: its told record is on file. */
export const resumptionTold = (episodeId: SQL): SQL => reportTold("project-resumed", episodeId);

const VisionWrittenRowSchema = z.object({ written: z.boolean() });

/**
 * Whether the project's tender's reading has written its first vision: what a change sent during its
 * halt waits for (inboundDecision). A tender is not read under a halt, so it holds for the halt's length.
 */
async function projectVisionWritten(db: DbHandle, projectId: ProjectId): Promise<boolean> {
  const [row] = await db.select({ written: visionWritten(projects.id) }).from(projects).where(eq(projects.id, projectId));
  return VisionWrittenRowSchema.parse(row).written;
}

/**
 * The halt as its terminal message tells it, read from the episode Delivery publishes: its recorded
 * cause, or the dispute, review or given-up tasks it was blocked on. One whose record does not read
 * as a report throws.
 */
export async function haltReportOf(db: DbHandle, row: HaltEpisode, blockingReview: BlockingReviewReader): Promise<ProjectBlockedReport> {
  const kind = ProjectBlockKindSchema.safeParse(row.kind);
  if (!kind.success) throw new ProjectBlockKindUnknown(row.id, row.kind);
  const projectId = parseProjectId(row.projectId, "project_blocks.project_id");
  const written = await projectVisionWritten(db, projectId);
  if (kind.data === "check_dispute") {
    const dispute = await blockingDispute(db, row.id, row.projectId, row.blockedAt);
    return { episodeId: row.id, projectId, kind: kind.data, dispute, visionWritten: written };
  }
  if (kind.data === "suite_review") {
    const review = await blockingReview(db, row.projectId, row.blockedAt);
    if (review === null) throw new BlockingReviewMissing(row.id, row.projectId);
    return { episodeId: row.id, projectId, kind: kind.data, review, visionWritten: written };
  }
  if (kind.data === "plan_repair") {
    const abandoned = await blockingAbandonments(db, row.id, row.projectId, row.blockedAt);
    return { episodeId: row.id, projectId, kind: kind.data, abandoned, visionWritten: written };
  }
  const cause = { errorClass: row.errorClass, reason: row.reason, spend: recordedSpend(row.id, row.spend), work: recordedWork(row.id, row.work) };
  return { episodeId: row.id, projectId, kind: kind.data, cause, visionWritten: written };
}

/**
 * Every resumption report not yet posted, earliest end first, over the halt episodes Delivery
 * publishes: each only once its halt is told. A project the client stopped, or has a stop awaiting
 * the Liaison, is not reported on. Each episode is read on its own (readEach): one whose record does
 * not read as a report is that report's UnreadSubject, and every other report is still listed.
 */
export async function listDueResumptionReports(db: DbHandle): Promise<Array<DueResumption | UnreadSubject>> {
  const resumed = await endedHaltEpisodesWhere(db, (episode) =>
    and(episode.resumed, sql`NOT ${resumptionTold(episode.id)}`, haltTold(episode), haltsToldOf(episode.projectId)),
  );
  return readEach(
    resumed,
    (row) => ({ id: `project-resumed:${row.id}`, projectId: parseProjectId(row.projectId, "project_blocks.project_id") }),
    (row): DueResumption => ({ episodeId: row.id, projectId: parseProjectId(row.projectId, "project_blocks.project_id"), how: ResumeKindSchema.parse(row.endKind) }),
  );
}

/**
 * Posts the report on a block episode's resumption and records it as told of the episode in the
 * same transaction, so a retried or concurrent post tells the client once. An episode whose
 * resumption is already reported on gets nothing.
 */
export async function postResumptionReport(db: Database, episodeId: string, body: string): Promise<"posted" | "already-posted"> {
  const episode = await reportedEpisode(db, episodeId);
  if (episode.endKind === null || !RESUMED_END_KINDS.includes(episode.endKind)) throw new BlockEpisodeNotResumed(episodeId, episode.endKind);
  return tellOnce(db, { kind: "project-resumed", id: episodeId }, async (tx) => ({
    projectId: episode.projectId,
    reportId: await insertOutboundReport(tx, episode.projectId, body, null, `post a resumption report to project ${episode.projectId}`),
  }));
}
