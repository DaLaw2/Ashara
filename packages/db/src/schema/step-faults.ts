import { integer, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { timestamptz } from "./columns.js";
import { projects } from "./project.js";

// ---------------------------------------------------------------------------
// step_faults (migration 063): a subject of a cycle step (a tender, an answer, a project, a report)
// whose run failed on Ashara's side, with how many times in a row, the last error, and when it is
// tried again. A subject that runs through has its row deleted.
// ---------------------------------------------------------------------------

export const stepFaults = pgTable(
  "step_faults",
  {
    step: text().notNull(),
    subjectId: text("subject_id").notNull(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    faults: integer().notNull(),
    lastError: text("last_error").notNull(),
    retryAt: timestamptz("retry_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.step, table.subjectId] })],
);
