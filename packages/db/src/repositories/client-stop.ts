import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { parseProjectId, type ProjectId } from "@ashara/shared";
import type { Database } from "../connection.js";
import { clientMessages, projects, workItems } from "../schema.js";
import { ClientMessageRepository } from "./client-message.js";

// The client's stop (migration 028). The Liaison consumes each inbound 'stop',
// moves the project to 'stopped' and posts one report on it, together.

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
      `cannot stop project ${projectId}: expected status active, blocked or stopped, found ` +
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
  return rows.map((row) => ({ id: row.id, projectId: parseProjectId(row.projectId) }));
}

/**
 * One stop, in one transaction: the stop consumed first (its row lock
 * serialises two consumers of it), then an active or blocked project moved to
 * 'stopped' and the report, composed from the project's merged tasks, posted
 * once. A project already stopped gets only the consumption.
 */
export async function recordClientStop(
  db: Database,
  stop: OpenStopRow,
  composeReport: (mergedTaskTitles: readonly string[]) => string,
): Promise<ClientStopCommit> {
  return db.transaction(async (tx) => {
    await new ClientMessageRepository(tx).markConsumed(stop.id);

    const [moved] = await tx
      .update(projects)
      .set({ status: "stopped" })
      .where(and(eq(projects.id, stop.projectId), inArray(projects.status, ["active", "blocked"])))
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

    // A Task is merged when one of its dev sessions closed Completed: that write
    // follows only a completed DevelopmentService outcome, which only
    // finalizeSuccess produces, after it commits the merge (with no target
    // workspace it fails). Task status is not the evidence: an operator can set a
    // Task Completed over the HTTP API with nothing merged, and a Task preempted
    // to Abandoned may have merged before the preemption.
    const merged = await tx
      .select({ title: workItems.title })
      .from(workItems)
      .where(
        and(
          eq(workItems.projectId, stop.projectId),
          eq(workItems.level, "Task"),
          sql`EXISTS (SELECT 1 FROM dev_sessions d WHERE d.task_id = ${workItems.id} AND d.phase = 'Completed')`,
        ),
      )
      .orderBy(asc(workItems.updatedAt), asc(workItems.id));
    const titles = merged.map((row) => row.title);

    const inserted = await tx
      .insert(clientMessages)
      .values({
        projectId: stop.projectId,
        direction: "outbound",
        kind: "report",
        body: composeReport(titles),
        inReplyTo: stop.id,
        reportsOn: "client-stop",
      })
      .onConflictDoNothing({
        target: [clientMessages.projectId, clientMessages.reportsOn],
        where: isNotNull(clientMessages.reportsOn),
      })
      .returning({ id: clientMessages.id });
    return { kind: "stopped", reported: inserted.length === 1, merged: titles.length };
  });
}
