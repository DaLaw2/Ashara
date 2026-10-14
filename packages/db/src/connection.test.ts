import { describe, test, expect } from "vitest";
import { sql } from "drizzle-orm";
import pg from "pg";
import { z } from "zod";
import { describeErrorChain, serializeError } from "@ashara/shared";
import { createDb, DEFAULT_DATABASE_URL } from "./connection.js";

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
