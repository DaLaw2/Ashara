import { describe, expect, it } from "vitest";
import { logRecordSchema } from "@ashara/shared";
import { diffExpected } from "./expected-failures.js";
import { minimize } from "./minimize.js";
import { seeded, statements, useSimulatorDatabase } from "./simulator-harness.js";

/**
 * The fast tier: fixed seeds on today's code, each judged against
 * expected-failures.ts. A seed listed there must fail exactly the violation keys listed; any
 * other seed must pass every invariant. The soak tier is `just simulate`. Every run has
 * two lanes (production's ASHARA_TASK_LANES default). A test that needs one behaviour forces it on a directed
 * tape (the directed tier, the simulator-faults*.test.ts and simulator-plants*.test.ts files), never
 * by a seed found to reach it. The fast tier's determinism tests are the simulator-determinism*.test.ts
 * files.
 *
 * Seeds 1 (typical), 10 (benign) and 14 (hostile) run here, one seed of each of three profiles. Every seed
 * from 1 to 80 is the merge lane's soak (`just simulate --seeds 80`), which judges each against the
 * same expected-failures.ts entries (simulate.ts soakSeed, diffExpected), so a seed here is a fast
 * representative, not the coverage itself.
 */
const FAST_SEEDS = [1, 10, 14] as const;

useSimulatorDatabase();

describe("lifecycle simulator, fast tier", () => {
  for (const seed of FAST_SEEDS) {
    it(`seed ${seed} fails exactly its listed violations`, async (ctx) => {
      const result = await seeded(ctx, seed);
      expect(diffExpected(result, {}), statements(result)).toEqual({ unexpected: [], missing: [] });
      // Production's log port reaches the run: each completed cycle is a record the reader keys by event.
      expect(result.records.filter((record) => record.event === "delivery.cycle-complete").length).toBeGreaterThan(0);
      for (const record of result.records) logRecordSchema.parse(JSON.parse(JSON.stringify(record)));
    }, 90_000);
  }
});

describe("minimize", () => {
  it("reduces a failing tape to the decisions the failure needs", async () => {
    const tape = Array.from({ length: 12 }, (_, i) => ({ key: `site#${i}`, value: 1 }));
    const needs = new Set(["site#3", "site#9"]);
    const reduced = await minimize(tape, async (decisions) => [...needs].every((key) => decisions.some((d) => d.key === key)), 100);
    expect(reduced.decisions.map((d) => d.key).sort()).toEqual(["site#3", "site#9"]);
    expect(reduced.budgetExhausted).toBe(false);
  });
});
