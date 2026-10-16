import { pgTable, uuid, varchar, text, jsonb, integer } from "drizzle-orm/pg-core";
import { timestamptz } from "./columns.js";
import { workItems } from "./delivery.js";

// Workplace: the attempt log.

// ---------------------------------------------------------------------------
// dev_sessions
// ---------------------------------------------------------------------------

export const devSessions = pgTable("dev_sessions", {
  id: uuid().primaryKey(),
  taskId: uuid("task_id")
    .notNull()
    .references(() => workItems.id),
  phase: varchar({ length: 20 }).notNull().default("Preparing"),
  brief: jsonb(),
  verificationResult: jsonb("verification_result"),
  // Migration 034: the environment version the session's cells were built from; NULL when they
  // ran on the BaseCell (only the Sprint 0 task does).
  environmentVersion: text("environment_version"),
  // Migration 046: the session's attempt, all six set or all NULL. NULL is "no attempt recorded"
  // (still open, ended before the model, attempt threw, reconciled orphan, or a pre-046 row), never
  // "no model call was made".
  attemptPromptDigest: text("attempt_prompt_digest"),
  attemptTerminal: text("attempt_terminal"),
  attemptTurns: integer("attempt_turns"),
  attemptProvider: text("attempt_provider"),
  attemptModel: text("attempt_model"),
  attemptCell: text("attempt_cell"),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
});
