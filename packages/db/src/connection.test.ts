import { describe, test, expect } from "vitest";
import { sql } from "drizzle-orm";
import pg from "pg";
import { z } from "zod";
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
