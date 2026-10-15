import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { describeErrorChain } from "@ashara/shared";
import * as schema from "./schema/index.js";

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

/** Makes the pool every query of one Database runs on; the composition root chooses it. */
export type PoolFactory = (config: pg.PoolConfig) => pg.Pool;

/** The policy default: a plain node-postgres pool. */
export const createPgPool: PoolFactory = (config) => new pg.Pool(config);

export function createDb(databaseUrl: string, createPool: PoolFactory = createPgPool) {
  const pool = createPool({ connectionString: databaseUrl });
  // pg-pool emits 'error' when an IDLE pooled client loses its connection (database restart,
  // pg_terminate_backend, network drop) and has already evicted that client. Without a listener the
  // emit throws and reaches the server's fatal uncaughtException path, so an unreachable database
  // would kill the process. An outage is not process corruption: the next query rejects and the
  // caller's own retry or block path handles it (Discipline A).
  pool.on("error", (err: Error) => {
    const code = "code" in err ? String(err.code) : "none";
    console.warn(
      `[db] WARN: an idle pooled connection failed and was removed from the pool (code ${code}): ${describeErrorChain(err)}`,
    );
  });
  return drizzle(pool, { schema });
}
