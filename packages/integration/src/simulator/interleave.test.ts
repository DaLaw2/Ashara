import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { Interleaver } from "./interleave.js";
import { Tape } from "./tape.js";

/** A pool's `next` over a fixed list: each item once, then null. */
function fromList<I>(items: readonly I[]): () => Promise<I | null> {
  const queue = [...items];
  return async () => queue.shift() ?? null;
}

/**
 * Two tasks of three seam calls each, the second task's calls slowed by real time that varies per
 * call: whatever the timing, the order the calls run in must be the seed's.
 */
async function order(seed: number, jitter: (task: string, call: number) => number): Promise<string[]> {
  const ran: string[] = [];
  const interleaver = new Interleaver(new Tape({ kind: "seeded", seed }), new Set(), () => {});
  await interleaver.lanes(2, fromList([{ id: "a" }, { id: "b" }]), async (task) => {
    for (let call = 0; call < 3; call++) {
      await sleep(jitter(task.id, call));
      await interleaver.turn(`db:call ${call}`);
      ran.push(`${task.id}${call}`);
    }
  });
  return ran;
}

describe("Interleaver", () => {
  it.each([1, 2, 3, 4, 5])("runs a batch's seam calls in seed %i's order whatever the timing", async (seed) => {
    const quick = await order(seed, () => 0);
    const slowed = await order(seed, (task, call) => (task === "b" ? 3 * (call + 1) : 1));
    expect(slowed).toEqual(quick);
  });

  it("hands the turn on when a task waits on the other, and takes it back after", async () => {
    const interleaver = new Interleaver(new Tape({ kind: "replay", decisions: [] }), new Set(), () => {});
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ran: string[] = [];
    const settled = await interleaver.lanes(2, fromList([{ id: "a" }, { id: "b" }]), async (task) => {
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
    expect(settled.map((s) => s.settled.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(ran).toEqual(["b", "a after its wait"]);
  });

  it.each([1, 2, 3, 4, 5])("refills a lane whose task settled, in seed %i's order whatever the timing", async (seed) => {
    const run = async (jitter: (task: string) => number): Promise<string[]> => {
      const ran: string[] = [];
      const interleaver = new Interleaver(new Tape({ kind: "seeded", seed }), new Set(), () => {});
      const settled = await interleaver.lanes(2, fromList([{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }]), async (task) => {
        for (let call = 0; call < 2; call++) {
          await sleep(jitter(task.id));
          await interleaver.turn(`db:call ${call}`);
          ran.push(`${task.id}${call}`);
        }
      });
      expect(settled.map((s) => s.item.id)).toEqual(["a", "b", "c", "d"]);
      return ran;
    };
    const quick = await run(() => 0);
    const slowed = await run((task) => (task === "c" ? 4 : 1));
    expect(slowed).toEqual(quick);
    expect(quick).toHaveLength(8);
  });
});
