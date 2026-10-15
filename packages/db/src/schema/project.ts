import { pgTable, uuid, varchar, text, jsonb, integer } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { timestamptz } from "./columns.js";
import { clients } from "./identity.js";

// The project record every context keys its rows by.

// ---------------------------------------------------------------------------
// projects (migration 014, K3 Project Record; client_id since migration 018)
// ---------------------------------------------------------------------------

export const projects = pgTable("projects", {
  id: uuid().primaryKey().default(sql`gen_random_uuid()`),
  name: text().notNull(),
  status: varchar({ length: 20 }).notNull().default("active"),
  clientId: uuid("client_id")
    .notNull()
    .references(() => clients.id),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
  // Migration 020: Delivery's first plan of the project. Failed attempts with the
  // last one's error; the plan transaction stamps first_planned_at, giving up
  // stamps plan_stopped_at together with status 'blocked'.
  planAttempts: integer("plan_attempts").notNull().default(0),
  planLastError: text("plan_last_error"),
  firstPlannedAt: timestamptz("first_planned_at"),
  planStoppedAt: timestamptz("plan_stopped_at"),
  // Migration 033: the ordering hints the first plan's decomposition dropped,
  // stamped with first_planned_at; NULL on a project planned before it.
  planDroppedDependencies: jsonb("plan_dropped_dependencies"),
  // Migration 024: the target workspace Delivery works in. Minted once on first
  // dispatch, then never rewritten.
  workspacePath: text("workspace_path"),
  // Migration 025: why one bad record blocked the project, so the loop skips it
  // instead of failing every project's cycle. Recorded together, on blocked rows only.
  blockedErrorClass: text("blocked_error_class"),
  blockedReason: text("blocked_reason"),
  // Migration 042: failed attempts to revise the plan for the current request, with the
  // last error; reset by a written revision and by the operator's unblock.
  replanAttempts: integer("replan_attempts").notNull().default(0),
  replanLastError: text("replan_last_error"),
  // Migration 040: the cause's category, which the Liaison's plain report is chosen by.
  blockedCategory: text("blocked_category"),
  // Migration 049: acceptance sweeps that could not run, counted against the fault budget
  // (orchestrator acceptance.ts); never reset.
  acceptanceFaults: integer("acceptance_faults").notNull().default(0),
});
