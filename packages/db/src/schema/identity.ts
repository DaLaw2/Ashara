import { pgTable, uuid, text, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { timestamptz } from "./columns.js";

// Generic identity: clients, their web-client sessions and the login throttle.

// ---------------------------------------------------------------------------
// clients: who a project belongs to and a session acts for
// ---------------------------------------------------------------------------

export const clients = pgTable("clients", {
  id: uuid().primaryKey().default(sql`gen_random_uuid()`),
  name: text().notNull().unique(),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// client_sessions (the web client's sessions)
// ---------------------------------------------------------------------------

export const clientSessions = pgTable("client_sessions", {
  id: uuid().primaryKey().default(sql`gen_random_uuid()`),
  // SHA-256 of the cookie's token, hex; the token itself is never stored.
  tokenHash: text("token_hash").notNull().unique(),
  // The one client this session acts for.
  clientId: uuid("client_id")
    .notNull()
    .references(() => clients.id),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
  expiresAt: timestamptz("expires_at").notNull(),
  revokedAt: timestamptz("revoked_at"),
});

// ---------------------------------------------------------------------------
// client_login_failures: the login throttle's evidence
// ---------------------------------------------------------------------------

export const clientLoginFailures = pgTable(
  "client_login_failures",
  {
    clientName: text("client_name").notNull(),
    // The attempt's source: an IPv4 address or an IPv6 /64 (server/src/source-network.ts sourceNetwork).
    sourceAddress: text("source_address").notNull(),
    failedAt: timestamptz("failed_at").notNull().defaultNow(),
  },
  (t) => ({
    nameTimeIdx: index("idx_client_login_failures_name_time").on(t.clientName, t.failedAt),
    nameSourceTimeIdx: index("idx_client_login_failures_name_source_time").on(
      t.clientName,
      t.sourceAddress,
      t.failedAt,
    ),
    sourceTimeIdx: index("idx_client_login_failures_source_time").on(t.sourceAddress, t.failedAt),
    timeIdx: index("idx_client_login_failures_time").on(t.failedAt),
  }),
);
