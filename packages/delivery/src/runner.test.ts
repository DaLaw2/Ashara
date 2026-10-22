import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { recordingLogger } from "@ashara/shared/testing";
import type { CycleResult } from "./types.js";
import { ContinuousRunner } from "./runner.js";
import type { CycleRunner } from "./runner.js";

const IDLE_MS = 60_000;

/** A CycleRunner double whose behavior per call is scripted by the test. */
function scriptedCycles(script: Array<(runner: ContinuousRunner) => CycleResult>): {
  loop: CycleRunner;
  bind: (runner: ContinuousRunner) => void;
  calls: () => number;
  haltedCalls: () => number;
} {
  let runner: ContinuousRunner | null = null;
  let count = 0;
  let halted = 0;
  return {
    loop: {
      runCycle: async () => {
        const step = script[Math.min(count, script.length - 1)];
        count += 1;
        if (!runner || !step) throw new Error("scriptedCycles: runner not bound");
        return step(runner);
      },
      runHaltedCycle: async () => {
        halted += 1;
      },
    },
    bind: (r) => { runner = r; },
    calls: () => count,
    haltedCalls: () => halted,
  };
}

const noHalt = async (): Promise<void> => {
  throw new Error("no cycle of this test reports a stop");
};

const idle = (): CycleResult => ({ tasksProcessed: 0, results: [], stop: null });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ContinuousRunner wakePending", () => {
  test("a wake during a cycle skips the idle wait", async () => {
    const cycles = scriptedCycles([
      (runner) => { runner.wake(); return idle(); },
      idle,
    ]);
    const runner = new ContinuousRunner(cycles.loop, recordingLogger(), { databaseUrl: null, idleIntervalMs: IDLE_MS, pollIntervalMs: IDLE_MS });
    cycles.bind(runner);
    const abort = new AbortController();

    const running = runner.run(abort.signal, noHalt);
    await vi.advanceTimersByTimeAsync(0);

    expect(cycles.calls()).toBe(2);

    abort.abort();
    await running;
  });

  // A throwing cycle that published an event must still back off; otherwise a
  // persistent failure re-runs as fast as it can notify itself.
  test("a wake during a throwing cycle does not skip the error backoff", async () => {
    const cycles = scriptedCycles([
      (runner) => { runner.wake(); throw new Error("cycle failed"); },
      idle,
    ]);
    const logger = recordingLogger();
    const runner = new ContinuousRunner(cycles.loop, logger, {
      databaseUrl: null,
      idleIntervalMs: IDLE_MS,
      pollIntervalMs: IDLE_MS,
      maxConsecutiveErrors: 1,
    });
    cycles.bind(runner);
    const abort = new AbortController();

    const running = runner.run(abort.signal, noHalt);
    await vi.advanceTimersByTimeAsync(0);
    expect(cycles.calls()).toBe(1);

    // maxConsecutiveErrors 1 → backoff 2^1 s.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(cycles.calls()).toBe(2);
    expect(logger.records.filter((r) => r.level === "error" || r.level === "warn").map((r) => [r.level, r.event, r.fields?.["consecutiveErrors"]])).toEqual([
      ["error", "delivery.cycle-error", 1],
      ["warn", "delivery.backing-off", 1],
    ]);

    abort.abort();
    await running;
  });
});

describe("ContinuousRunner stop", () => {
  // A client's stop sent after the deployment cap stopped the runner is still taken in and answered.
  test("a cycle that reports a stop halts the work for good; from then on only the client's stops are taken in, until shutdown", async () => {
    const stop = { reason: "budget_cap: deployment cap reached", spend: { capUsd: 5, spentUsd: 5, inFlightUsd: 0, nextCallUsd: null } };
    const cycles = scriptedCycles([() => ({ tasksProcessed: 0, results: [], stop }), idle]);
    const logger = recordingLogger();
    const runner = new ContinuousRunner(cycles.loop, logger, { databaseUrl: null, idleIntervalMs: IDLE_MS, pollIntervalMs: IDLE_MS });
    cycles.bind(runner);
    const halts: string[] = [];
    const abort = new AbortController();

    const running = runner.run(abort.signal, async (halt) => void halts.push(halt.reason));
    await vi.advanceTimersByTimeAsync(0);
    expect(halts).toEqual([stop.reason]);
    expect(cycles.haltedCalls()).toBe(1);

    // A stop the client posts NOTIFYs: it is taken in at once, not after the idle interval.
    runner.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(cycles.haltedCalls()).toBe(2);
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(cycles.haltedCalls()).toBe(3);

    abort.abort();
    expect(await running).toEqual(stop);
    // No full cycle after the one that stopped: nothing is planned or dispatched past the cap.
    expect(cycles.calls()).toBe(1);
    expect(halts).toHaveLength(1);
    expect(logger.records.filter((r) => r.event === "delivery.runner-halted").map((r) => [r.level, r.fields?.["reason"]])).toEqual([["error", stop.reason]]);
  });
});

describe("ContinuousRunner cycle scope", () => {
  test("each cycle, full or halted and whoever steps it, is numbered by the runner and runs in its own trace", async () => {
    const logger = recordingLogger();
    const loop: CycleRunner = {
      runCycle: async () => {
        logger.warn("test.in-cycle", "a full cycle's record");
        return idle();
      },
      runHaltedCycle: async () => {
        logger.error("test.in-halted-cycle", "a halted cycle's record", {});
      },
    };
    const runner = new ContinuousRunner(loop, logger, { databaseUrl: null });

    await runner.runCycle();
    await runner.runHaltedCycle();
    await runner.runCycle();

    expect(logger.records.map((record) => record.cycle)).toEqual([1, 2, 3]);
    expect(new Set(logger.records.map((record) => record.traceId)).size).toBe(3);
    const root = logger.trace();
    for (const record of logger.records) {
      expect(record.traceId).not.toBe(root);
      expect(record.parentTraceId).toBe(root);
    }
  });
});
