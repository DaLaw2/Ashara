import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CycleResult } from "./types.js";
import { ContinuousRunner } from "./runner.js";
import type { CycleRunner } from "./runner.js";

const IDLE_MS = 60_000;

/** A CycleRunner double whose behavior per call is scripted by the test. */
function scriptedCycles(script: Array<(runner: ContinuousRunner) => CycleResult>): {
  loop: CycleRunner;
  bind: (runner: ContinuousRunner) => void;
  calls: () => number;
} {
  let runner: ContinuousRunner | null = null;
  let count = 0;
  return {
    loop: {
      runCycle: async () => {
        const step = script[Math.min(count, script.length - 1)];
        count += 1;
        if (!runner || !step) throw new Error("scriptedCycles: runner not bound");
        return step(runner);
      },
    },
    bind: (r) => { runner = r; },
    calls: () => count,
  };
}

const idle = (): CycleResult => ({ tasksProcessed: 0, results: [] });

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
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
    const runner = new ContinuousRunner(cycles.loop, { idleIntervalMs: IDLE_MS, pollIntervalMs: IDLE_MS });
    cycles.bind(runner);
    const abort = new AbortController();

    const running = runner.run(abort.signal);
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
    const runner = new ContinuousRunner(cycles.loop, {
      idleIntervalMs: IDLE_MS,
      pollIntervalMs: IDLE_MS,
      maxConsecutiveErrors: 1,
    });
    cycles.bind(runner);
    const abort = new AbortController();

    const running = runner.run(abort.signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(cycles.calls()).toBe(1);

    // maxConsecutiveErrors 1 → backoff 2^1 s.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(cycles.calls()).toBe(2);

    abort.abort();
    await running;
  });
});
