import { randomUUID } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import { sql } from "drizzle-orm";
import pg from "pg";
import { z } from "zod";
import { createDb } from "./connection.js";
import { resolveTestDatabaseUrl } from "./test-database-url.js";
import { isDatabaseConnectionFault } from "./connection-fault.js";

const DATABASE_URL = resolveTestDatabaseUrl(process.env);

/** What a query through `db` rejects with. */
async function rejectionOf(query: Promise<unknown>): Promise<unknown> {
  try {
    await query;
  } catch (err) {
    return err;
  }
  throw new Error("the query was expected to fail and completed");
}

// Each kind of connection fault is provoked on a real connection through the driver Ashara runs on,
// so a driver upgrade that renames one fails here rather than turning an outage into a counted defect.
describe("isDatabaseConnectionFault", () => {
  test("a server that refuses the connection", async () => {
    const url = new URL(DATABASE_URL);
    url.port = "1";
    const db = createDb(url.toString());
    try {
      expect(isDatabaseConnectionFault(await rejectionOf(db.execute(sql`SELECT 1`)))).toBe(true);
    } finally {
      await db.$client.end();
    }
  });

  test("a session the server terminates in the middle of a query", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const name = `conn-fault-${randomUUID().slice(0, 8)}`;
    const url = new URL(DATABASE_URL);
    url.searchParams.set("application_name", name);
    const db = createDb(url.toString());
    const admin = new pg.Client({ connectionString: DATABASE_URL });
    await admin.connect();
    try {
      const sleeping = rejectionOf(db.execute(sql`SELECT pg_sleep(30)`));
      for (let tries = 0; ; tries++) {
        const killed = await admin.query("SELECT pg_terminate_backend(pid) AS killed FROM pg_stat_activity WHERE application_name = $1", [name]);
        if (z.array(z.object({ killed: z.boolean() })).parse(killed.rows).some((row) => row.killed)) break;
        if (tries > 50) throw new Error(`no session named ${name} appeared`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(isDatabaseConnectionFault(await sleeping)).toBe(true);
    } finally {
      await admin.end();
      await db.$client.end();
    }
  });

  test("a query the server answers with an error, and an error nothing names, are not the connection's", async () => {
    const db = createDb(DATABASE_URL);
    try {
      expect(isDatabaseConnectionFault(await rejectionOf(db.execute(sql`SELECT * FROM no_such_table_here`)))).toBe(false);
    } finally {
      await db.$client.end();
    }
    expect(isDatabaseConnectionFault(new TypeError("cannot read properties of undefined"))).toBe(false);
    expect(isDatabaseConnectionFault(z.string().safeParse(1).error)).toBe(false);
  });
});
