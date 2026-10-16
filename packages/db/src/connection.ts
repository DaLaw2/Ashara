import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
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
  const db = drizzle(pool, { schema });
  // Every top-level transaction of this Database runs through the one wrapper below. It exists
  // because drizzle-orm 0.45.2 (the pinned version; node-postgres/session.js NodePgSession.transaction)
  // sends BEGIN on a client checked out of the pool before the try/finally that releases it, so a
  // failed BEGIN would keep that connection checked out for good. Re-read that method before
  // changing the pinned version. Nested `tx.transaction` calls are savepoints on the already
  // checked-out client and need no wrapper.
  db.transaction = transactionOnOwnCheckout(pool);
  return db;
}

type SchemaDatabase = NodePgDatabase<typeof schema>;

/** BEGIN failed, so no transaction was opened; the connection it was sent on was destroyed, not pooled. */
class TransactionBeginFailed extends Error {
  constructor(cause: unknown) {
    super(`BEGIN failed, no transaction was opened: ${describeErrorChain(cause)}`, { cause });
    this.name = "TransactionBeginFailed";
  }
}

/** The body failed and the ROLLBACK after it failed too: `cause` is the body's error. */
class TransactionRollbackFailed extends Error {
  constructor(
    cause: unknown,
    readonly rollbackError: unknown,
  ) {
    super(`ROLLBACK failed after the transaction body failed: body ${describeErrorChain(cause)}; rollback ${describeErrorChain(rollbackError)}`, {
      cause,
    });
    this.name = "TransactionRollbackFailed";
  }
}

/** How far one transaction got; a record, so the body's closure writes are visible after the await. */
interface TransactionProgress {
  entered: boolean;
  bodyFailure: { readonly error: unknown } | null;
}

/**
 * A transaction on a client this wrapper checks out itself and releases on every path. drizzle runs
 * BEGIN, the body, and COMMIT or ROLLBACK on that one client (a client, not a pool, so drizzle
 * releases nothing). A connection whose BEGIN, COMMIT or ROLLBACK failed is in an unknown state and
 * is destroyed instead of returned to the pool; one whose body failed and rolled back is reused.
 */
function transactionOnOwnCheckout(pool: pg.Pool): SchemaDatabase["transaction"] {
  return async (body, config) => {
    const client = await pool.connect();
    const progress: TransactionProgress = { entered: false, bodyFailure: null };
    let destroy = true;
    try {
      const result = await drizzle(client, { schema }).transaction(async (tx) => {
        progress.entered = true;
        try {
          return await body(tx);
        } catch (err: unknown) {
          progress.bodyFailure = { error: err };
          throw err;
        }
      }, config);
      destroy = false;
      return result;
    } catch (err: unknown) {
      if (!progress.entered) throw new TransactionBeginFailed(err);
      if (progress.bodyFailure === null) throw err;
      if (progress.bodyFailure.error !== err) throw new TransactionRollbackFailed(progress.bodyFailure.error, err);
      destroy = false;
      throw err;
    } finally {
      client.release(destroy);
    }
  };
}
