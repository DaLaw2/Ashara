// eslint-disable-next-line no-restricted-syntax -- real wait: a conflict clears only once the other transaction ends, which no simulated clock moves
import { setTimeout as sleep } from "node:timers/promises";
import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { describeErrorChain } from "@ashara/shared";

/**
 * The default DATABASE_URL when the environment does not provide one.
 * This is a POLICY default (CLAUDE.md Discipline A): the caller deliberately
 * delegates "where to connect?" to the local-dev answer. It is not an
 * evidence default — it does not answer an epistemic question the caller
 * does not know is being asked. A deployment that needs a different DSN
 * overrides via the DATABASE_URL env var.
 */
export const DEFAULT_DATABASE_URL = "postgresql://ashara@localhost:5432/ashara";

/**
 * Built without a schema, so `db.query` names no table: every context holds this one handle, and a
 * read of a table it does not own needs that table's object, which only its owner may import.
 */
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
  const db = drizzle(conflictRetryingPool(pool));
  // Every top-level transaction of this Database runs through the one wrapper below. It exists
  // because drizzle-orm's node-postgres session (session.js NodePgSession.transaction) sends BEGIN on
  // a client checked out of the pool before the try/finally that releases it, so a failed BEGIN
  // would keep that connection checked out for good. Re-read that method on every drizzle-orm
  // upgrade. Nested `tx.transaction` calls are savepoints on the already
  // checked-out client and need no wrapper.
  db.transaction = retriedTransaction(transactionOnOwnCheckout(pool));
  return db;
}

type UnschemedDatabase = NodePgDatabase;

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
function transactionOnOwnCheckout(pool: pg.Pool): UnschemedDatabase["transaction"] {
  return async (body, config) => {
    const client = await pool.connect();
    const progress: TransactionProgress = { entered: false, bodyFailure: null };
    let destroy = true;
    try {
      const result = await drizzle(client).transaction(async (tx) => {
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

/**
 * SQLSTATEs of work the server rolled back because a concurrent transaction conflicted with it:
 * 40001 serialization_failure, 40P01 deadlock_detected. The server has already undone the statement
 * or the whole transaction, so running it again is safe, and a later attempt may not meet the
 * conflict. Any other failure is rethrown at once.
 */
const CONFLICT_SQLSTATES: ReadonlySet<string> = new Set(["40001", "40P01"]);

/**
 * Attempts per statement or transaction before a conflict that keeps recurring is rethrown typed.
 * @testseam connection.test.ts counts the attempts of a conflict that never clears against it
 */
export const CONFLICT_ATTEMPTS = 5;
/** The wait before the second attempt; each later wait doubles it. */
const CONFLICT_BACKOFF_MS = 10;
const MAX_CAUSE_DEPTH = 8;

/** A statement or transaction met a concurrent-update conflict on every one of its attempts. */
class DatabaseConflictRetriesExhausted extends Error {
  constructor(
    readonly work: string,
    readonly attempts: number,
    readonly sqlState: string,
    cause: unknown,
  ) {
    super(`${work} met a concurrent-update conflict (SQLSTATE ${sqlState}) on each of its ${attempts} attempts: ${describeErrorChain(cause)}`, {
      cause,
    });
    this.name = "DatabaseConflictRetriesExhausted";
  }
}

/**
 * The conflict SQLSTATE in `error`'s cause chain, or null. Drizzle wraps the driver's error as the
 * cause of its own, and the transaction wrapper's typed errors carry theirs the same way. A conflict
 * that already spent its retries is not retried again by an enclosing transaction.
 */
function conflictStateOf(error: unknown): string | null {
  let layer: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && layer instanceof Error; depth++) {
    if (layer instanceof DatabaseConflictRetriesExhausted) return null;
    if ("code" in layer && typeof layer.code === "string" && CONFLICT_SQLSTATES.has(layer.code)) return layer.code;
    layer = layer.cause;
  }
  return null;
}

async function retriedOnConflict<T>(work: string, run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (err: unknown) {
      const sqlState = conflictStateOf(err);
      if (sqlState === null) throw err;
      if (attempt >= CONFLICT_ATTEMPTS) throw new DatabaseConflictRetriesExhausted(work, attempt, sqlState, err);
      const wait = CONFLICT_BACKOFF_MS * 2 ** (attempt - 1);
      console.warn(
        `[db] WARN: ${work} met a concurrent-update conflict (SQLSTATE ${sqlState}) on attempt ${attempt} of ${CONFLICT_ATTEMPTS}; ` +
          `retrying in ${wait} ms: ${describeErrorChain(err)}`,
      );
      await sleep(wait);
    }
  }
}

/**
 * A statement sent on the pool outside a transaction runs in autocommit, so one that failed on a
 * conflict was rolled back on its own and is sent again. The callback form of `query` passes through
 * untouched: drizzle never uses it.
 */
function conflictRetryingPool(pool: pg.Pool): pg.Pool {
  return new Proxy(pool, {
    get(target, property, receiver) {
      if (property !== "query") {
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (...args: unknown[]): unknown => {
        const send = (): unknown => Reflect.apply(target.query, target, args);
        if (typeof args.at(-1) === "function") return send();
        return retriedOnConflict("a statement", async () => await send());
      };
    },
  });
}

/**
 * A transaction a conflict aborted was rolled back whole, so it runs again from its BEGIN on a fresh
 * checkout, its body included: a body reruns only after its earlier run's writes were undone.
 */
function retriedTransaction(once: UnschemedDatabase["transaction"]): UnschemedDatabase["transaction"] {
  return (body, config) => retriedOnConflict("a transaction", () => once(body, config));
}
