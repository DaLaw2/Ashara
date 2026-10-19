import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DEFAULT_DATABASE_URL } from "@ashara/db";
import { RunAborted } from "./run.js";
import { directed, implementation, keys, statements, useSimulatorDatabase } from "./simulator-harness.js";

/*
 * A run is stopped by its signal at its next step, so a test that times out leaves no run behind to
 * restore process-wide state over, or write into, the next test's run.
 */
useSimulatorDatabase();

/** How soon an aborted run must have settled: its step in flight, then its cleanup. */
const SETTLE_BOUND_MS = 5_000;
const POLL_MS = 100;

/** The run the test aborted ended on its own terms instead: the abort never reached a step. */
class RunNotAborted extends Error {
  constructor(readonly violations: string) {
    super(`the run returned a result though it was aborted mid-run; its violations: ${violations === "" ? "none" : violations}`);
    this.name = "RunNotAborted";
  }
}

/** No composed instance of this process held a database session by the deadline: the run never got past its setup. */
class InstanceNeverComposed extends Error {
  constructor(readonly waitedMs: number) {
    super(`no composed instance of process ${process.pid} held a database session within ${waitedMs} ms of the run's start`);
    this.name = "InstanceNeverComposed";
  }
}

/** Resolves once a composed instance of this process holds a database session: the run is past its setup. */
async function instanceComposed(waitMs: number): Promise<void> {
  const deadline = Date.now() + waitMs;
  const client = new pg.Client({ connectionString: process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL });
  await client.connect();
  try {
    const counted = z.tuple([z.object({ n: z.number().int() })]);
    while (Date.now() < deadline) {
      const result = await client.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name LIKE $1", [`ashara-sim-${process.pid}-%`]);
      if (counted.parse(result.rows)[0].n > 0) return;
      await sleep(POLL_MS);
    }
    throw new InstanceNeverComposed(waitMs);
  } finally {
    await client.end();
  }
}

describe("lifecycle simulator, aborted run", () => {
  it("fails, naming its wait, when no run composes an instance by the deadline", async () => {
    await expect(instanceComposed(300)).rejects.toBeInstanceOf(InstanceNeverComposed);
  });

  it("stops an aborted run within its bound, and the next run's log holds nothing of it", async (ctx) => {
    const console0 = { log: console.log, info: console.info, warn: console.warn, error: console.error };
    const controller = new AbortController();
    // A long tape: acceptance refuses main until a repair, so the abort lands while it still cycles.
    const aborted = directed(ctx, [implementation("agent.interface-left-stale", "every")], { signal: controller.signal });
    const settled = Promise.allSettled([aborted]);
    await instanceComposed(60_000);
    const abortedAt = Date.now();
    controller.abort();
    const [outcome] = await settled;
    const tookMs = Date.now() - abortedAt;
    if (outcome.status === "fulfilled") throw new RunNotAborted(statements(outcome.value));
    expect(outcome.reason).toBeInstanceOf(RunAborted);
    expect(tookMs).toBeLessThan(SETTLE_BOUND_MS);
    const abortLog = outcome.reason instanceof RunAborted ? outcome.reason.log : [];
    expect(abortLog.some((line) => line.startsWith("harness error: RunAborted"))).toBe(true);

    const next = await directed(ctx, []);
    expect(keys(next), statements(next)).toEqual([]);
    expect(next.log.some((line) => line.includes("RunAborted"))).toBe(false);
    expect({ log: console.log, info: console.info, warn: console.warn, error: console.error }).toEqual(console0);
  }, 120_000);
});
