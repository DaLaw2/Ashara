import { describe, test, expect, afterEach } from "vitest";
import pg from "pg";
import { z } from "zod";
import { resolveTestDatabaseUrl } from "./test-database-url.js";
import { listenForEvents } from "./listener.js";
import type { PgListener } from "./listener.js";

// Integration test against the shared dev database. Other test files open their own
// LISTEN connections in parallel, so the assertions follow this listener's backend
// pid, never a count of all listeners.

const DATABASE_URL = resolveTestDatabaseUrl(process.env);

const CountRowSchema = z.object({ n: z.number().int() });

async function backendExists(pid: number): Promise<boolean> {
  const probe = new pg.Client({ connectionString: DATABASE_URL });
  await probe.connect();
  try {
    const result = await probe.query(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = $1",
      [pid],
    );
    return CountRowSchema.parse(result.rows[0]).n === 1;
  } finally {
    await probe.end();
  }
}

describe("PG listener cleanup", () => {
  let listener: PgListener | null = null;

  afterEach(async () => {
    await listener?.stop();
    listener = null;
  });

  test("stop() removes the listener's backend from pg_stat_activity", async () => {
    listener = await listenForEvents(DATABASE_URL, () => {});
    const pid = listener.backendPid();
    if (pid === null) throw new Error(`listenForEvents did not connect to ${DATABASE_URL}`);

    expect(await backendExists(pid)).toBe(true);

    await listener.stop();
    expect(listener.backendPid()).toBeNull();
    listener = null;

    // end() resolves on socket close; give the backend a moment to exit.
    await new Promise((r) => setTimeout(r, 200));

    expect(await backendExists(pid)).toBe(false);
  });
});
