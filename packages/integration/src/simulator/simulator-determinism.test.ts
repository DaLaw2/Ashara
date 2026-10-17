import { describe, expect, it } from "vitest";
import type { RunOptions } from "./run.js";
import { replayed, seeded, useSimulatorDatabase } from "./simulator-harness.js";

/*
 * The fast tier's determinism tests (the seeds it judges are simulator-fast.test.ts): a seed's
 * trace is a function of the seed alone, replayed or run again in the same process.
 */
useSimulatorDatabase();

describe("lifecycle simulator, fast tier", () => {
  it("replays a seed to the same trace", async () => {
    const first = await seeded(21);
    const second = await replayed(21, first.decisions);
    // The batch of two interleaves on this seed, so the equality covers the interleaving too.
    expect(first.trace.filter((line) => line.startsWith("turn ")).length).toBeGreaterThan(0);
    expect(second.trace).toEqual(first.trace);
  }, 90_000);

  // A seed is a function of itself alone (owner 2026-10-15, fixed seeds and replay): run twice in
  // one process, the second after the first moved every counter a run can leave behind, its trace
  // (what it did, ids and commits canonical, its violations last) is byte-identical. Seeds 6 and 21
  // run one project; seeds 18 and 59 are two-project runs at the soak's cap.
  const twice: ReadonlyArray<readonly [number, Pick<RunOptions, "projects" | "capUsd">]> = [
    [6, {}],
    [21, {}],
    [18, { projects: 2, capUsd: 10 }],
    [59, { projects: 2, capUsd: 10 }],
  ];
  for (const [seed, scenario] of twice) {
    it(`runs seed ${seed}${scenario.projects === 2 ? " with two projects" : ""} twice to the same trace`, async () => {
      const first = await seeded(seed, scenario);
      const second = await seeded(seed, scenario);
      expect(second.trace.join("\n")).toBe(first.trace.join("\n"));
    }, 120_000);
  }
});
