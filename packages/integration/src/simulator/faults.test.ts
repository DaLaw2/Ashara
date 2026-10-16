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
  // A fault drawn for a call it cannot touch is never recorded nor counted as reached.
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

  it("injects a directed fault on its nth matching call only, and leaves one its call cannot carry untaken", async () => {
    const tape = new Tape({
      kind: "directed",
      directions: [
        { kind: "fault", seam: "podman", label: "run", nth: 2, fault: "cell-start-failed" },
        { kind: "fault", seam: "podman", label: "exec", nth: 1, fault: "substrate-down" },
      ],
    });
    const scheduler = new Scheduler(tape, { perSeamCall: 0, budget: 0 }, outsideBatches(tape));
    const fates: Array<string | null> = [];
    for (const label of ["run", "exec", "run", "run"]) fates.push((await scheduler.enter(instance(), "podman", label, [label === "run" ? "cell-start-failed" : "cell-exec-failed"])).fault);
    expect(fates).toEqual([null, null, "cell-start-failed", null]);
    expect(scheduler.faults().map((f) => `${f.ticket}:${f.fault}`)).toEqual(["3:cell-start-failed"]);
    expect(tape.untaken()).toEqual([expect.stringMatching(/^fault podman exec #1 substrate-down: its call "exec" offered only/)]);
  });
});
