import { pgTable, text, customType } from "drizzle-orm/pg-core";
import { timestamptz } from "./columns.js";

// Security: the secret store's ciphertext rows.

// ---------------------------------------------------------------------------
// secrets — owned by the Security context
// ---------------------------------------------------------------------------
// Ciphertext only: the AES-256-GCM key never enters the database.

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const secrets = pgTable("secrets", {
  name: text().primaryKey(),
  keyId: text("key_id").notNull(),
  iv: bytea().notNull(),
  ciphertext: bytea().notNull(),
  authTag: bytea("auth_tag").notNull(),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
});
