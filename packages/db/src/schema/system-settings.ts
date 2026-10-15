import { pgTable, text } from "drizzle-orm/pg-core";
import { timestamptz } from "./columns.js";

// Key-value system settings.

// ---------------------------------------------------------------------------
// system_settings
// ---------------------------------------------------------------------------

export const systemSettings = pgTable("system_settings", {
  key: text().primaryKey(),
  value: text().notNull(),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
});
