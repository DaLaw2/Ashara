import { describe, expect, it } from "vitest";
import { RARE_UNDER_OWN_PROFILES } from "./coverage.js";
import { directed, fault, keys, statements, useSimulatorDatabase } from "./simulator-harness.js";
import type { Direction } from "./tape.js";

/*
 * The directed tier's rare faults (simulator-harness.ts directed): production meets each forced
 * fault and passes every invariant.
 * The directed tier's faults are split across the simulator-faults*.test.ts files so vitest runs
 * them on separate workers; the plants the invariants must catch are the simulator-plants*.test.ts
 * files.
 */
useSimulatorDatabase();

describe("lifecycle simulator, directed", () => {
  /*
   * The fault kinds the seeded soak reaches too seldom to floor (coverage.ts
   * RARE_UNDER_OWN_PROFILES), each forced on the first call that can carry it: production answers
   * each without breaking an invariant. A key marked rare that no entry here forces fails the first
   * test.
   */
  const RARE_FAULTS: readonly Direction[] = [
    fault("db", "connect", "db-unreachable"),
    fault("podman", "run", "cell-start-failed"),
    fault("podman", "exec", "cell-exec-failed"),
    fault("podman", "rm", "cell-teardown-failed"),
    fault("podman", "info", "substrate-down"),
    fault("podman", "build", "image-build-failed"),
    fault("model", /./, "crash-before"),
    fault("model", /./, "sigterm"),
    fault("model", /./, "provider-error"),
    fault("model", /./, "clock-jump"),
  ];
  const pairOf = (direction: Direction): string => (direction.kind === "fault" ? `${direction.seam}:${direction.fault}` : "");

  it("forces every fault kind the soak reaches too seldom to floor", () => {
    const rare = [...RARE_UNDER_OWN_PROFILES.keys()].filter((key) => key.startsWith("faults ")).map((key) => key.slice("faults ".length));
    expect(RARE_FAULTS.map(pairOf).sort()).toEqual(rare.sort());
  });

  for (const direction of RARE_FAULTS) {
    const pair = pairOf(direction);
    it(`carries ${pair} on the first call that can carry it`, async (ctx) => {
      const result = await directed(ctx, [direction]);
      expect(result.faults.map((f) => `${f.seam}:${f.fault}`)).toEqual([pair]);
      if (pair === "model:provider-error") {
        // A transport failure is the provider's, as production's adapter reports it: the read that
        // made the request counts it, and it never escapes the cycle as an Ashara fault.
        expect(result.trace.filter((line) => /^cycle \d+: error/.test(line))).toEqual([]);
        expect(result.log.some((line) => line.includes("(the provider failed the request)"))).toBe(true);
      }
      expect(keys(result), statements(result)).toEqual([]);
    }, 90_000);
  }
});
