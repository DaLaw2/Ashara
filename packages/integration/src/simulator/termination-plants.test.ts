import { describe, expect, it } from "vitest";
import { keys, liveness, persona, statementsAndOutcome as statements, useSimulatorDatabase } from "./simulator-harness.js";

/*
 * W1 and W2 each fail on a plant that removes the bound it judges (W3 and W4 are
 * termination-unbounded.test.ts). A never-satisfied reviewer rejects the same correct check every
 * round, and its re-sampled second review agrees, so the review loop runs on the review's own
 * bound: two namings per check task, then a give-up and a plan repair, twice, then a typed halt
 * with its report. An implementer that stalls every attempt spends its whole turn cap each time, so
 * its task runs on the work ledger's bound.
 */
useSimulatorDatabase();

describe("the termination invariants against plants", () => {
  const NEVER_SATISFIED = [persona("suite-review", 1)];
  const STALLS = [{ kind: "draw", site: "agent.timeout", scope: "implementation", nth: "every", value: 1 } as const];
  const TASK = 'Write the checks for "Deliver b1, b2 [sim t1]"';

  it("W1: names a task that drew past the per-task bound when the work ledger reads nothing drawn", async (ctx) => {
    const clean = await liveness(ctx, STALLS);
    expect(keys(clean), statements(clean)).toEqual([]);
    expect(clean.outcome, statements(clean)).toMatchObject({ kind: "halted", cause: "undeliverable" });
    const planted = await liveness(ctx, STALLS, { mutation: "ledger-draw-skipped" });
    expect(keys(planted), statements(planted)).toEqual(["W1:task:Deliver b1, b2 [sim t1]"]);
  }, 300_000);

  it("W2: names a review round that left no count when a review drops its earlier findings", async (ctx) => {
    const planted = await liveness(ctx, NEVER_SATISFIED, { mutation: "review-count-reset" });
    expect(keys(planted), statements(planted)).toEqual([`W2:review-uncounted:${TASK}`]);
  }, 300_000);
});
