import { pgTable, uuid, varchar, text } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { timestamptz } from "./columns.js";
import { workItems } from "./delivery.js";
import { projects } from "./project.js";

// Knowledge: project knowledge and failed approaches.

// ---------------------------------------------------------------------------
// knowledge_entries
// ---------------------------------------------------------------------------

export const knowledgeEntries = pgTable("knowledge_entries", {
  id: uuid().primaryKey().default(sql`gen_random_uuid()`),
  kind: varchar({ length: 20 }).notNull(),
  title: text().notNull(),
  content: text().notNull(),
  source: text().notNull(),
  epicId: uuid("epic_id"),
  tags: text().array().notNull().default(sql`'{}'`),
  eventTime: timestamptz("event_time").notNull(),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
  freshness: varchar({ length: 10 }).notNull().default("fresh"),
  sourceTaskId: uuid("source_task_id").references(() => workItems.id),
  // Migration 051: every entry belongs to one project, and every read filters by it.
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id),
});

// ---------------------------------------------------------------------------
// failed_approaches
// ---------------------------------------------------------------------------

export const failedApproaches = pgTable("failed_approaches", {
  id: uuid().primaryKey().default(sql`gen_random_uuid()`),
  // Nullable + ON DELETE SET NULL (migration 021): a lesson outlives
  // the task that produced it, mirroring knowledge_entries.source_task_id.
  taskId: uuid("task_id").references(() => workItems.id, {
    onDelete: "set null",
  }),
  epicId: uuid("epic_id").references(() => workItems.id),
  // Migration 051: every lesson belongs to one project, and every read filters by it.
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id),
  title: text().notNull(),
  failureReason: text("failure_reason").notNull(),
  learned: text().notNull().default(""),
  recordedAt: timestamptz("recorded_at").notNull().defaultNow(),
});
