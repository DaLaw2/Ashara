import { pgTable, uuid, varchar, jsonb } from "drizzle-orm/pg-core";
import { timestamptz } from "./columns.js";

// Generic: the domain event log (audit, and the loop's wake).

// ---------------------------------------------------------------------------
// domain_events
// ---------------------------------------------------------------------------

export const domainEvents = pgTable("domain_events", {
  eventId: uuid("event_id").primaryKey(),
  eventType: varchar("event_type", { length: 100 }).notNull(),
  timestamp: timestamptz().notNull(),
  sourceContext: varchar("source_context", { length: 50 }).notNull(),
  correlationId: uuid("correlation_id"),
  payload: jsonb().notNull().default({}),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});
