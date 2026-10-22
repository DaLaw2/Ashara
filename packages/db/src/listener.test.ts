import { describe, test, expect, afterEach } from "vitest";
import pg from "pg";
import { z } from "zod";
import { recordingLogger } from "@ashara/shared/testing";
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

describe("PG listener trace", () => {
  test("its records join a trace of their own, a child of the trace it was entered from, never the logger's root", async () => {
    const logger = recordingLogger();
    const unreachable = await listenForEvents("postgresql://ashara@127.0.0.1:1/none", () => {}, logger);
    await unreachable.stop();

    const failed = logger.records.filter((r) => r.event === "db.listener-connect-failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.traceId).not.toBe(logger.trace());
    expect(failed[0]?.parentTraceId).toBe(logger.trace());
  });
});

describe("PG listener cleanup", () => {
  let listener: PgListener | null = null;

  afterEach(async () => {
    await listener?.stop();
    listener = null;
  });

  test("stop() removes the listener's backend from pg_stat_activity", async () => {
    listener = await listenForEvents(DATABASE_URL, () => {}, recordingLogger());
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
