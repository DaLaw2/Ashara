import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

/**
 * The default DATABASE_URL when the environment does not provide one.
 * This is a POLICY default (CLAUDE.md Discipline A): the caller deliberately
 * delegates "where to connect?" to the local-dev answer. It is not an
 * evidence default — it does not answer an epistemic question the caller
 * does not know is being asked. A deployment that needs a different DSN
 * overrides via the DATABASE_URL env var.
 */
export const DEFAULT_DATABASE_URL = "postgresql://ashara@localhost:5432/ashara";

export type Database = ReturnType<typeof createDb>;

/**
 * Transaction-scoped handle passed to the callback of `Database.transaction`.
 * Structurally shares the query builder surface (select/insert/update/...) with
 * `Database`, so a repository can be constructed against either. Extracted from
 * the driver's own types so it stays in lockstep with the Drizzle version.
 */
export type DbTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Either a pooled connection or an open transaction. Repositories accept both. */
export type DbHandle = Database | DbTransaction;

export function createDb(databaseUrl: string) {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  return drizzle(pool, { schema });
}
