import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { z } from "zod";
import { acceptanceSweeps, clientMessages, projects, workItems } from "@ashara/db";
import type { Database, DbHandle } from "@ashara/db";
import { parseProjectId, readEach, type ProjectId, type UnreadSubject } from "@ashara/shared";
import { stopProject } from "../project-lifecycle.js";
import type { GuaranteeTable, TableVerdicts } from "../guarantee-report.js";
import { REPORT_SUBJECT } from "../report-subjects.js";
import { ClientMessageRepository } from "./client-message.js";
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

/** Inbound stops not yet consumed, of any project status, oldest first. */
export async function listUnconsumedStops(db: Database): Promise<OpenStopRow[]> {
  const rows = await db
    .select({ id: clientMessages.id, projectId: clientMessages.projectId })
    .from(clientMessages)
    .where(
      and(
        eq(clientMessages.direction, "inbound"),
        eq(clientMessages.kind, "stop"),
        isNull(clientMessages.consumedAt),
      ),
    )
    .orderBy(asc(clientMessages.createdAt), asc(clientMessages.id));
  return rows.map((row) => ({ id: row.id, projectId: parseProjectId(row.projectId, "client_messages.project_id") }));
}

/** Whether the project's stop report is posted. */
function stopReportPosted(projectId: string | SQL): SQL<boolean> {
  return sql<boolean>`EXISTS (SELECT 1 FROM client_messages r WHERE r.project_id = ${projectId} AND r.reports_on = ${REPORT_SUBJECT.clientStop})`;
}

/**
 * One stop, in one transaction: the stop consumed first (its row lock serialises two consumers of
 * it), then an active (halted or not) or accepted project moved to 'stopped', and the stop marked as
 * the one that stopped it with whether Delivery had it halted then. A project already stopped gets
 * only the consumption.
 */
export async function recordClientStop(db: Database, stop: OpenStopRow): Promise<ClientStopCommit> {
  return db.transaction(async (tx) => {
    await new ClientMessageRepository(tx).markConsumed(stop.id);

    // An accepted project waits for exactly this.
    const moved = await stopProject(tx, stop.projectId);
    if (moved.kind === "already-stopped") return moved;
    await tx.update(clientMessages).set({ stopFoundHalted: moved.wasHalted }).where(eq(clientMessages.id, stop.id));
    const [reported] = await tx.select({ posted: stopReportPosted(stop.projectId) }).from(projects).where(eq(projects.id, stop.projectId));
    return { kind: "stopped", reportDue: reported?.posted === false };
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
  const rows = await db
    .select({ id: workItems.id, title: workItems.title, commit: workItems.mergeCommit, kind: workItems.mergeKind })
    .from(workItems)
    .where(and(eq(workItems.projectId, projectId), eq(workItems.level, "Task"), isNotNull(workItems.mergeCommit)))
    .orderBy(asc(workItems.updatedAt), asc(workItems.id));
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
  const rows = await db
    .select({ stopId: clientMessages.id, projectId: clientMessages.projectId, paused: clientMessages.stopFoundHalted, sweepId: acceptanceSweeps.id })
    .from(clientMessages)
    .innerJoin(projects, eq(projects.id, clientMessages.projectId))
    .leftJoin(acceptanceSweeps, eq(acceptanceSweeps.stopId, clientMessages.id))
    .where(
      and(
        eq(clientMessages.direction, "inbound"),
        eq(clientMessages.kind, "stop"),
        isNotNull(clientMessages.stopFoundHalted),
        eq(projects.lifecycle, "stopped"),
        sql`NOT ${stopReportPosted(sql`${clientMessages.projectId}`)}`,
      ),
    )
    .orderBy(asc(clientMessages.consumedAt), asc(clientMessages.id));
  return readEach(
    rows,
    (row) => ({ id: `report:${row.stopId}`, projectId: parseProjectId(row.projectId, "client_messages.project_id") }),
    async (row): Promise<DueStopReportRow> => {
      const projectId = parseProjectId(row.projectId, "client_messages.project_id");
      return {
        stopId: row.stopId,
        projectId,
        merged: await mergedTasksOf(db, projectId),
        paused: row.paused === true,
        guarantees: await readGuaranteeTable(db, row.sweepId === null ? { kind: "no-sweep", projectId } : { kind: "sweep", sweepId: row.sweepId }),
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
    const [stop] = await tx
      .select({ projectId: clientMessages.projectId })
      .from(clientMessages)
      .where(and(eq(clientMessages.id, stopId), eq(clientMessages.direction, "inbound"), eq(clientMessages.kind, "stop")));
    if (stop === undefined) throw new StopNotFound(stopId);
    const inserted = await tx
      .insert(clientMessages)
      .values({ projectId: stop.projectId, direction: "outbound", kind: "report", body, inReplyTo: stopId, reportsOn: REPORT_SUBJECT.clientStop })
      .onConflictDoNothing({
        target: [clientMessages.projectId, clientMessages.reportsOn],
        where: isNotNull(clientMessages.reportsOn),
      })
      .returning({ id: clientMessages.id });
    const [report] = inserted;
    if (report === undefined) return "already-posted";
    await insertGuaranteeVerdicts(tx, stop.projectId, report.id, verdicts);
    return "posted";
  });
}
