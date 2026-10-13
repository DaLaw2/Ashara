import { desc } from "drizzle-orm";
import type { Database } from "../connection.js";
import { domainEvents } from "../schema.js";

export class EventStoreRepository {
  constructor(private readonly db: Database) {}

  async publish(
    event: {
      eventId: string;
      eventType: string;
      timestamp: Date;
      sourceContext: string;
      correlationId?: string;
      // open-by-design: event payload is BC-specific, matches DomainEvent.payload
      payload: Record<string, unknown>;
    },
  ) {
    await this.db.insert(domainEvents).values({
      eventId: event.eventId,
      eventType: event.eventType,
      timestamp: event.timestamp,
      sourceContext: event.sourceContext,
      correlationId: event.correlationId ?? null,
      payload: event.payload,
    });
  }

  async listRecent(limit: number) {
    return this.db
      .select()
      .from(domainEvents)
      .orderBy(desc(domainEvents.timestamp))
      .limit(limit);
  }
}
