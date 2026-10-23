import { and, asc, or, sql } from "drizzle-orm";
import { z } from "zod";
import { isDatabaseConnectionFault, projects } from "@ashara/db";
import type { DbHandle } from "@ashara/db";
import { describeErrorChain, parseProjectId, readEach, type ProjectId, type UnreadSubject } from "@ashara/shared";
import { haltEpisodesWhere } from "@ashara/delivery/predicates";
import { stoppedPlanningsWhere, tasksWithMerge } from "@ashara/delivery/reads";
import { passedSweepsWhere, sweepOfTerminal } from "@ashara/quality/published-reads";
import { guaranteeTableOf } from "../guarantee-report.js";
import type { GuaranteeTable, TableSource } from "../guarantee-report.js";
import { noOpenStop, projectActive, terminalTold, unverifiableContractHeld } from "../predicates.js";
import { REPORT_SUBJECT } from "../report-subjects.js";
import type { MergedTask } from "../stop-report.js";
import { terminalSubjectId } from "../terminal-report.js";
import type { DueTerminal, TableNotRead, TerminalMessage } from "../terminal-report.js";
import { haltReportOf, haltsToldOf, notCoveredByPlanningStoppedReport, reportedEpisode, resumptionTold, type BlockingReviewReader } from "./block-report.js";
import { dueStopReportMessages, insertOutboundReport, postOnStop, postOnSubject } from "./client-message.js";
import { attemptsOf, deliveredAttempts, deliveredReportOf, deliveredRetryDue, passedSweepProject, type SweepOutcomeReader } from "./delivered-report.js";
import { readRiskRecords } from "./early-warning.js";
import { insertGuaranteeVerdicts, tableRecordsOf, tableRecordsUnreadable } from "./guarantee-report.js";
import { tellOnce } from "./told-report.js";

// Every terminal message's due listing, its guarantee table and its post-once write: the one place a
// terminal message is listed, judged and recorded told. Each kind is due while terminalTold reads its
// subject untold, so a terminal is listed until the transaction that posts it records it told, and a
// restart between the listing and the post neither tells it twice nor drops it: the delivered report
// of each passed sweep of an accepted project, the stop report of each stop that stopped its
// project, the report of each halt, the report of each first planning that stopped, and the decline
// of each contract Ashara can verify no guarantee of. Each carries the guarantee table of its
// terminal's sweep when one is on record, and otherwise of the project's vision in force, judged on
// no sweep, so no terminal message waits for evidence.

/** The readers of other contexts' records a terminal's words need, which the composition root supplies. */
export interface TerminalReaders {
  readonly sweepOutcome: SweepOutcomeReader;
  readonly blockingReview: BlockingReviewReader;
}

/**
 * The guarantee table a terminal message carries, built by guaranteeTableOf from its records. Records
 * that do not hold together are the unreadable table, logged at warn with why, so the message still
 * goes out judging nothing; any other failure throws for a retry.
 */
async function readGuaranteeTable(db: DbHandle, source: TableSource): Promise<GuaranteeTable> {
  try {
    return guaranteeTableOf(await tableRecordsOf(db, source));
  } catch (err) {
    if (!tableRecordsUnreadable(err)) throw err;
    const where = source.kind === "sweep" ? `sweep ${source.sweepId}` : `project ${source.projectId}`;
    console.warn(`[terminal-report] ${where}: its guarantee table cannot be read, so its message judges no guarantee: ${describeErrorChain(err)}`);
    return guaranteeTableOf({ kind: "unreadable", sweepId: source.kind === "sweep" ? source.sweepId : null });
  }
}

/** The table of the terminal's own sweep when one is on record, else of the project's vision in force on no sweep. */
function terminalSource(sweepId: string | null, projectId: string): TableSource {
  return sweepId === null ? { kind: "no-sweep", projectId } : { kind: "sweep", sweepId };
}

/** work_items.merge_kind; NULL on a record from before merge kinds were recorded. */
const MergeKindSchema = z.enum(["merged", "already_delivered"]).nullable();

/** A work item's stored merge_kind is none its CHECK admits: the stop report cannot state how it closed. */
class MergeKindUnreadable extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly workItemId: string,
    readonly stored: unknown,
    readonly detail: string,
  ) {
    super(
      `cannot report the stop of project ${projectId}: work item ${workItemId} records merge_kind ` +
        `${JSON.stringify(stored)}, expected 'merged', 'already_delivered' or NULL: ${detail}`,
    );
    this.name = "MergeKindUnreadable";
  }
}

/**
 * Every task of the project with a commit on record, oldest first. A Task is merged when its merge
 * record holds the commit Z0's merge step made on main, written before the Task is completed.
 * Neither task status nor the dev_sessions attempt log is the evidence: an operator can set a Task
 * Completed over the HTTP API with nothing merged, a Task preempted to Abandoned may have merged
 * before the preemption, and a session's terminal write is fail-soft.
 */
async function mergedTasksOf(db: DbHandle, projectId: ProjectId): Promise<MergedTask[]> {
  const rows = await tasksWithMerge(db, projectId);
  const merged: MergedTask[] = [];
  for (const row of rows) {
    if (row.commit === null) continue;
    const kind = MergeKindSchema.safeParse(row.kind);
    if (!kind.success) throw new MergeKindUnreadable(projectId, row.id, row.kind, z.prettifyError(kind.error));
    merged.push({ title: row.title, commit: row.commit, kind: kind.data });
  }
  return merged;
}

/** Every stop that stopped its project, still stopped, its report untold, oldest consumed first, with its terminal sweep's table. */
async function dueStops(db: DbHandle): Promise<Array<DueTerminal | UnreadSubject>> {
  const rows = await dueStopReportMessages(db);
  const subject = (row: (typeof rows)[number]) => ({
    id: terminalSubjectId({ kind: "stopped", stopId: row.stopId }),
    projectId: parseProjectId(row.projectId, "client_messages.project_id"),
  });
  return readEach(rows, subject, async (row): Promise<DueTerminal> => {
    const { projectId } = subject(row);
    const sweepId = await sweepOfTerminal(db, { kind: "stop", stopId: row.stopId });
    const stop = { stopId: row.stopId, projectId, merged: await mergedTasksOf(db, projectId), paused: row.paused === true, accepted: row.accepted };
    return { kind: "listed", event: { kind: "stopped", projectId, stop }, table: await readGuaranteeTable(db, terminalSource(sweepId, projectId)) };
  });
}

/**
 * Every halt episode Delivery publishes whose report is untold, oldest halt first, with its terminal
 * sweep's table and the records its register reads. A halt ended by an unblock or a passing probe
 * before its report was posted is still told, and its resumption after it; one the client's stop
 * ended is told by the stop report, and a project the client stopped, or has a stop awaiting the
 * Liaison, is told no halt. An episode whose resumption the client has already heard is never told
 * the halt after it, and a planning_stopped halt is told by the planning-stopped message.
 */
async function dueHalts(db: DbHandle, blockingReview: BlockingReviewReader): Promise<Array<DueTerminal | UnreadSubject>> {
  const episodes = await haltEpisodesWhere(db, (episode) =>
    and(
      or(episode.open, and(episode.resumed, sql`NOT ${resumptionTold(episode.id)}`)),
      sql`NOT ${terminalTold("halted", episode.id)}`,
      haltsToldOf(episode.projectId),
      notCoveredByPlanningStoppedReport(episode),
    ),
  );
  return readEach(
    episodes,
    (row) => ({ id: terminalSubjectId({ kind: "halted", episodeId: row.id }), projectId: parseProjectId(row.projectId, "project_blocks.project_id") }),
    async (row): Promise<DueTerminal> => {
      const halt = await haltReportOf(db, row, blockingReview);
      const sweepId = await sweepOfTerminal(db, { kind: "halt", blockId: row.id });
      return {
        kind: "listed",
        event: { kind: "halted", projectId: halt.projectId, halt, risk: await readRiskRecords(db, halt.projectId) },
        table: await readGuaranteeTable(db, terminalSource(sweepId, halt.projectId)),
      };
    },
  );
}

/** The sweep's table read on its own, for the acceptance notice; a failure that is not of the records waits for a retry. */
async function tableOfUnread(db: DbHandle, sweepId: string): Promise<GuaranteeTable | TableNotRead> {
  try {
    return await readGuaranteeTable(db, { kind: "sweep", sweepId });
  } catch (error) {
    // The failed read is kept as the notice's table-not-read, which counts as a failed attempt and is retried.
    return { kind: "not-read", error };
  }
}

/**
 * Every passed sweep of an accepted project whose delivered report is untold and is not waiting out
 * the backoff of a failed attempt, oldest first, with what the report is rendered from and the
 * sweep's table. A sweep whose records cannot be read is listed with why, so one project's records
 * never stop another's report. A project the client stopped, or has a stop awaiting the Liaison, is
 * not reported on: its stop report is what it is told, and says the acceptance stands.
 */
async function dueDelivered(db: DbHandle, sweepOutcome: SweepOutcomeReader): Promise<DueTerminal[]> {
  const sweeps = await passedSweepsWhere(
    db,
    (sweep) =>
      sql`(NOT ${terminalTold("delivered", sweep.id)}
        AND EXISTS (SELECT 1 FROM projects ap WHERE ap.id = ${sweep.projectId} AND ap.lifecycle = 'accepted')
        AND ${noOpenStop(sweep.projectId)} AND ${deliveredRetryDue(sweep)})`,
    deliveredAttempts,
  );
  const due: DueTerminal[] = [];
  for (const sweep of sweeps) {
    const row = { id: sweep.id, projectId: parseProjectId(sweep.projectId, "acceptance_sweeps.project_id"), mainCommit: sweep.mainCommit, ...attemptsOf(sweep.annotation) };
    try {
      const report = await deliveredReportOf(db, row, sweepOutcome);
      due.push({ kind: "delivered", report, table: await readGuaranteeTable(db, { kind: "sweep", sweepId: row.id }) });
    } catch (error) {
      // Only a database that could not be reached says nothing of the records, and is retried
      // uncounted; every other failure counts toward the notice sent in the report's place, so one
      // nothing names is never retried unseen for good.
      // eslint-disable-next-line ashara/catch-continue -- best effort: the failure is kept as the row's unread entry with its cause, which counts toward the notice sent in the report's place
      const cause = isDatabaseConnectionFault(error) ? "connection" : "record";
      const report = { kind: "unread", cause, failures: row.failures, recordFailures: row.recordFailures, sweepId: row.id, projectId: row.projectId, error } as const;
      due.push({ kind: "delivered-unread", report, table: await tableOfUnread(db, row.id) });
    }
  }
  return due;
}

/** Every project whose first planning stopped, still halted on it, its message untold and no stop awaiting the Liaison, oldest first. */
async function duePlanningStopped(db: DbHandle): Promise<Array<DueTerminal | UnreadSubject>> {
  const rows = await stoppedPlanningsWhere(db, (projectId) => sql`(NOT ${terminalTold("planning-stopped", projectId)} AND ${noOpenStop(projectId)})`);
  return readEach(
    rows,
    (row) => {
      const projectId = parseProjectId(row.projectId, "projects.id");
      return { id: terminalSubjectId({ kind: "planning-stopped", projectId }), projectId };
    },
    async (row): Promise<DueTerminal> => {
      const projectId = parseProjectId(row.projectId, "projects.id");
      return {
        kind: "listed",
        event: { kind: "planning-stopped", projectId, attempts: row.attempts, risk: await readRiskRecords(db, projectId) },
        table: await readGuaranteeTable(db, { kind: "no-sweep", projectId }),
      };
    },
  );
}

/**
 * Every project at work or halted whose contract in force Ashara declines (unverifiableContractHeld),
 * its decline untold and no stop awaiting the Liaison, oldest first: the table of its vision in force
 * names each guarantee as not verified by Ashara.
 */
async function dueDeclined(db: DbHandle): Promise<Array<DueTerminal | UnreadSubject>> {
  const rows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(projectActive(), unverifiableContractHeld(projects.id), sql`NOT ${terminalTold("declined", projects.id)}`, noOpenStop(projects.id)))
    .orderBy(asc(projects.createdAt), asc(projects.id));
  return readEach(
    rows,
    (row) => {
      const projectId = parseProjectId(row.id, "projects.id");
      return { id: terminalSubjectId({ kind: "declined", projectId }), projectId };
    },
    async (row): Promise<DueTerminal> => {
      const projectId = parseProjectId(row.id, "projects.id");
      return { kind: "listed", event: { kind: "declined", projectId }, table: await readGuaranteeTable(db, { kind: "no-sweep", projectId }) };
    },
  );
}

/**
 * Every terminal message owed, of every kind: the one due listing. The stops come first, so a
 * project the client stopped is told its stop report before anything else is listed of it; the
 * delivered reports, each read on its own and kept as unread on any failure, come last.
 */
export async function listDueTerminals(db: DbHandle, readers: TerminalReaders): Promise<Array<DueTerminal | UnreadSubject>> {
  return [
    ...(await dueStops(db)),
    ...(await dueHalts(db, readers.blockingReview)),
    ...(await duePlanningStopped(db)),
    ...(await dueDeclined(db)),
    ...(await dueDelivered(db, readers.sweepOutcome)),
  ];
}

/** A delivered report was asked to be posted for a sweep that does not exist or did not pass. */
class AcceptedSweepNotFound extends Error {
  constructor(readonly sweepId: string) {
    super(`cannot post the delivered report on acceptance sweep ${sweepId}: no passed acceptance_sweeps row has that id`);
    this.name = "AcceptedSweepNotFound";
  }
}

/** A stop report was asked to be posted for a stop that is not an inbound stop of a project. */
class StopNotFound extends Error {
  constructor(readonly stopId: string) {
    super(`cannot post the report of stop ${stopId}: no inbound stop has that id`);
    this.name = "StopNotFound";
  }
}

/**
 * Posts a terminal message with its table's verdicts and records its subject told, in one
 * transaction, so a retried, concurrent or restarted post tells the client once: a delivered
 * report or acceptance notice once per sweep and a halt's report once per episode by their told
 * records; the stop report (in reply to the stop), the planning-stopped report and the decline once
 * per project by the unique index on (project_id, reports_on).
 */
export async function postTerminalMessage(db: DbHandle, message: TerminalMessage): Promise<"posted" | "already-posted"> {
  const { subject, body, verdicts } = message;
  switch (subject.kind) {
    case "delivered": {
      const projectId = await passedSweepProject(db, subject.sweepId);
      if (projectId === null) throw new AcceptedSweepNotFound(subject.sweepId);
      return tellOnce(db, { kind: "delivered", id: subject.sweepId }, async (tx) => {
        const reportId = await insertOutboundReport(tx, projectId, body, null, `post the delivered report of acceptance sweep ${subject.sweepId}`);
        await insertGuaranteeVerdicts(tx, projectId, reportId, verdicts);
        return { projectId, reportId };
      });
    }
    case "halted": {
      const episode = await reportedEpisode(db, subject.episodeId);
      return tellOnce(db, { kind: "project-blocked", id: subject.episodeId }, async (tx) => {
        const reportId = await insertOutboundReport(tx, episode.projectId, body, null, `post a halt report to project ${episode.projectId}`);
        await insertGuaranteeVerdicts(tx, episode.projectId, reportId, verdicts);
        return { projectId: episode.projectId, reportId };
      });
    }
    case "stopped":
      return db.transaction(async (tx): Promise<"posted" | "already-posted"> => {
        const posting = await postOnStop(tx, subject.stopId, body);
        if (posting.kind === "not-a-stop") throw new StopNotFound(subject.stopId);
        if (posting.kind === "already-posted") return "already-posted";
        await insertGuaranteeVerdicts(tx, posting.projectId, posting.reportId, verdicts);
        return "posted";
      });
    case "planning-stopped":
    case "declined": {
      const reportsOn = subject.kind === "declined" ? REPORT_SUBJECT.declined : REPORT_SUBJECT.planningStopped;
      return db.transaction(async (tx): Promise<"posted" | "already-posted"> => {
        const reportId = await postOnSubject(tx, { projectId: subject.projectId, body, inReplyTo: null, reportsOn }, "skip");
        if (reportId === null) return "already-posted";
        await insertGuaranteeVerdicts(tx, subject.projectId, reportId, verdicts);
        return "posted";
      });
    }
  }
}
