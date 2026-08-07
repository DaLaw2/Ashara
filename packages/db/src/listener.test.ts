import { describe, test, expect, afterEach } from "vitest";
import pg from "pg";
import { DEFAULT_DATABASE_URL } from "./connection.js";
import { listenForEvents } from "./listener.js";
import type { PgListener } from "./listener.js";

// ---------------------------------------------------------------------------
// Integration test: verifies that listenForEvents opens a real PG connection
// and that stop() tears it down completely (no leaked connections in
// pg_stat_activity). Skips cleanly when Postgres is unreachable.
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL;

async function canConnect(): Promise<boolean> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

// Query pg_stat_activity for connections whose most recent query contains
// "LISTEN ashara_events". The listener's dedicated connection is the only
// one in this process that issues that statement, so it is a reliable marker.
async function countListenerConnections(): Promise<number> {
  const probe = new pg.Client({ connectionString: DATABASE_URL });
  try {
    await probe.connect();
    const result = await probe.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE query LIKE '%LISTEN ashara_events%'
         AND pid != pg_backend_pid()`,
    );
    return (result.rows[0] as { n: number }).n;
  } finally {
    await probe.end();
  }
}

describe("PG listener cleanup", () => {
  let listener: PgListener | null = null;

  afterEach(() => {
    // Safety net: stop the listener even if the test throws before its own
    // stop() call so we do not leak connections across tests.
    listener?.stop();
    listener = null;
  });

  test("stop() removes the LISTEN connection from pg_stat_activity", async () => {
    const reachable = await canConnect();
    if (!reachable) {
      console.log("Postgres unreachable — skipping listener cleanup test");
      return;
    }

    // Capture baseline — there may be other listeners from prior runs.
    const before = await countListenerConnections();

    listener = await listenForEvents(DATABASE_URL, () => {});

    // The listener should have added exactly one connection.
    const during = await countListenerConnections();
    expect(during).toBe(before + 1);

    // Stop and wait briefly for the connection to close.
    listener.stop();
    listener = null;

    // pg.Client.end() is async; give PG a moment to remove the backend.
    await new Promise((r) => setTimeout(r, 200));

    const after = await countListenerConnections();
    expect(after).toBe(before);
  });
});
