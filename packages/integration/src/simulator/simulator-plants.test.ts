import { describe, expect, it } from "vitest";
import { BATCH_OF_TWO, directed, keys, statements, switchAtEvery, useSimulatorDatabase } from "./simulator-harness.js";

/*
 * The directed tier's plants (simulator-harness.ts directed) on concurrency and the host: each
 * mutation an invariant must catch, beside the clean run of the same tape, which passes.
 * Each test makes one directed run, or two where one judgment needs both, so a test's time is a
 * run's and fits its timeout under the whole suite's load. The directed tier's plants are split
 * across the simulator-plants*.test.ts files so vitest runs them on separate workers.
 * The faults, transport answers and adversarial stand-ins production meets are the
 * simulator-faults*.test.ts files.
 */
useSimulatorDatabase();

describe("lifecycle simulator, directed", () => {
  // Two implementations run in one batch and one finalize waits on the other's checkout. Skipping
  // that wait lets one finalize reset, merge into or clean the checkout while the other's merge is
  // staged there, which I7's merge-queue clause names; which of its git calls meets the staged merge
  // first is the schedule's, not the clause's. The turn is handed on after every host git call
  // returns, so each finalize is entered while the other is part way through its own, and the other's
  // reset and clean come after this one's merge is staged. A directed run is a function of its
  // directions alone: run twice, its trace is byte-identical.
  const CHECKOUT_RACE = [...BATCH_OF_TWO, switchAtEvery(/^interleave:git:.*:returned$/)];
  it("runs two finalizes contending on one checkout clean, to the same trace twice", async (ctx) => {
    const clean = await directed(ctx, CHECKOUT_RACE);
    expect(keys(clean), statements(clean)).toEqual([]);
    expect([...clean.coverage.concurrency]).toContain("contended:target-checkout");
    const again = await directed(ctx, CHECKOUT_RACE);
    expect(again.trace.join("\n")).toBe(clean.trace.join("\n"));
  }, 120_000);

  it("catches two finalizes overlapping on one checkout when the checkout lock is skipped", async (ctx) => {
    const planted = await directed(ctx, CHECKOUT_RACE, { mutation: "no-checkout-lock" });
    const overlaps = keys(planted).filter((key) => key.startsWith("I7:checkout-overlap:"));
    expect(overlaps.length, statements(planted)).toBeGreaterThan(0);
  }, 90_000);

  // With one project the admission queue's absence admits nothing more, so here two projects share
  // one deployment cap of $3, spent to the cap by the first two lanes' tasks. The turn is handed on
  // after every database call returns, so an admission's spend read is followed by the other task's:
  // skipping the queue lets both pass on one headroom smaller than their two estimates. The race
  // needs the two tasks' admissions in step, as the first two lanes are, starting together; a lane
  // that refills starts part-way through the other lane's task, so the cap is one the first two
  // tasks reach. The in-flight read precedes the spend read, so what this catches is the queue's
  // race, not a race between those two reads.
  const ADMISSION_RACE = [...BATCH_OF_TWO, switchAtEvery(/^interleave:db:.*:returned$/)];
  const SHARED_CAP_3 = { projects: 2, capUsd: 3 } as const;
  it("admits two projects' tasks racing on one deployment cap within it", async (ctx) => {
    const clean = await directed(ctx, ADMISSION_RACE, SHARED_CAP_3);
    expect(keys(clean), statements(clean)).toEqual([]);
    expect([...clean.coverage.concurrency]).toContain("contended:spend-admission");
  }, 90_000);

  it("catches two admissions passing the deployment's cap on one headroom when the admission queue is skipped", async (ctx) => {
    const planted = await directed(ctx, ADMISSION_RACE, { ...SHARED_CAP_3, mutation: "no-admission-queue" });
    expect(keys(planted)).toEqual(["I5:over-committed"]);
  }, 90_000);

  // An admitted call's estimate is its llm_calls row, pending until the call is recorded, and the
  // spend read counts it. Planted (pending-uncounted), the read leaves the pending rows out, as an
  // in-memory in-flight set is left out by the next process. The turn is handed on at every model
  // call, after its admission and before its record: the other task's admission is made while the
  // call is in flight, up to the two projects' shared cap of $6.
  const IN_FLIGHT = [...BATCH_OF_TWO, switchAtEvery(/^interleave:model:/)];
  const SHARED_CAP_6 = { projects: 2, capUsd: 6 } as const;
  it("admits a task while another's admitted call is in flight within the shared cap", async (ctx) => {
    const clean = await directed(ctx, IN_FLIGHT, SHARED_CAP_6);
    expect(keys(clean), statements(clean)).toEqual([]);
  }, 90_000);

  it("catches an admission that leaves out the calls admitted and not yet recorded", async (ctx) => {
    const planted = await directed(ctx, IN_FLIGHT, { ...SHARED_CAP_6, mutation: "pending-uncounted" });
    expect(keys(planted)).toEqual(["I5:over-committed"]);
  }, 90_000);

  // I8 on no progress: the host cannot start a cell all run. Production requeues the environment
  // task uncharged three times, halts the project on the fourth fault, the probe resumes it, and the
  // fifth gives the task up, so the plan is repaired until it halts undeliverable. With the count
  // pinned at the halt, the project halts and resumes forever: busy, every cycle a new halt episode,
  // and nothing reached that was not reached before.
  const OUTAGE = { cellOutage: true } as const;
  it("halts a project whose host cannot start a cell", async (ctx) => {
    const clean = await directed(ctx, [], OUTAGE);
    expect(keys(clean)).toEqual([]);
    expect(clean.outcome.kind).toBe("halted");
  }, 90_000);

  it("catches a halt and resumption that repeat with no progress", async (ctx) => {
    const planted = await directed(ctx, [], { ...OUTAGE, mutation: "infrastructure-fault-pinned" });
    expect(planted.trace.filter((line) => line.endsWith("1 task(s) [interrupted]")).length).toBeGreaterThan(4);
    expect(keys(planted)).toEqual(["I1:open", "I8:Pending"]);
    expect(planted.outcome.kind).toBe("open");
  }, 90_000);

  // I7's residue clause: a given-up task's branch is one no attempt reads. Under the cell outage
  // above the environment task is given up on its fifth fault, after its attempts made its branch,
  // and the clean run of that outage passes the clause. With the Abandoned left out of the settled
  // release, the branch stays on the host and the clause names it.
  it("catches a given-up task's branch left on the host when its cleanup is skipped", async (ctx) => {
    const planted = await directed(ctx, [], { ...OUTAGE, mutation: "abandoned-release-skipped" });
    expect(keys(planted), statements(planted)).toEqual(["I7:residue:branch:Define and commit the project environment"]);
  }, 90_000);

  // The settled release runs in the cycle that stops at the deployment cap and on every halted
  // cycle after it: a check task completes in the batch that reaches a cap of $4, and the deletion
  // of its throwaway branch fails (the fourth `git branch`). The runner runs no full cycle after the
  // stop, so a release only at the top of a full cycle would never delete the branch until a
  // restart; the residue clause would name it.
  it("releases the branch of a task settled in the cycle that reached the deployment cap", async (ctx) => {
    const result = await directed(ctx, [...BATCH_OF_TWO, { kind: "fault", seam: "git", label: "branch", nth: 4, fault: "git-failed" }], { capUsd: 4 });
    expect(result.outcome).toMatchObject({ kind: "halted", cause: "spend_cap" });
    expect(result.records.some((r) => r.event === "quality.check-branch-left" && `${r.fields?.["branch"] ?? ""}`.startsWith("check/"))).toBe(true);
    expect(keys(result), statements(result)).toEqual([]);
  }, 90_000);
});
