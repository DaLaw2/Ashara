import { pgTable, uuid, text } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { timestamptz } from "./columns.js";
import { projects } from "./project.js";

// Execution Infrastructure: environment builds.

// ---------------------------------------------------------------------------
// environment_builds (migration 032, Execution Infrastructure): one row per
// podman build of a project's environment version. Outcome columns are CHECKed
// in the migration; one succeeded row per (project, version) by a partial
// unique index.
// ---------------------------------------------------------------------------

export const environmentBuilds = pgTable("environment_builds", {
  id: uuid().primaryKey().default(sql`gen_random_uuid()`),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id),
  version: text().notNull(),
  commit: text().notNull(),
  imageRef: text("image_ref").notNull(),
  imageId: text("image_id"),
  status: text().notNull(),
  network: text().notNull(),
  logDigest: text("log_digest").notNull(),
  error: text(),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});
