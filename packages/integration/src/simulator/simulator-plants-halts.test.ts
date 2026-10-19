import { describe, expect, it } from "vitest";
import { directed, draw, failed, fault, keys, statements, useSimulatorDatabase } from "./simulator-harness.js";

/*
 * The directed tier's plants (simulator-harness.ts directed) on halts, stops, refunds, containment
 * and merge records: each mutation an invariant must catch, most beside the clean run of the same
 * tape, which passes.
 * Each test makes one directed run, or two where one judgment needs both, so a test's time is a
 * run's and fits its timeout under the whole suite's load. The directed tier's plants are split
 * across the simulator-plants*.test.ts files so vitest runs them on separate workers.
 */
useSimulatorDatabase();

/** The host cannot start a cell all run (RunOptions.cellOutage). */
const OUTAGE = { cellOutage: true } as const;

describe("lifecycle simulator, directed", () => {
  // A halt's report quotes the cause recorded on its episode. Under a cell outage the project
  // halts on infrastructure and then undeliverable (plan_repair); at the low cap it halts at once.
  it("catches an outage's halt reports that state a fixed cause instead of the recorded one", async (ctx) => {
    const outage = await directed(ctx, [], { ...OUTAGE, mutation: "halt-report-fixed-cause" });
    expect(keys(outage)).toEqual(["I4:halt-cause:infrastructure", "I4:halt-cause:plan_repair"]);
  }, 90_000);

  it("catches a spend halt's report that states a fixed cause instead of the recorded one", async (ctx) => {
    const spend = await directed(ctx, [draw("finance.low-budget", 1)], { mutation: "halt-report-fixed-cause" });
    expect(spend.outcome).toMatchObject({ kind: "halted", cause: "spend_cap" });
    expect(keys(spend)).toEqual(["I4:halt-cause:budget_cap"]);
  }, 90_000);

  // The stop report names exactly the merges recorded: the client stops the project at cycle 5
  // (2 plus the stop-cycle draw), after three tasks merged.
  const STOP = [draw("client.stop", 1), draw("client.stop-cycle", 1, 3)];
  it("stops a project at the client's word, reporting the merges on record", async (ctx) => {
    const clean = await directed(ctx, STOP);
    expect(clean.outcome.kind).toBe("stopped");
    expect(clean.trace).toContain("client stop at cycle 5");
    expect(keys(clean)).toEqual([]);
  }, 90_000);

  it("catches a stop report that leaves out a merge on record", async (ctx) => {
    expect(keys(await directed(ctx, STOP, { mutation: "stop-report-omits-merge" }))).toEqual(["I4:stop-merges"]);
  }, 90_000);

  // A plant whose query production never sends planted nothing: the run says so instead of
  // reporting the mutation as not caught. At a cap of $0.02 nothing merges, so no merge record is written.
  it("throws for a plant that rewrote no query", async (ctx) => {
    await expect(directed(ctx, [], { capUsd: 0.02, mutation: "skip-merge-record" })).rejects.toThrow(/plant of mutation skip-merge-record rewrote no query/);
  }, 90_000);

  // I10: the first cell start fails, before the agent of the environment task ran. Production
  // refunds the dispatch as a substrate fault; planted, the refund gives nothing back, and the
  // attempt stays charged for work no model did.
  const UNSTARTED = [fault("podman", "run", "cell-start-failed")];
  it("charges no attempt for a cell that could not start", async (ctx) => {
    expect(keys(await directed(ctx, UNSTARTED))).toEqual([]);
  }, 90_000);

  it("names an attempt charged for a cell that could not start when its refund is skipped", async (ctx) => {
    const planted = await directed(ctx, UNSTARTED, { mutation: "dispatch-refund-skipped" });
    expect(keys(planted), statements(planted)).toEqual(["I10:dispatch:Define and commit the project environment"]);
  }, 90_000);

  // I1:cycle-error: a listing of the projects at work names a table that does not exist, so every
  // cycle throws with no fault beneath it.
  it("names a cycle that throws with no fault injected beneath it", async (ctx) => {
    const planted = await directed(ctx, [], { mutation: "active-listing-throws" });
    expect(keys(planted)).toContain("I1:cycle-error");
    expect(planted.faults).toEqual([]);
  }, 90_000);

  // Containment: the second project's rows are corrupted as the run reaches them, its first
  // task_spec (the gate halts it) and then its halt episode's kind (the block report's listing reads
  // it, contained to that report). The first project is accepted all the same; the corrupted episode
  // can never be reported, which I2 names on the second project. With containment undone (a
  // contained fault cannot be kept, so it throws through), every cycle fails for both projects, and
  // the healthy one makes no progress (I8).
  const CORRUPTED = { projects: 2, corruptSecondProject: true } as const;
  it("keeps one project's corrupted rows from stopping the other", async (ctx) => {
    const contained = await directed(ctx, [], CORRUPTED);
    expect(contained.outcome.kind).toBe("accepted");
    expect(contained.trace).toEqual(expect.arrayContaining(["plant: the second project's first task_spec corrupted", "contained block-report"]));
    expect(keys(contained), statements(contained)).toEqual(["I2:p2:episode:planted-unknown-kind"]);
  }, 90_000);

  it("names the stall when one project's corrupted rows are no longer contained", async (ctx) => {
    const uncontained = await directed(ctx, [], { ...CORRUPTED, mutation: "step-fault-unrecorded" });
    expect(keys(uncontained)).toEqual(expect.arrayContaining(["I1:cycle-error", "I8:Pending"]));
  }, 90_000);

  // The clean run of this tape is the one "accepts a project on a passed sweep" (simulator-plants-delivery.test.ts) judges free of violations.
  it("catches a merge recorded under a commit main does not hold", async (ctx) => {
    const planted = await directed(ctx, [], { mutation: "skip-merge-record" });
    expect(failed(planted)).toContain("I7");
  }, 90_000);
});
