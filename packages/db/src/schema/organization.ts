import { pgTable, uuid, text, integer, unique } from "drizzle-orm/pg-core";
import { timestamptz } from "./columns.js";
import { projects } from "./project.js";

// Organization: the project roster.

// ---------------------------------------------------------------------------
// roster_roles: a project's roster, one row per role, append-only
// ---------------------------------------------------------------------------

export const rosterRoles = pgTable(
  "roster_roles",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    revision: integer().notNull(),
    roleId: uuid("role_id").notNull(),
    name: text().notNull(),
    responsibility: text().notNull(),
    capabilities: text().array().notNull(),
    visionVersion: integer("vision_version").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => ({
    uniqueRole: unique("roster_roles_unique_role").on(t.projectId, t.revision, t.roleId),
  }),
);
