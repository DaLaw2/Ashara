import { and, eq, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { projects } from "@ashara/db";
import type { Database, DbHandle } from "@ashara/db";
import type { SpendAtCap, WorkAtBudget } from "@ashara/finance";
import { parseProjectId, readEach, type ProjectId, type UnreadSubject } from "@ashara/shared";
import { PROJECT_BLOCK_KINDS, endedHaltEpisodesWhere, haltEpisodeOf, haltEpisodesWhere, type HaltEpisodeRef } from "@ashara/delivery/predicates";
import { awaitedRepairsRecordedBy, workItemSummaries } from "@ashara/delivery/reads";
import { BlockedReasonCorrupt, parseStoredBlockedReason, type StoredBlockedReason } from "@ashara/delivery/work-item";
import { lastDisputeBy, sweepOfTerminal } from "@ashara/quality/published-reads";
import { haltReported, noOpenStop, reportTold, visionWritten } from "../predicates.js";
import { REPORT_SUBJECT } from "../report-subjects.js";
import type { GuaranteeTable, TableVerdicts } from "../guarantee-report.js";
import { insertGuaranteeVerdicts, readGuaranteeTable } from "./guarantee-report.js";
import { insertOutboundReport, tellOnce } from "./told-report.js";

// The Liaison's reports on project halts: one when a project is halted, one
// when it returns to work (an owner's unblock, or the substrate probe passing after an
// infrastructure halt). Each is due while its episode (Delivery's halt episode, read in its
// published reads) has no told record, and posting one records it as told of that episode in the
// same transaction, so a retried or concurrent post tells the client once. A halt's report carries
// the guarantee table of the halt's terminal sweep, which the cycle runs before its reports, and its
// verdicts are posted with it; a halt whose sweep is not on record (its recording failed) is still
// told, every guarantee unjudged with no sweep on a commit, since the client is never left unaware
// of a halt for want of evidence.

const ProjectBlockKindSchema = z.enum(PROJECT_BLOCK_KINDS);
type ProjectBlockKind = Exclude<z.infer<typeof ProjectBlockKindSchema>, "check_dispute" | "suite_review" | "plan_repair">;

/** A task given up whose repair a plan_repair block left awaited, with the reason it was given up for, as stored. */
interface BlockingAbandonmentRow {
  readonly workItemId: string;
  readonly title: string;
  readonly attempts: number;
  readonly cause: StoredBlockedReason;
}

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
async function blockingAbandonments(db: DbHandle, episodeId: string, projectId: string, blockedAt: Date): Promise<BlockingAbandonmentRow[]> {
  const rows = await awaitedRepairsRecordedBy(db, projectId, blockedAt);
  if (rows.length === 0) throw new BlockingRepairMissing(episodeId, projectId);
  return rows.map((row) => ({ workItemId: row.workItemId, title: row.title, attempts: row.attempts, cause: givenUpCause(episodeId, row.workItemId, row.blockedReason) }));
}

/**
 * The cause recorded on a block episode: the error's class, its described chain, on
 * a budget_cap halt the amounts its cap was judged on, and on a work_budget halt the
 * work ledger as it stood, its verification reserve with it.
 */
interface RecordedCauseRow {
  readonly errorClass: string | null;
  readonly reason: string | null;
  /** null on every kind but budget_cap, and on a budget_cap halt recorded before the amounts were. */
  readonly spend: SpendAtCap | null;
  /** null on every kind but work_budget. */
  readonly work: WorkAtBudget | null;
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

/** The review a suite_review block was written on: the last one recorded before the block. */
interface BlockingReviewRow {
  readonly times: number;
  readonly problems: readonly string[];
}

/**
 * Reads the last review of the project recorded at or before `blockedAt`, null when none was:
 * Quality's record, which the composition root supplies.
 */
type BlockingReviewReader = (db: DbHandle, projectId: string, blockedAt: Date) => Promise<BlockingReviewRow | null>;

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
  | {
      readonly subject: "project-blocked";
      readonly episodeId: string;
      readonly projectId: ProjectId;
      readonly kind: ProjectBlockKind;
      readonly cause: RecordedCauseRow;
      readonly guarantees: GuaranteeTable;
      readonly visionWritten: boolean;
    }
  | {
      readonly subject: "project-blocked";
      readonly episodeId: string;
      readonly projectId: ProjectId;
      readonly kind: "check_dispute";
      readonly dispute: BlockingDisputeRow;
      readonly guarantees: GuaranteeTable;
      readonly visionWritten: boolean;
    }
  | {
      readonly subject: "project-blocked";
      readonly episodeId: string;
      readonly projectId: ProjectId;
      readonly kind: "suite_review";
      readonly review: BlockingReviewRow;
      readonly guarantees: GuaranteeTable;
      readonly visionWritten: boolean;
    }
  | {
      readonly subject: "project-blocked";
      readonly episodeId: string;
      readonly projectId: ProjectId;
      readonly kind: "plan_repair";
      readonly abandoned: readonly BlockingAbandonmentRow[];
      readonly guarantees: GuaranteeTable;
      readonly visionWritten: boolean;
    }
  | { readonly subject: "project-resumed"; readonly episodeId: string; readonly projectId: ProjectId; readonly how: "unblocked" | "probe_passed" };

const ResumeKindSchema = z.enum(["unblocked", "probe_passed"]);

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
async function blockingDispute(db: DbHandle, episodeId: string, projectId: string, blockedAt: Date): Promise<BlockingDisputeRow> {
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

const RESUMED_END_KINDS = ["unblocked", "probe_passed"];

/** A resumption report was asked for an episode no unblock or passing probe ended. */
class BlockEpisodeNotResumed extends Error {
  constructor(
    readonly episodeId: string,
    readonly endKind: string | null,
  ) {
    super(`cannot post a resumption report on block episode ${episodeId}: it ${endKind === null ? "is still open" : `ended as '${endKind}'`}, not by an unblock or a passing probe`);
    this.name = "BlockEpisodeNotResumed";
  }
}

/** The project is not stopped by the client and has no stop awaiting the Liaison: its halts are told. */
const haltsToldOf = (projectId: SQL): SQL =>
  sql`(EXISTS (SELECT 1 FROM projects hp WHERE hp.id = ${projectId} AND hp.lifecycle <> 'stopped') AND ${noOpenStop(projectId)})`;

/**
 * A planning_stopped block is first told by the planning-stopped report (plan-report.ts), one per
 * project; only a later stop, blocked after that report was posted, is due here.
 */
const notCoveredByPlanningStoppedReport = (episode: HaltEpisodeRef): SQL => sql`(${episode.kind} <> 'planning_stopped' OR EXISTS (
  SELECT 1 FROM client_messages m WHERE m.project_id = ${episode.projectId}
    AND m.reports_on = ${REPORT_SUBJECT.planningStopped} AND m.created_at < ${episode.blockedAt}))`;

/**
 * The halt is told before its resumption: its own report is posted, or it is a planning_stopped
 * block the planning-stopped report tells.
 */
const haltTold = (episode: HaltEpisodeRef): SQL => sql`(${haltReported(episode.id)} OR NOT ${notCoveredByPlanningStoppedReport(episode)})`;

const VisionWrittenRowSchema = z.object({ written: z.boolean() });

/**
 * Whether the project's tender's reading has written its first vision: what a change sent during its
 * halt waits for (inboundDecision). A tender is not read under a halt, so it holds for the halt's length.
 */
async function projectVisionWritten(db: DbHandle, projectId: ProjectId): Promise<boolean> {
  const [row] = await db.select({ written: visionWritten(projects.id) }).from(projects).where(eq(projects.id, projectId));
  return VisionWrittenRowSchema.parse(row).written;
}

/** The report's subject in the block-report step's ledger: one per episode and side (BlockReports). */
function reportSubject(subject: DueBlockReportRow["subject"], row: { readonly id: string; readonly projectId: string }) {
  return { id: `${subject}:${row.id}`, projectId: parseProjectId(row.projectId, "project_blocks.project_id") };
}

/**
 * Every block report not yet posted, oldest first within each subject, over the halt episodes
 * Delivery publishes. A project the client stopped, or has a stop awaiting the Liaison, is not
 * reported on. Each episode is read on its own (readEach): one whose record does not read as a
 * report is that report's UnreadSubject, and every other report is still listed.
 */
export async function listDueBlockReports(db: DbHandle, blockingReview: BlockingReviewReader): Promise<Array<DueBlockReportRow | UnreadSubject>> {
  const resumed = await endedHaltEpisodesWhere(db, (episode) =>
    and(
      episode.resumed,
      sql`NOT ${reportTold("project-resumed", episode.id)}`,
      haltTold(episode),
      haltsToldOf(episode.projectId),
    ),
  );
  const resumedReports = await readEach(
    resumed,
    (row) => reportSubject("project-resumed", row),
    (row): DueBlockReportRow => ({
      subject: "project-resumed",
      episodeId: row.id,
      projectId: parseProjectId(row.projectId, "project_blocks.project_id"),
      how: ResumeKindSchema.parse(row.endKind),
    }),
  );

  const blocked = await haltEpisodesWhere(db, (episode) =>
    and(
      // A halt ended by an unblock or a passing probe before its report was posted is still told,
      // and its resumption after it; one the client's stop ended is told by the stop report. An episode
      // whose resumption the client has already heard is never told the halt after it.
      or(episode.open, and(episode.resumed, sql`NOT ${reportTold("project-resumed", episode.id)}`)),
      sql`NOT ${haltReported(episode.id)}`,
      haltsToldOf(episode.projectId),
      notCoveredByPlanningStoppedReport(episode),
    ),
  );
  const blockedReports = await readEach(
    blocked,
    (row) => reportSubject("project-blocked", row),
    async (row): Promise<DueBlockReportRow> => {
      const kind = ProjectBlockKindSchema.safeParse(row.kind);
      if (!kind.success) throw new ProjectBlockKindUnknown(row.id, row.kind);
      const projectId = parseProjectId(row.projectId, "project_blocks.project_id");
      const sweepId = await sweepOfTerminal(db, { kind: "halt", blockId: row.id });
      const guarantees = await readGuaranteeTable(db, sweepId === null ? { kind: "no-sweep", projectId: row.projectId } : { kind: "sweep", sweepId });
      const written = await projectVisionWritten(db, projectId);
      if (kind.data === "check_dispute") {
        const dispute = await blockingDispute(db, row.id, row.projectId, row.blockedAt);
        return { subject: "project-blocked", episodeId: row.id, projectId, kind: kind.data, dispute, guarantees, visionWritten: written };
      }
      if (kind.data === "suite_review") {
        const review = await blockingReview(db, row.projectId, row.blockedAt);
        if (review === null) throw new BlockingReviewMissing(row.id, row.projectId);
        return { subject: "project-blocked", episodeId: row.id, projectId, kind: kind.data, review, guarantees, visionWritten: written };
      }
      if (kind.data === "plan_repair") {
        const abandoned = await blockingAbandonments(db, row.id, row.projectId, row.blockedAt);
        return { subject: "project-blocked", episodeId: row.id, projectId, kind: kind.data, abandoned, guarantees, visionWritten: written };
      }
      const cause = { errorClass: row.errorClass, reason: row.reason, spend: recordedSpend(row.id, row.spend), work: recordedWork(row.id, row.work) };
      return { subject: "project-blocked", episodeId: row.id, projectId, kind: kind.data, cause, guarantees, visionWritten: written };
    },
  );

  return [...resumedReports, ...blockedReports];
}

/**
 * Posts the report on one project block episode, `on` the block itself or its resumption, with the
 * verdicts of the table it carries, and records it as told of the episode in the same transaction,
 * so a retried or concurrent post tells the client once. An episode already reported on gets nothing.
 */
export async function postProjectBlockReport(
  db: Database,
  episodeId: string,
  on: "blocked" | "resumed",
  body: string,
  verdicts: TableVerdicts | null,
): Promise<"posted" | "already-posted"> {
  const episode = await haltEpisodeOf(db, episodeId);
  if (episode === null) throw new BlockEpisodeNotFound(episodeId);
  if (on === "resumed" && (episode.endKind === null || !RESUMED_END_KINDS.includes(episode.endKind))) throw new BlockEpisodeNotResumed(episodeId, episode.endKind);
  return tellOnce(db, { kind: on === "blocked" ? "project-blocked" : "project-resumed", id: episodeId }, async (tx) => {
    const reportId = await insertOutboundReport(tx, episode.projectId, body, null, `post a block report to project ${episode.projectId}`);
    if (verdicts !== null) await insertGuaranteeVerdicts(tx, episode.projectId, reportId, verdicts);
    return { projectId: episode.projectId, reportId };
  });
}
