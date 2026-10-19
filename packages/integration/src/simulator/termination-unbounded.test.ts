import { describe, expect, it } from "vitest";
import { keys, liveness, persona, statementsAndOutcome as statements, useSimulatorDatabase } from "./simulator-harness.js";

/*
 * W3 and W4 each fail on a plant that removes the review loop's bound (W1 and W2 are
 * termination-plants.test.ts). A never-satisfied reviewer rejects the same correct check every
 * round, and its re-sampled second review agrees, so the review loop runs on the review's own
 * bound alone.
 */
useSimulatorDatabase();

describe("the termination invariants against plants", () => {
  const NEVER_SATISFIED = [persona("suite-review", 1)];
  const TASK = 'Write the checks for "Deliver b1, b2 [sim t1]"';

  it("W3: names a measure that left its well-founded order when the review's bound is read as one naming", async (ctx) => {
    const planted = await liveness(ctx, NEVER_SATISFIED, { mutation: "suite-review-bound-ignored" });
    expect(keys(planted), statements(planted)).toEqual([`W2:review-bound:${TASK}`, `W3:unfounded:review:${TASK}`]);
  }, 300_000);

  it("W4: names a project that never ends when the review loop has neither its bound nor the work ledger", async (ctx) => {
    const planted = await liveness(ctx, NEVER_SATISFIED, { mutation: "review-loop-unbounded", maxCycles: 40 });
    expect(planted.outcome.kind).toBe("open");
    expect(keys(planted), statements(planted)).toEqual(expect.arrayContaining(["W4:open", `W1:task:${TASK}`, `W3:unfounded:review:${TASK}`]));
  }, 300_000);
});
