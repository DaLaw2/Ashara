import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { Interleaver } from "./interleave.js";
import { Tape } from "./tape.js";

/**
 * Two tasks of three seam calls each, the second task's calls slowed by real time that varies per
 * call: whatever the timing, the order the calls run in must be the seed's.
 */
async function order(seed: number, jitter: (task: string, call: number) => number): Promise<string[]> {
  const ran: string[] = [];
  const interleaver = new Interleaver(new Tape({ kind: "seeded", seed }), new Set(), () => {});
  await interleaver.lanes([{ id: "a" }, { id: "b" }], async (task) => {
    for (let call = 0; call < 3; call++) {
      await sleep(jitter(task.id, call));
      await interleaver.turn(`db:call ${call}`);
      ran.push(`${task.id}${call}`);
    }
  });
  return ran;
}

describe("Interleaver", () => {
  it("runs a batch's seam calls in the seed's order whatever the timing", async () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const quick = await order(seed, () => 0);
      const slowed = await order(seed, (task, call) => (task === "b" ? 3 * (call + 1) : 1));
      expect(slowed).toEqual(quick);
    }
  });

  it("hands the turn on when a task waits on the other, and takes it back after", async () => {
    const interleaver = new Interleaver(new Tape({ kind: "replay", decisions: [] }), new Set(), () => {});
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ran: string[] = [];
    const settled = await interleaver.lanes([{ id: "a" }, { id: "b" }], async (task) => {
      if (task.id === "a") {
        // On a replay tape with no decisions the turn is never handed on at a seam call: a runs
        // until it waits, and only the wait lets b run, which releases what a waits on.
        await interleaver.contended("target-checkout", held);
        ran.push("a after its wait");
        return;
      }
      await interleaver.turn("git:merge");
      ran.push("b");
      release();
    });
    expect(settled.map((s) => s.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(ran).toEqual(["b", "a after its wait"]);
  });
});
