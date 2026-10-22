import { pgTable, uuid, varchar, text } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { timestamptz } from "./columns.js";
import { clients } from "./identity.js";

// The project record every context keys its rows by: the tender's identity, its workspace and
// Engagement's lifecycle. Each context keeps its own per-project state in a table of its own.

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
  // The target workspace Delivery works in. Minted once on first
  // dispatch, then never rewritten.
  workspacePath: text("workspace_path"),
});
