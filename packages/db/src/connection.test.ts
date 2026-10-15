import { describe, test, expect } from "vitest";
import { sql } from "drizzle-orm";
import pg from "pg";
import { z } from "zod";
import { describeErrorChain, serializeError } from "@ashara/shared";
import { createDb, DEFAULT_DATABASE_URL } from "./connection.js";
import type { PoolFactory } from "./connection.js";

const DATABASE_URL = process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL;

const PidRowSchema = z.object({ pid: z.number().int() });

describe("createDb pool", () => {
  // Without a pool 'error' listener this termination throws from pg-pool's idle listener as an
  // uncaught exception, which vitest reports as a failed run and the server treats as fatal.
  test("an idle pooled connection killed by the server does not throw, and the next query succeeds", async () => {
    const db = createDb(DATABASE_URL);
    const admin = new pg.Client({ connectionString: DATABASE_URL });
    await admin.connect();
    try {
      const first = await db.execute(sql`SELECT pg_backend_pid() AS pid`);
      const pid = PidRowSchema.parse(first.rows[0]).pid;

      await admin.query("SELECT pg_terminate_backend($1)", [pid]);
      await new Promise((r) => setTimeout(r, 200));

      const second = await db.execute(sql`SELECT pg_backend_pid() AS pid`);
      expect(PidRowSchema.parse(second.rows[0]).pid).not.toBe(pid);
    } finally {
      await admin.end();
      await db.$client.end();
    }
  });
});

describe("createDb's pool factory", () => {
  test("every query runs on the pool the factory made for the database URL", async () => {
    const configs: pg.PoolConfig[] = [];
    const db = createDb(DATABASE_URL, (config) => {
      configs.push(config);
      return new pg.Pool({ ...config, application_name: "pool-factory-probe" });
    });
    try {
      const result = await db.execute(sql`SELECT current_setting('application_name') AS name`);
      expect(z.object({ name: z.string() }).parse(result.rows[0]).name).toBe("pool-factory-probe");
      expect(configs).toEqual([{ connectionString: DATABASE_URL }]);
    } finally {
      await db.$client.end();
    }
  });
});

describe("a refused connect through the one serializer", () => {
  // localhost resolves to ::1 and 127.0.0.1, so node's connect rejects with an AggregateError whose
  // own message is empty and whose per-address errors sit in its non-enumerable `errors`.
  test("keeps every per-address refusal of the AggregateError", async () => {
    const client = new pg.Client({ host: "localhost", port: 1, user: "nobody", database: "nothing" });
    const thrown: unknown = await client.connect().then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(thrown).toBeInstanceOf(AggregateError);
    const serialized = serializeError(thrown);
    expect(serialized.fields).toMatchObject({ code: "ECONNREFUSED" });
    expect(serialized.errors?.map((e) => e.message).sort()).toEqual(["connect ECONNREFUSED 127.0.0.1:1", "connect ECONNREFUSED ::1:1"]);
    expect(describeErrorChain(thrown)).toMatch(/^AggregateError:  \[2 errors: Error: connect ECONNREFUSED .*; Error: connect ECONNREFUSED .*\]$/);
  });
});

const sentQuery = z.union([z.string(), z.object({ text: z.string() }).loose()]);

/**
 * A pool whose connections reject every BEGIN. `checkedOut` holds the clients not yet released;
 * `releaseLeaked` destroys them, so a leak fails the test instead of hanging the pool's end.
 */
function beginRejectingPool(): { factory: PoolFactory; checkedOut: Set<pg.PoolClient>; releaseLeaked: () => void } {
  const checkedOut = new Set<pg.PoolClient>();
  const factory: PoolFactory = (config) => {
    const pool = new pg.Pool(config);
    return new Proxy(pool, {
      get(target, property, receiver) {
        if (property !== "connect") {
          const value: unknown = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async () => {
          const client = await target.connect();
          checkedOut.add(client);
          return new Proxy(client, {
            get(inner, innerProperty, innerReceiver) {
              if (innerProperty === "release") {
                return (...args: unknown[]) => {
                  checkedOut.delete(inner);
                  return Reflect.apply(inner.release, inner, args);
                };
              }
              if (innerProperty === "query") {
                return (...args: unknown[]) => {
                  const parsed = sentQuery.safeParse(args[0]);
                  const text = !parsed.success ? "" : typeof parsed.data === "string" ? parsed.data : parsed.data.text;
                  if (/^begin/i.test(text.trim())) return Promise.reject(new Error("begin rejected (probe)"));
                  return Reflect.apply(inner.query, inner, args);
                };
              }
              const value: unknown = Reflect.get(inner, innerProperty, innerReceiver);
              return typeof value === "function" ? value.bind(inner) : value;
            },
          });
        };
      },
    });
  };
  const releaseLeaked = (): void => {
    for (const client of checkedOut) client.release(true);
    checkedOut.clear();
  };
  return { factory, checkedOut, releaseLeaked };
}

describe("Database.transaction", () => {
  test("a BEGIN that throws leaves zero checked-out clients and throws a typed error carrying its cause", async () => {
    const probe = beginRejectingPool();
    const db = createDb(DATABASE_URL, probe.factory);
    try {
      const thrown: unknown[] = [];
      for (let attempt = 0; attempt < 3; attempt += 1) {
        thrown.push(await db.transaction(async () => "unreached").then(() => undefined, (err: unknown) => err));
      }
      expect(probe.checkedOut.size).toBe(0);
      expect(db.$client.totalCount - db.$client.idleCount).toBe(0);
      for (const err of thrown) {
        expect(err).toMatchObject({ name: "TransactionBeginFailed" });
        expect(describeErrorChain(err)).toContain("begin rejected (probe)");
      }
    } finally {
      probe.releaseLeaked();
      await db.$client.end();
    }
  });

  test("a body that throws rolls back, rethrows its own error and returns the connection to the pool", async () => {
    const db = createDb(DATABASE_URL);
    const bodyError = new Error("body failed (probe)");
    try {
      const thrown: unknown = await db
        .transaction(async (tx) => {
          await tx.execute(sql`SELECT 1`);
          throw bodyError;
        })
        .then(
          () => undefined,
          (err: unknown) => err,
        );
      expect(thrown).toBe(bodyError);
      expect(db.$client.totalCount - db.$client.idleCount).toBe(0);
      expect(db.$client.idleCount).toBe(1);
      const committed = await db.transaction(async (tx) => tx.execute(sql`SELECT 2 AS two`));
      expect(z.object({ two: z.number() }).parse(committed.rows[0]).two).toBe(2);
    } finally {
      await db.$client.end();
    }
  });
});
