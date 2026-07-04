import { eq, asc, desc, sql } from "drizzle-orm";

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
      payload: Record<string, unknown>;
    },
    priority: "External" | "Internal",
  ) {
    await this.db.insert(domainEvents).values({
      eventId: event.eventId,
      eventType: event.eventType,
      timestamp: event.timestamp,
      sourceContext: event.sourceContext,
      correlationId: event.correlationId ?? null,
      payload: event.payload,
      priority,
    });
  }

  async pollUnprocessed() {
    return this.db
      .select()
      .from(domainEvents)
      .where(eq(domainEvents.processed, false))
      .orderBy(
        sql`CASE WHEN ${domainEvents.priority} = 'External' THEN 0 ELSE 1 END`,
        asc(domainEvents.timestamp),
      );
  }

  async markProcessed(eventId: string) {
    await this.db
      .update(domainEvents)
      .set({ processed: true })
      .where(eq(domainEvents.eventId, eventId));
  }

  async listRecent(limit: number) {
    return this.db
      .select()
      .from(domainEvents)
      .orderBy(desc(domainEvents.timestamp))
      .limit(limit);
  }
}
