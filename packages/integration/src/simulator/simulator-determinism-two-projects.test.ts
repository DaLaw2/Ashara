import { describe, expect, it } from "vitest";
import type { RunMode, RunResult } from "./run.js";
import { seeded, useSimulatorDatabase } from "./simulator-harness.js";

/** The second run of a seed had no first run to compare with: the test that makes it failed or did not run. */
class FirstRunMissing extends Error {
  constructor(readonly seed: number) {
    super(`seed ${seed}: no first run to compare the second with; its test failed or did not run first`);
    this.name = "FirstRunMissing";
  }
}

const TWO_PROJECTS: RunMode = { projects: 2, capUsd: 10 };

/*
 * The fast tier's two-project determinism test, beside simulator-determinism.test.ts's one-project
 * scenario so vitest runs the two on separate workers: run twice in one process, a two-project
 * seed's trace is byte-identical. The soak tier runs this scenario's second seed twice
 * (determinism.ts).
 */
useSimulatorDatabase();

describe("lifecycle simulator, fast tier", () => {
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
