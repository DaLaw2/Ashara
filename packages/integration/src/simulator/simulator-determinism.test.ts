import { describe, expect, it } from "vitest";
import { replayed, seeded, useSimulatorDatabase } from "./simulator-harness.js";

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
  it("runs seed 21 twice and replays it, each to the same trace", async () => {
    const first = await seeded(21);
    const second = await seeded(21);
    expect(second.trace.join("\n")).toBe(first.trace.join("\n"));
    const replay = await replayed(21, first.decisions);
    // The batch of two interleaves on this seed, so the equality covers the interleaving too.
    expect(first.trace.filter((line) => line.startsWith("turn ")).length).toBeGreaterThan(0);
    expect(replay.trace).toEqual(first.trace);
  }, 180_000);

  // Seed 18 is a two-project run at the soak's cap.
  it("runs seed 18 with two projects twice to the same trace", async () => {
    const first = await seeded(18, { projects: 2, capUsd: 10 });
    const second = await seeded(18, { projects: 2, capUsd: 10 });
    expect(second.trace.join("\n")).toBe(first.trace.join("\n"));
  }, 120_000);
});
