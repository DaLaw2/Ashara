import { describe, expect, it } from "vitest";
import { directed, draw, keys, statements, useSimulatorDatabase } from "./simulator-harness.js";

/*
 * The directed tier (simulator-harness.ts directed) on the held-set rule: a check author whose every
 * check passes on the plan's foundation, for a first plan's task, whose items no client correction
 * put in scope. The set is rejected for that reason on each attempt, and the task is given up with
 * the held-set reason at the rule's bound of identical rejections, never attempted without end.
 */
useSimulatorDatabase();

/**
 * How many identical rejections give a task up, as this oracle states the held-set rule, never read
 * from the production value it judges.
 */
const GIVE_UP_AFTER = 3;

describe("lifecycle simulator, directed: the held-set rule", () => {
  const ALL_GUARD = Array.from({ length: GIVE_UP_AFTER }, (_, i) => draw("agent.check.all-guard", i + 1));

  it("gives a check task up with the held-set reason when its all-guard set is rejected for the same items at the bound", async (ctx) => {
    const run = await directed(ctx, ALL_GUARD);
    const trace = `${statements(run)}\n${run.trace.join("\n")}`;
    const givenUp = run.records.filter((r) => r.event === "quality.held-set-given-up");
    expect(givenUp, trace).toHaveLength(1);
    expect(givenUp[0]?.fields, trace).toMatchObject({ unheld: "uncorrected", identical: GIVE_UP_AFTER });
    expect(run.coverage.blockedSources.has("failure_given_up"), trace).toBe(true);
    expect(run.coverage.holds.has("uncorrected"), trace).toBe(true);
    // The plan is repaired around the given-up task and the project is still accepted.
    expect(keys(run), trace).toEqual([]);
    expect(run.outcome.kind, trace).toBe("accepted");
  }, 90_000);
});
