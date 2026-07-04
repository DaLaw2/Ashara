import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import * as schema from "./schema.js";

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

export function createDbFromPool(pool: pg.Pool) {
  return drizzle(pool, { schema });
}
