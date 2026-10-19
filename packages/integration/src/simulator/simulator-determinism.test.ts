import { describe, expect, it } from "vitest";
import type { RunMode, RunResult } from "./run.js";
import { replayed, seeded, useSimulatorDatabase } from "./simulator-harness.js";

/** The second run of a seed had no first run to compare with: the test that makes it failed or did not run. */
class FirstRunMissing extends Error {
  constructor(readonly seed: number) {
    super(`seed ${seed}: no first run to compare the second with; its test failed or did not run first`);
    this.name = "FirstRunMissing";
  }
}

const TWO_PROJECTS: RunMode = { projects: 2, capUsd: 10 };

/*
 * The fast tier's determinism tests (the seeds it judges are simulator-fast.test.ts): a seed's
 * trace is a function of the seed alone, replayed or run again in the same process. One seed per
 * scenario runs here; the soak tier runs each scenario's second seed twice (determinism.ts).
 */
useSimulatorDatabase();

describe("lifecycle simulator, fast tier", () => {
  // A seed is a function of itself alone: run twice in
  // one process, the second after the first moved every counter a run can leave behind, its trace
  // (what it did, ids and commits canonical, its violations last) is byte-identical, and so is a
  // replay of the first run's decisions.
  it("runs seed 21 twice and replays it, each to the same trace", async (ctx) => {
    const first = await seeded(ctx, 21);
    const second = await seeded(ctx, 21);
    expect(second.trace.join("\n")).toBe(first.trace.join("\n"));
    const replay = await replayed(ctx, 21, first.decisions);
    // The batch of two interleaves on this seed, so the equality covers the interleaving too.
    expect(first.trace.filter((line) => line.startsWith("turn ")).length).toBeGreaterThan(0);
    expect(replay.trace).toEqual(first.trace);
  }, 180_000);

  // Seed 18 is a two-project run at the soak's cap. Its two runs are two tests, each under its own
  // timeout, since one two-project run alone takes most of a test's timeout under a loaded suite.
  let firstOf18: RunResult | null = null;
  it("runs seed 18 with two projects", async (ctx) => {
    firstOf18 = await seeded(ctx, 18, TWO_PROJECTS);
    expect(firstOf18.trace.length).toBeGreaterThan(0);
  }, 120_000);

  it("runs seed 18 with two projects again to the same trace", async (ctx) => {
    const first = firstOf18;
    if (first === null) throw new FirstRunMissing(18);
    const second = await seeded(ctx, 18, TWO_PROJECTS);
    expect(second.trace.join("\n")).toBe(first.trace.join("\n"));
  }, 120_000);
});
