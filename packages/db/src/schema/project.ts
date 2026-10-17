import { pgTable, uuid, varchar, text, jsonb, integer } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { timestamptz } from "./columns.js";
import { clients } from "./identity.js";

// The project record every context keys its rows by.

/** Every state of Engagement's lifecycle a project can hold (the projects_lifecycle_known CHECK). */
export const PROJECT_LIFECYCLES = ["active", "stopped", "accepted"] as const;

// ---------------------------------------------------------------------------
// projects (the Project Record, owned by one client)
// ---------------------------------------------------------------------------

export const projects = pgTable("projects", {
  id: uuid().primaryKey().default(sql`gen_random_uuid()`),
  name: text().notNull(),
  // Engagement's lifecycle (active, stopped, accepted), written only by its lifecycle
  // guard. Delivery's halt is not here: a project is halted while it has an open project_blocks row.
  lifecycle: varchar({ length: 20 }).notNull().default("active"),
  clientId: uuid("client_id")
    .notNull()
    .references(() => clients.id),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
  // Delivery's first plan of the project. Failed attempts with the
  // last one's error; the plan transaction stamps first_planned_at, giving up
  // stamps plan_stopped_at together with opening the halt's episode.
  planAttempts: integer("plan_attempts").notNull().default(0),
  planLastError: text("plan_last_error"),
  firstPlannedAt: timestamptz("first_planned_at"),
  planStoppedAt: timestamptz("plan_stopped_at"),
  // The ordering hints the first plan's decomposition dropped,
  // stamped with first_planned_at; NULL on a project planned before the column existed.
  planDroppedDependencies: jsonb("plan_dropped_dependencies"),
  // The target workspace Delivery works in. Minted once on first
  // dispatch, then never rewritten.
  workspacePath: text("workspace_path"),
  // Why one bad record blocked the project, so the loop skips it
  // instead of failing every project's cycle. Recorded together, while the project is halted
  // (kept after the client's stop).
  blockedErrorClass: text("blocked_error_class"),
  blockedReason: text("blocked_reason"),
  // Failed attempts to revise the plan for the current request, with the
  // last error; reset by a written revision and by the operator's unblock.
  replanAttempts: integer("replan_attempts").notNull().default(0),
  replanLastError: text("replan_last_error"),
  // Whose failure the last counted attempt was, 'model' or 'provider'; reset with it.
  replanLastFailure: text("replan_last_failure"),
  // The cause's category, which the Liaison's plain report is chosen by.
  blockedCategory: text("blocked_category"),
  // Acceptance sweeps that could not run, counted against the fault budget
  // (orchestrator acceptance.ts); never reset.
  acceptanceFaults: integer("acceptance_faults").notNull().default(0),
});
