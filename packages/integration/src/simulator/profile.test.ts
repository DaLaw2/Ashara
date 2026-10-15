import { describe, expect, it } from "vitest";
import { drawRates } from "./profile.js";
import { Tape } from "./tape.js";

describe("drawRates", () => {
  // Test retro 2026-10-15 pattern 2: a review that catches at one fixed rate says nothing of one that misses more.
  it("draws the review and dispute rates per seed under hostile, chaos and adversarial, the same on every draw of a seed", () => {
    for (const profile of ["hostile", "chaos", "adversarial"] as const) {
      const seen = new Set<string>();
      for (let seed = 1; seed <= 20; seed++) {
        const first = drawRates(profile, new Tape({ kind: "seeded", seed }));
        const again = drawRates(profile, new Tape({ kind: "seeded", seed }));
        expect(again).toEqual(first);
        seen.add(`${first.reviewCatch}/${first.disputeRight}/${first.disputeWrong}`);
      }
      expect(seen.size).toBeGreaterThan(5);
    }
  });

  it("takes each varied rate's benign end on a replay that lists no decision for it", () => {
    const rates = drawRates("adversarial", new Tape({ kind: "replay", decisions: [] }));
    expect([rates.reviewCatch, rates.disputeRight, rates.disputeWrong]).toEqual([1, 1, 0]);
    const worst = drawRates("adversarial", new Tape({ kind: "replay", decisions: [{ key: "rates.reviewCatch#1", value: 10 }] }));
    expect(worst.reviewCatch).toBe(0);
  });

  it("keeps benign and typical at their fixed rates, drawing nothing", () => {
    for (const profile of ["benign", "typical"] as const) {
      const tape = new Tape({ kind: "seeded", seed: 3 });
      drawRates(profile, tape);
      expect(tape.draws().size).toBe(0);
    }
  });
});
