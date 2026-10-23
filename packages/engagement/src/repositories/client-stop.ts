import type { Database, DbHandle } from "@ashara/db";
import { parseProjectId, type ProjectId } from "@ashara/shared";
import type { EndHaltOnStop } from "../ports.js";
import { stopProject } from "../project-lifecycle.js";
import { ClientMessageNotConsumable, LockedStanding, consumeInbound, recordStopFound, stopReportPosted, unconsumedStopMessages } from "./client-message.js";

// The client's stop. The Liaison consumes each inbound 'stop' and moves the project to 'stopped',
// together, recording on the stop whether the project was halted, and whether it was accepted, then.
// The stop's report is a terminal message (repositories/terminal-report.ts), posted once per project.

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
 * 'stopped', and the stop marked as the one that stopped it with whether Delivery had it halted and
 * whether it was accepted then; a halt it finds is ended by Delivery's `endHalt` in the same
 * transaction. A project already stopped gets only the consumption.
 */
export async function recordClientStop(db: Database, stop: OpenStopRow, endHalt: EndHaltOnStop): Promise<ClientStopCommit> {
  return db.transaction(async (tx) => {
    const standing = await LockedStanding.readNow(tx, stop.projectId, "stop", null);
    if (!(standing instanceof LockedStanding)) throw new StopNotReadNow(stop.id, standing.detail);
    if ((await consumeInbound(standing, stop.id)) === "not-open") throw new ClientMessageNotConsumable(stop.id);

    // An accepted project waits for exactly this.
    const moved = await stopProject(tx, stop.projectId, endHalt);
    if (moved.kind === "already-stopped") return moved;
    await recordStopFound(standing, stop.id, { halted: moved.wasHalted, accepted: moved.wasAccepted });
    return { kind: "stopped", reportDue: (await stopReportPosted(tx, stop.projectId)) === false };
  });
}
