import { pgTable, uuid, varchar, text, jsonb, integer, unique, index, type AnyPgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { timestamptz } from "./columns.js";
import { projects } from "./project.js";

// Engagement: the vision versions and the client channel.

// ---------------------------------------------------------------------------
// vision_documents
// ---------------------------------------------------------------------------

// `version` counts per project; UNIQUE (project_id, version) fails a racing
// writer closed instead of letting two rows share a version (migration 014).
export const visionDocuments = pgTable(
  "vision_documents",
  {
    id: uuid().primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    version: integer().notNull(),
    visionText: text("vision_text").notNull(),
    summary: text().notNull(),
    inferences: jsonb().notNull().default({}),
    scopeBoundaries: jsonb("scope_boundaries").notNull().default(sql`'[]'`),
    confirmedDirections: jsonb("confirmed_directions").notNull().default(sql`'[]'`),
    openQuestions: jsonb("open_questions").notNull().default(sql`'[]'`),
    changeReason: text("change_reason"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => ({
    projectVersionUnique: unique("vision_documents_project_version_unique").on(t.projectId, t.version),
  }),
);

// ---------------------------------------------------------------------------
// client_messages (migration 016, K1 client channel, Engagement context)
// ---------------------------------------------------------------------------
// Direction/kind pairing, non-empty body and "an answer names its question" are
// CHECKs in the migration; inbound inserts NOTIFY 'ashara_events'.

export const clientMessages = pgTable(
  "client_messages",
  {
    id: uuid().primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    direction: varchar({ length: 10 }).notNull(),
    kind: varchar({ length: 10 }).notNull(),
    body: text().notNull(),
    inReplyTo: uuid("in_reply_to").references((): AnyPgColumn => clientMessages.id),
    consumedAt: timestamptz("consumed_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    // Migration 019: failed intake attempts of a tender, with the last one's error.
    intakeAttempts: integer("intake_attempts").notNull().default(0),
    intakeLastError: text("intake_last_error"),
    // Migration 066: whose failure an answer's last counted reading attempt was, 'model' or 'provider'.
    intakeLastFailure: text("intake_last_failure"),
    // Migration 020: the planning outcome an outbound report tells the client about.
    reportsOn: varchar("reports_on", { length: 20 }),
    // Migration 022: an outbound question's 1-based rank among those posted with it.
    position: integer(),
  },
  (t) => ({
    projectCreatedIdx: index("idx_client_messages_project_created").on(t.projectId, t.createdAt),
  }),
);
