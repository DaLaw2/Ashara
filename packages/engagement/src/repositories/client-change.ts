import { and, asc, eq, isNull } from "drizzle-orm";
import { clientMessages, domainEvents } from "@ashara/db";
import type { Database } from "@ashara/db";
import { parseProjectId, type DomainEvent, type ProjectId } from "@ashara/shared";
import { ClientMessageRepository } from "./client-message.js";

// The client's change of direction (migration 016 kind 'change'). Until a change is applied to a
// project under way (M3 X5), the Liaison consumes each one with a plain reply that says so, and a
// domain event, together: a change is never left unread and never answered twice.

interface OpenChangeRow {
  readonly id: string;
  readonly projectId: ProjectId;
}

/** Inbound changes not yet consumed, of any project status, oldest first. */
export async function listUnconsumedChanges(db: Database): Promise<OpenChangeRow[]> {
  const rows = await db
    .select({ id: clientMessages.id, projectId: clientMessages.projectId })
    .from(clientMessages)
    .where(
      and(
        eq(clientMessages.direction, "inbound"),
        eq(clientMessages.kind, "change"),
        isNull(clientMessages.consumedAt),
      ),
    )
    .orderBy(asc(clientMessages.createdAt), asc(clientMessages.id));
  return rows.map((row) => ({ id: row.id, projectId: parseProjectId(row.projectId, "client_messages.project_id") }));
}

/**
 * One change, in one transaction: the change consumed first (its row lock serialises two
 * consumers, and a change already consumed throws ClientMessageNotConsumable), then the reply
 * posted in reply to it and the event recorded. Returns the reply's id.
 */
export async function recordClientChangeDeferred(
  db: Database,
  change: OpenChangeRow,
  reply: string,
  event: DomainEvent,
): Promise<string> {
  return db.transaction(async (tx) => {
    const messages = new ClientMessageRepository(tx);
    await messages.markConsumed(change.id);
    const posted = await messages.insertOutbound({
      projectId: change.projectId,
      kind: "report",
      body: reply,
      inReplyTo: change.id,
    });
    await tx.insert(domainEvents).values({
      eventId: event.eventId,
      eventType: event.eventType,
      timestamp: event.timestamp,
      sourceContext: event.sourceContext,
      correlationId: event.correlationId ?? null,
      payload: { ...event.payload, replyMessageId: posted.id },
    });
    return posted.id;
  });
}
