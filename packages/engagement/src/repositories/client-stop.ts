import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { z } from "zod";
import { clientMessages, projects, workItems } from "@ashara/db";
import type { Database } from "@ashara/db";
import { PROJECT_STATUSES, parseProjectId, type ProjectId } from "@ashara/shared";
import { ClientMessageRepository } from "./client-message.js";

// The client's stop (migration 028). The Liaison consumes each inbound 'stop',
// moves the project to 'stopped' and posts one report on it, together.

/** work_items.merge_kind (migration 049); NULL on a record from before it. */
const MergeKindSchema = z.enum(["merged", "already_delivered"]).nullable();

/** A work item's stored merge_kind is none the migration 049 CHECK admits: the stop report cannot state how it closed. */
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

/** Every status the stop moves to 'stopped'; 'stopped' itself is already stopped. */
const STOPPABLE_STATUSES = PROJECT_STATUSES.filter((status) => status !== "stopped");

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
  /** `reported` is false only when a stop report already existed (an operator re-activated a stopped project). */
  | { readonly kind: "stopped"; readonly reported: boolean; readonly merged: number }
  | { readonly kind: "already-stopped" };

/** The project a stop names is in a status the stop transaction does not know. */
class ProjectStatusUnknown extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly status: string | null,
  ) {
    super(
      `cannot stop project ${projectId}: expected one of the statuses ${PROJECT_STATUSES.join(", ")}, found ` +
        `${status === null ? "no project row" : `'${status}'`}`,
    );
    this.name = "ProjectStatusUnknown";
  }
}

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

/**
 * One stop, in one transaction: the stop consumed first (its row lock
 * serialises two consumers of it), then an active or blocked project moved to
 * 'stopped' and the report, composed from the project's merged tasks and whether
 * it was paused (blocked) when the stop arrived, posted once. A project already
 * stopped gets only the consumption.
 */
export async function recordClientStop(
  db: Database,
  stop: OpenStopRow,
  composeReport: (merged: readonly MergedTaskRow[], paused: boolean) => string,
): Promise<ClientStopCommit> {
  return db.transaction(async (tx) => {
    await new ClientMessageRepository(tx).markConsumed(stop.id);

    const [before] = await tx.select({ status: projects.status }).from(projects).where(eq(projects.id, stop.projectId)).for("update");

    // An accepted project (migration 049) waits for exactly this.
    const [moved] = await tx
      .update(projects)
      .set({ status: "stopped" })
      .where(and(eq(projects.id, stop.projectId), inArray(projects.status, STOPPABLE_STATUSES)))
      .returning({ id: projects.id });
    if (!moved) {
      const [existing] = await tx
        .select({ status: projects.status })
        .from(projects)
        .where(eq(projects.id, stop.projectId))
        .limit(1);
      if (existing?.status === "stopped") return { kind: "already-stopped" };
      throw new ProjectStatusUnknown(stop.projectId, existing?.status ?? null);
    }

    // A Task is merged when its merge record holds the commit Z0's merge step made
    // on main (migration 041), written before the Task is completed. Neither task
    // status nor the dev_sessions attempt log is the evidence: an operator can set
    // a Task Completed over the HTTP API with nothing merged, a Task preempted to
    // Abandoned may have merged before the preemption, and a session's terminal
    // write is fail-soft.
    const rows = await tx
      .select({ id: workItems.id, title: workItems.title, commit: workItems.mergeCommit, kind: workItems.mergeKind })
      .from(workItems)
      .where(
        and(
          eq(workItems.projectId, stop.projectId),
          eq(workItems.level, "Task"),
          isNotNull(workItems.mergeCommit),
        ),
      )
      .orderBy(asc(workItems.updatedAt), asc(workItems.id));
    const merged: MergedTaskRow[] = [];
    for (const row of rows) {
      if (row.commit === null) continue;
      const kind = MergeKindSchema.safeParse(row.kind);
      if (!kind.success) throw new MergeKindUnreadable(stop.projectId, row.id, row.kind, z.prettifyError(kind.error));
      merged.push({ title: row.title, commit: row.commit, kind: kind.data });
    }

    const inserted = await tx
      .insert(clientMessages)
      .values({
        projectId: stop.projectId,
        direction: "outbound",
        kind: "report",
        body: composeReport(merged, before?.status === "blocked"),
        inReplyTo: stop.id,
        reportsOn: "client-stop",
      })
      .onConflictDoNothing({
        target: [clientMessages.projectId, clientMessages.reportsOn],
        where: isNotNull(clientMessages.reportsOn),
      })
      .returning({ id: clientMessages.id });
    return { kind: "stopped", reported: inserted.length === 1, merged: merged.length };
  });
}
