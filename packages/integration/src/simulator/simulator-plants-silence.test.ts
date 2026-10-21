import { describe, expect, it } from "vitest";
import { directed, draw, keys, statements, useSimulatorDatabase } from "./simulator-harness.js";

/*
 * The directed tier's plants (simulator-harness.ts directed) on whether the client is told at all:
 * each suppresses one report, and I2's or I4's silence clause must name the event it would have told.
 * The directed tier's plants are split across the simulator-plants*.test.ts files so vitest runs
 * them on separate workers.
 */
useSimulatorDatabase();

/** The host cannot start a cell all run (RunOptions.cellOutage): the project halts on infrastructure, and the probe resumes it. */
const OUTAGE = { cellOutage: true } as const;
/** The client stops the project at cycle 5, after three tasks merged. */
const STOP = [draw("client.stop", 1), draw("client.stop-cycle", 1, 3)];
/** Every plan the planner answers does not parse, so the first planning stops. */
const PLAN_STOPS = [draw("model.decomposition.tasks.invalid", "every")];

describe("lifecycle simulator, directed: every terminal event is told", () => {
  // The outage's infrastructure halt is ended by the probe, so a halt never told is named whether it
  // is still open or ended before it was told.
  it("catches halts the client is never told of", async (ctx) => {
    const planted = await directed(ctx, [], { ...OUTAGE, mutation: "halt-report-suppressed" });
    expect(keys(planted), statements(planted)).toContain("I2:episode:infrastructure");
  }, 90_000);

  it("catches a resumption the client is never told of", async (ctx) => {
    const planted = await directed(ctx, [], { ...OUTAGE, mutation: "resumption-report-suppressed" });
    expect(keys(planted), statements(planted)).toContain("I2:episode-resumed:infrastructure");
  }, 90_000);

  it("catches a client stop that is never answered", async (ctx) => {
    const planted = await directed(ctx, STOP, { mutation: "stop-report-suppressed" });
    expect(planted.outcome.kind).toBe("stopped");
    expect(keys(planted), statements(planted)).toContain("I4:stop-unreported");
  }, 90_000);

  it("tells the client its first planning stopped", async (ctx) => {
    const clean = await directed(ctx, PLAN_STOPS);
    expect(clean.outcome, statements(clean)).toMatchObject({ kind: "halted", cause: "undeliverable" });
    expect(keys(clean), statements(clean)).toEqual([]);
  }, 90_000);

  it("catches a planning stop the client is never told of", async (ctx) => {
    const planted = await directed(ctx, PLAN_STOPS, { mutation: "planning-stopped-report-suppressed" });
    expect(keys(planted), statements(planted)).toContain("I2:episode:planning_stopped");
  }, 90_000);
});
