import { describe, expect, it } from "vitest";
import {
  BATCH_OF_TWO,
  UNREACHED_CAP_USD,
  capAtRace,
  directed,
  keys,
  statements,
  switchAtEvery,
  useSimulatorDatabase,
} from "./simulator-harness.js";
import type { TestScope } from "./simulator-harness.js";
import type { Direction } from "./tape.js";

/*
 * The directed tier's plants on the spend cap's admission (simulator-plants.test.ts holds the
 * other concurrency and host plants): two projects share one deployment cap, so their tasks'
 * admissions race on it. A spend estimate grows with its request's bytes, so a fixed cap lands
 * the race only for the prompts it was tuned to: each run is capped where a probe of the same tape
 * under an unreached cap shows the first race between the two tasks (capAtRace), so each test
 * makes the probe and the run it judges, and every plant is judged again on a tender padded so
 * every prompt that quotes it grows.
 */
useSimulatorDatabase();

const PADDINGS = [0, 4000] as const;

/** The two-project shape of `tape` capped at its first race, the tender padded by `requestPaddingBytes`. */
async function racedOn(ctx: TestScope, tape: readonly Direction[], requestPaddingBytes: number) {
  const probe = await directed(ctx, tape, { projects: 2, capUsd: UNREACHED_CAP_USD, requestPaddingBytes });
  return { projects: 2, capUsd: capAtRace(probe), requestPaddingBytes } as const;
}

describe("lifecycle simulator, directed, the spend cap's admission", () => {
  // With one project the admission queue's absence admits nothing more. The turn is handed on
  // after every database call returns, so an admission's spend read is followed by the other task's:
  // skipping the queue lets both pass on one headroom smaller than their two estimates. The race
  // needs the two tasks' admissions in step, as the first two lanes are, starting together; a lane
  // that refills starts part-way through the other lane's task, so the cap is the first two tasks'
  // race. The in-flight read precedes the spend read, so what this catches is the queue's race, not
  // a race between those two reads.
  const ADMISSION_RACE = [...BATCH_OF_TWO, switchAtEvery(/^interleave:db:.*:returned$/)];
  it("admits two projects' tasks racing on one deployment cap within it", async (ctx) => {
    const clean = await directed(ctx, ADMISSION_RACE, await racedOn(ctx, ADMISSION_RACE, 0));
    expect(keys(clean), statements(clean)).toEqual([]);
    expect([...clean.coverage.concurrency]).toContain("contended:spend-admission");
  }, 90_000);

  for (const padding of PADDINGS) {
    it(`catches two admissions passing the deployment's cap on one headroom when the admission queue is skipped, the tender padded by ${padding} bytes`, async (ctx) => {
      const capped = await racedOn(ctx, ADMISSION_RACE, padding);
      const planted = await directed(ctx, ADMISSION_RACE, { ...capped, mutation: "no-admission-queue" });
      expect(keys(planted)).toEqual(["I5:over-committed"]);
    }, 90_000);
  }

  // An admitted call's estimate is its llm_calls row, pending until the call is recorded, and the
  // spend read counts it. Planted (pending-uncounted), the read leaves the pending rows out, as an
  // in-memory in-flight set is left out by the next process. The turn is handed on at every model
  // call, after its admission and before its record: the other task's admission is made while the
  // call is in flight.
  const IN_FLIGHT = [...BATCH_OF_TWO, switchAtEvery(/^interleave:model:/)];
  it("admits a task while another's admitted call is in flight within the shared cap", async (ctx) => {
    const clean = await directed(ctx, IN_FLIGHT, await racedOn(ctx, IN_FLIGHT, 0));
    expect(keys(clean), statements(clean)).toEqual([]);
  }, 90_000);

  for (const padding of PADDINGS) {
    it(`catches an admission that leaves out the calls admitted and not yet recorded, the tender padded by ${padding} bytes`, async (ctx) => {
      const capped = await racedOn(ctx, IN_FLIGHT, padding);
      const planted = await directed(ctx, IN_FLIGHT, { ...capped, mutation: "pending-uncounted" });
      expect(keys(planted)).toEqual(["I5:over-committed"]);
    }, 90_000);
  }
});
