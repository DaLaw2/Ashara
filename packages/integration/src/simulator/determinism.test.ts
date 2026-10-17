import { describe, expect, it } from "vitest";
import { DETERMINISM_RECHECKS, recheckDeterminism } from "./determinism.js";
import type { RunMode } from "./run.js";

describe("the soak tier's determinism recheck", () => {
  it("runs the second seed of each fast-tier determinism scenario, by the soak's project count", () => {
    expect(DETERMINISM_RECHECKS[1]).toEqual({ seed: 6, mode: {} });
    expect(DETERMINISM_RECHECKS[2]).toEqual({ seed: 59, mode: { projects: 2, capUsd: 10 } });
  });

  it("runs the seed twice in its mode, one run after the other, and passes the same trace", async () => {
    const runs: Array<{ seed: number; mode: RunMode; startedWith: number }> = [];
    let finished = 0;
    const verdict = await recheckDeterminism(DETERMINISM_RECHECKS[2], async (seed, mode) => {
      runs.push({ seed, mode, startedWith: finished });
      await Promise.resolve();
      finished += 1;
      return { trace: ["universe a", "turn impl"] };
    });
    expect(runs).toEqual([
      { seed: 59, mode: { projects: 2, capUsd: 10 }, startedWith: 0 },
      { seed: 59, mode: { projects: 2, capUsd: 10 }, startedWith: 1 },
    ]);
    expect(verdict).toEqual({ line: "determinism: seed 59 (two projects, cap $10) run twice in one process: the same trace", failed: false });
  });

  it("fails on a second trace that differs, naming the first line where they part", async () => {
    const traces = [["universe a", "turn impl", "end"], ["universe a", "turn check"]];
    const verdict = await recheckDeterminism(DETERMINISM_RECHECKS[1], async () => ({ trace: traces.shift() ?? [] }));
    expect(verdict.failed).toBe(true);
    expect(verdict.line).toBe(
      'determinism: seed 6 (one project, the tape\'s cap) run twice in one process: the traces differ at line 2: "turn impl" the first time, "turn check" the second',
    );
  });

  it("fails on a second trace that only ends early", async () => {
    const traces = [["universe a", "end"], ["universe a"]];
    const verdict = await recheckDeterminism(DETERMINISM_RECHECKS[1], async () => ({ trace: traces.shift() ?? [] }));
    expect(verdict).toMatchObject({ failed: true, line: expect.stringContaining('line 2: "end" the first time, (the trace ended) the second') });
  });

  it("fails, never passes over it, when a run throws", async () => {
    const verdict = await recheckDeterminism(DETERMINISM_RECHECKS[1], async () => {
      throw new RangeError("the scratch database is gone");
    });
    expect(verdict.failed).toBe(true);
    expect(verdict.line).toContain("no verdict: the run threw");
    expect(verdict.line).toContain("the scratch database is gone");
  });
});
