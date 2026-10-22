import { z } from "zod";
import type { Database, DbHandle } from "@ashara/db";
import { parseProjectId, readEach, type ProjectId, type UnreadSubject } from "@ashara/shared";
import { tasksWithMerge } from "@ashara/delivery/reads";
import { sweepOfTerminal } from "@ashara/quality/published-reads";
import type { EndHaltOnStop } from "../ports.js";
import { stopProject } from "../project-lifecycle.js";
import type { GuaranteeTable, TableVerdicts } from "../guarantee-report.js";
import {
  ClientMessageNotConsumable,
  LockedStanding,
  consumeInbound,
  dueStopReportMessages,
  postOnStop,
  recordStopFoundHalted,
  stopReportPosted,
  unconsumedStopMessages,
} from "./client-message.js";
import { insertGuaranteeVerdicts, readGuaranteeTable } from "./guarantee-report.js";

// The client's stop. The Liaison consumes each inbound 'stop' and moves the project to 'stopped',
// together, recording on the stop whether the project was halted then. The stop's report is posted
// once per project with its table's verdicts: the table of the stop's terminal sweep, which the cycle
// runs before its stop reports, or, for a stop whose sweep is not on record (its recording failed),
// every guarantee unjudged with no sweep on a commit.

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

/** A task with a commit on record, and how that commit closed it (null: not recorded). */
interface MergedTaskRow {
  readonly title: string;
  readonly commit: string;
  readonly kind: z.infer<typeof MergeKindSchema>;
}

interface OpenStopRow {
  readonly id: string;
  readonly projectId: ProjectId;
}

type ClientStopCommit =
  /** `reportDue` is false only when a stop report already exists (an operator re-activated a stopped project). */
  | { readonly kind: "stopped"; readonly reportDue: boolean }
  | { readonly kind: "already-stopped" };

/** Inbound stops not yet consumed, read now by inboundDecision (clientMessageReadNow), oldest first. */
export async function listUnconsumedStops(db: DbHandle): Promise<OpenStopRow[]> {
  const rows = await unconsumedStopMessages(db);
  return rows.map((row) => ({ id: row.id, projectId: parseProjectId(row.projectId, "client_messages.project_id") }));
}

/** inboundDecision reads a stop in every state of an existing project: one it does not read now is a stop of no project, or a decision that no longer holds together. */
class StopNotReadNow extends Error {
  constructor(
    readonly stopId: string,
    readonly detail: string,
  ) {
    super(`client stop ${stopId} cannot be consumed: ${detail}`);
    this.name = "StopNotReadNow";
  }
}

/**
 * One stop, in one transaction: the project row locked and the stop consumed first (its row lock
 * serialises two consumers of it), then an active (halted or not) or accepted project moved to
 * 'stopped', and the stop marked as the one that stopped it with whether Delivery had it halted then; a halt it finds is ended by
 * Delivery's `endHalt` in the same transaction. A project already stopped gets only the consumption.
 */
export async function recordClientStop(db: Database, stop: OpenStopRow, endHalt: EndHaltOnStop): Promise<ClientStopCommit> {
  return db.transaction(async (tx) => {
    const standing = await LockedStanding.readNow(tx, stop.projectId, "stop", null);
    if (!(standing instanceof LockedStanding)) throw new StopNotReadNow(stop.id, standing.detail);
    if ((await consumeInbound(standing, stop.id)) === "not-open") throw new ClientMessageNotConsumable(stop.id);

    // An accepted project waits for exactly this.
    const moved = await stopProject(tx, stop.projectId, endHalt);
    if (moved.kind === "already-stopped") return moved;
    await recordStopFoundHalted(standing, stop.id, moved.wasHalted);
    return { kind: "stopped", reportDue: (await stopReportPosted(tx, stop.projectId)) === false };
  });
}

/**
 * Every task of the project with a commit on record, oldest first. A Task is merged when its merge
 * record holds the commit Z0's merge step made on main, written before the Task is completed.
 * Neither task status nor the dev_sessions attempt log is the evidence: an operator can set a Task
 * Completed over the HTTP API with nothing merged, a Task preempted to Abandoned may have merged
 * before the preemption, and a session's terminal write is fail-soft.
 */
async function mergedTasksOf(db: DbHandle, projectId: ProjectId): Promise<MergedTaskRow[]> {
  const rows = await tasksWithMerge(db, projectId);
  const merged: MergedTaskRow[] = [];
  for (const row of rows) {
    if (row.commit === null) continue;
    const kind = MergeKindSchema.safeParse(row.kind);
    if (!kind.success) throw new MergeKindUnreadable(projectId, row.id, row.kind, z.prettifyError(kind.error));
    merged.push({ title: row.title, commit: row.commit, kind: kind.data });
  }
  return merged;
}

/** A stop that stopped its project, whose report is due. */
interface DueStopReportRow {
  readonly stopId: string;
  readonly projectId: ProjectId;
  readonly merged: readonly MergedTaskRow[];
  readonly paused: boolean;
  readonly guarantees: GuaranteeTable;
}

/**
 * Every stop that stopped its project, still stopped, whose project has no stop report yet, oldest
 * first, with its terminal sweep when one is on record. Each is read on its own (readEach): one whose records
 * do not read as a report is its UnreadSubject, and every other report is still listed.
 */
export async function listDueStopReports(db: DbHandle): Promise<Array<DueStopReportRow | UnreadSubject>> {
  const rows = await dueStopReportMessages(db);
  return readEach(
    rows,
    (row) => ({ id: `report:${row.stopId}`, projectId: parseProjectId(row.projectId, "client_messages.project_id") }),
    async (row): Promise<DueStopReportRow> => {
      const projectId = parseProjectId(row.projectId, "client_messages.project_id");
      const sweepId = await sweepOfTerminal(db, { kind: "stop", stopId: row.stopId });
      return {
        stopId: row.stopId,
        projectId,
        merged: await mergedTasksOf(db, projectId),
        paused: row.paused === true,
        guarantees: await readGuaranteeTable(db, sweepId === null ? { kind: "no-sweep", projectId } : { kind: "sweep", sweepId }),
      };
    },
  );
}

/** A stop report was asked to be posted for a stop that is not an inbound stop of a project. */
class StopNotFound extends Error {
  constructor(readonly stopId: string) {
    super(`cannot post the report of stop ${stopId}: no inbound stop has that id`);
    this.name = "StopNotFound";
  }
}

/**
 * Posts the stop's report in reply to it, with its table's verdicts, in one transaction; once per
 * project (the unique index on (project_id, reports_on)).
 */
export async function postClientStopReport(db: Database, stopId: string, body: string, verdicts: TableVerdicts): Promise<"posted" | "already-posted"> {
  return db.transaction(async (tx) => {
    const posting = await postOnStop(tx, stopId, body);
    if (posting.kind === "not-a-stop") throw new StopNotFound(stopId);
    if (posting.kind === "already-posted") return "already-posted";
    await insertGuaranteeVerdicts(tx, posting.projectId, posting.reportId, verdicts);
    return "posted";
  });
}
