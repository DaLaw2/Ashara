import { describe, expect, it } from "vitest";
import { keys, liveness, persona, statementsAndOutcome as statements, useSimulatorDatabase } from "./simulator-harness.js";

/**
 * The termination invariants (termination.ts) on directed tapes under the liveness profile: each
 * persona, forced by name, permanent from the first cycle, and the project still ends through a
 * typed, reported state with every invariant holding. Each W failing on a plant that removes the
 * bound it judges is termination-plants.test.ts and termination-unbounded.test.ts.
 */
useSimulatorDatabase();

const REVIEWERS = ["never-satisfied", "rotating", "resurrecting", "flip-flop", "self-refuting", "correlated-second", "lazy-pass"] as const;

describe("termination under permanent personas", () => {
  for (const [index, name] of REVIEWERS.entries()) {
    it(`ends a project whose reviewer is ${name}`, async (ctx) => {
      const result = await liveness(ctx, [persona("suite-review", index + 1)]);
      expect(result.trace).toContain(`personas suite-review=${name} planner=honest classifier=honest check-author=honest intake=honest from cycle 1`);
      expect(keys(result), statements(result)).toEqual([]);
      expect(result.outcome.kind, statements(result)).not.toBe("open");
    }, 150_000);
  }

  it("ends a project whose planner oscillates, whose classifier flips, whose check author is sticky-bad and whose intake is lazy", async (ctx) => {
    const result = await liveness(ctx, [persona("planner", 1), persona("classifier", 1), persona("check-author", 1), persona("intake", 1)]);
    expect(result.trace).toContain("personas suite-review=honest planner=oscillating classifier=flipping check-author=sticky-bad intake=lazy from cycle 1");
    expect(keys(result), statements(result)).toEqual([]);
    expect(result.outcome.kind, statements(result)).not.toBe("open");
  }, 150_000);
});
