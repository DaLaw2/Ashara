import { describe, expect, it } from "vitest";
import { Scheduler, SimulatedCrash } from "./faults.js";
import type { InstanceHandle } from "./faults.js";
import { Interleaver } from "./interleave.js";
import { Tape } from "./tape.js";

function instance(): InstanceHandle {
  return { name: "sim-1", dead: false, abort: () => {}, sigtermed: false, fatal: null, checkouts: new Map(), pools: [] };
}

/** No batch runs in these tests: every call is outside a task's lane and takes no turn. */
function outsideBatches(tape: Tape): Interleaver {
  return new Interleaver(tape, new Set(), () => {});
}

describe("Scheduler", () => {
  // The L2 review: a fault drawn for a call it cannot touch was recorded, and counted as reached.
  it("records only faults the call can carry", async () => {
    const tape = new Tape({ kind: "seeded", seed: 7 });
    const scheduler = new Scheduler(tape, { perSeamCall: 1, budget: 200 }, outsideBatches(tape));
    for (let i = 0; i < 200; i++) {
      await scheduler.enter(instance(), "podman", "run", ["cell-start-failed"]).catch((err: unknown) => {
        if (!(err instanceof SimulatedCrash)) throw err;
      });
    }
    const kinds = new Set(scheduler.faults().map((f) => f.fault));
    expect([...kinds].sort()).toEqual(["cell-start-failed", "crash-after", "crash-before", "sigterm"]);
  });

  it("turns a forced fault the call cannot carry into a crash, recorded as one", async () => {
    const tape = new Tape({ kind: "seeded", seed: 7 });
    const scheduler = new Scheduler(tape, { perSeamCall: 0, budget: 1 }, outsideBatches(tape), new Map([[1, "substrate-down"]]));
    await expect(scheduler.enter(instance(), "podman", "run", ["cell-start-failed"])).rejects.toBeInstanceOf(SimulatedCrash);
    expect(scheduler.faults().map((f) => f.fault)).toEqual(["crash-before"]);
  });
});
