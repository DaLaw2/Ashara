import { describe, expect, it } from "vitest";
import { BATCH_OF_TWO, directed, draw, failed, fault, implementation, keys, statements, switchAtEvery, useSimulatorDatabase } from "./simulator-harness.js";
import type { Direction } from "./tape.js";

/*
 * The directed tier's plants (simulator-harness.ts directed): each mutation an invariant must catch,
 * most beside the clean run of the same tape, which passes. The faults, transport answers and
 * adversarial stand-ins production meets are simulator-faults.test.ts.
 */
useSimulatorDatabase();

/** What I6 names when a check set of the stand-ins is stored with its last decided item undecided (check-set-skips-item). */
const SKIPPED_ITEM = ["I6:unchecked-item:A1"];

describe("lifecycle simulator, directed", () => {
  // ADR-074 d82 W3: two implementations run in one batch and one finalize waits on the other's
  // checkout. Skipping that wait lets one finalize reset, merge into or clean the checkout while
  // the other's merge is staged there, which I7's merge-queue clause names; which of its git calls
  // meets the staged merge first is the schedule's, not the clause's. The turn is handed on at every host git call, so each
  // finalize is entered while the other is part way through its own. A directed run is a function
  // of its directions alone: run twice, its trace is byte-identical.
  it("catches two finalizes overlapping on one checkout when the checkout lock is skipped", async () => {
    const race = [...BATCH_OF_TWO, switchAtEvery(/^interleave:git:/)];
    const clean = await directed(race);
    expect(keys(clean), statements(clean)).toEqual([]);
    expect([...clean.coverage.concurrency]).toContain("contended:target-checkout");
    const again = await directed(race);
    expect(again.trace.join("\n")).toBe(clean.trace.join("\n"));
    const planted = await directed(race, { mutation: "no-checkout-lock" });
    const overlaps = keys(planted).filter((key) => key.startsWith("I7:checkout-overlap:"));
    expect(overlaps.length, statements(planted)).toBeGreaterThan(0);
  }, 120_000);

  // ADR-074 d84 b. With one project the admission queue's absence admits nothing more, so here two
  // projects share one deployment cap of $10, spent to the cap. The turn is
  // handed on after every database call returns, so an admission's spend read is followed by the
  // other task's: skipping the queue lets both pass on one headroom smaller than their two
  // estimates. The in-flight read precedes the spend read, so what this catches is the queue's race,
  // not a race between those two reads.
  it("catches two admissions passing the deployment's cap on one headroom when the admission queue is skipped", async () => {
    const race = [...BATCH_OF_TWO, switchAtEvery(/^interleave:db:.*:returned$/)];
    const shared = { projects: 2, capUsd: 10 } as const;
    const clean = await directed(race, shared);
    expect(keys(clean), statements(clean)).toEqual([]);
    expect([...clean.coverage.concurrency]).toContain("contended:spend-admission");
    const planted = await directed(race, { ...shared, mutation: "no-admission-queue" });
    expect(keys(planted)).toEqual(["I5:over-committed"]);
  }, 90_000);

  // Migration 053: an admitted call's estimate is its llm_calls row, pending until the call is
  // recorded, and the spend read counts it. Planted (pending-uncounted), the read leaves the pending
  // rows out, as an in-memory in-flight set is left out by the next process. The turn is handed on
  // at every model call, after its admission and before its record: the other task's admission is
  // made while the call is in flight, up to the two projects' shared cap of $6.
  it("catches an admission that leaves out the calls admitted and not yet recorded", async () => {
    const inFlight = [...BATCH_OF_TWO, switchAtEvery(/^interleave:model:/)];
    const shared = { projects: 2, capUsd: 6 } as const;
    const clean = await directed(inFlight, shared);
    expect(keys(clean), statements(clean)).toEqual([]);
    const planted = await directed(inFlight, { ...shared, mutation: "pending-uncounted" });
    expect(keys(planted)).toEqual(["I5:over-committed"]);
  }, 90_000);

  // ADR-074 d84 b, I8 on no progress: the host cannot start a cell all run. Production requeues the
  // environment task uncharged three times, halts the project on the fourth fault, the probe resumes
  // it, and the fifth gives the task up, so the plan is repaired until it halts undeliverable. With
  // the count pinned at the halt, the project halts and resumes forever: busy, every cycle a new
  // halt episode, and nothing reached that was not reached before.
  it("catches a halt and resumption that repeat with no progress", async () => {
    const outage = { cellOutage: true } as const;
    const clean = await directed([], outage);
    expect(keys(clean)).toEqual([]);
    expect(clean.outcome.kind).toBe("halted");
    const planted = await directed([], { ...outage, mutation: "infrastructure-fault-pinned" });
    expect(planted.trace.filter((line) => line.endsWith("1 task(s) [interrupted]")).length).toBeGreaterThan(4);
    expect(keys(planted)).toEqual(["I1:open", "I8:Pending"]);
    expect(planted.outcome.kind).toBe("open");
  }, 90_000);

  // ADR-080 d10 C4, I7's residue clause: a given-up task's branch is one no attempt reads. Under the
  // cell outage above the environment task is given up on its fifth fault, after its attempts made
  // its branch, and the clean run of that test passes the clause. With the Abandoned left out of the
  // settled release, the branch stays on the host and the clause names it.
  it("catches a given-up task's branch left on the host when its cleanup is skipped", async () => {
    const planted = await directed([], { cellOutage: true, mutation: "abandoned-release-skipped" });
    expect(keys(planted), statements(planted)).toEqual(["I7:residue:branch:Define and commit the project environment"]);
  }, 90_000);

  // The settled release runs in the cycle that stops at the deployment cap and on every halted
  // cycle after it: a check task completes in the batch that reaches a cap of $4, and the deletion
  // of its throwaway branch fails (the fourth `git branch`). The runner runs no full cycle after the
  // stop, so a release only at the top of a full cycle would never delete the branch until a
  // restart; the residue clause would name it.
  it("releases the branch of a task settled in the cycle that reached the deployment cap", async () => {
    const result = await directed([...BATCH_OF_TWO, { kind: "fault", seam: "git", label: "branch", nth: 4, fault: "git-failed" }], { capUsd: 4 });
    expect(result.outcome).toMatchObject({ kind: "halted", cause: "spend_cap" });
    expect(result.log.some((line) => line.includes("the throwaway branch check/") && line.includes("could not be deleted"))).toBe(true);
    expect(keys(result), statements(result)).toEqual([]);
  }, 90_000);

  // ADR-074 d84 b, W7: with no adversary the stand-ins drive the project to Accepted on one passed
  // sweep of main; the delivered report is judged against the goal tasks' merge records and the task
  // and check records, so a report that drops a goal's close, misstates what no stored check covers,
  // leaves out an asked-for item no acceptance line cites, or is posted with no record of it (and so
  // posted again) is named.
  it("accepts a project on a passed sweep and catches a delivered report that misstates its records", async () => {
    const clean = await directed([]);
    expect(clean.outcome.kind).toBe("accepted");
    expect(keys(clean)).toEqual([]);
    expect([...clean.coverage.projectStatuses]).toContain("accepted");
    expect([...clean.coverage.sweeps]).toEqual(["ran:passed"]);
    expect(keys(await directed([], { mutation: "delivered-report-omits-goal" }))).toEqual(["I4:delivered-close"]);
    expect(keys(await directed([], { mutation: "delivered-report-misstates-unchecked" }))).toEqual(["I4:delivered-unchecked"]);
    // Every in-scope line and the asked assumption (classed undecided, so client-visible) must be decided by a stored
    // check (d89 E, ADR-083). A check set stored with one cited item decided by none of its checks leaves it unchecked,
    // though an acceptance line still cites it: I6 names it.
    expect(keys(await directed([], { mutation: "check-set-skips-item" }))).toEqual(SKIPPED_ITEM);
    // The delivered report must list that item as decided by no stored check.
    expect(keys(await directed([], { mutation: "delivered-report-omits-uncovered" }))).toEqual(["I4:delivered-coverage", ...SKIPPED_ITEM]);
    // The stand-ins' internal-design assumption is named as not verified by Ashara; dropped, it is named (ADR-083).
    expect(keys(await directed([], { mutation: "delivered-report-omits-unverified" }))).toEqual(["I4:delivered-coverage"]);
    expect(keys(await directed([], { mutation: "delivered-report-unrecorded" }))).toContain("I4:unrecorded-report");
  }, 120_000);

  // ADR-084 addendum 3 decision 12: the first review finds nothing. The simulator's catalog holds one
  // model family, so the second opinion is asked within it, from what each check cannot observe; its
  // clean answer confirms the claim, and every item the suites' checks decide reads as verified.
  it("verifies the items a clean review covered on a second opinion within the one model family", async () => {
    const clean = await directed([]);
    expect(clean.outcome.kind, statements(clean)).toBe("accepted");
    expect(keys(clean), statements(clean)).toEqual([]);
    expect(clean.log.some((line) => line.includes("Every item the suites cite and no finding left undecided reads as verified"))).toBe(true);
    expect(clean.log.some((line) => line.includes("Not verified, to be reported unverified"))).toBe(false);
  }, 120_000);

  // ADR-084 addendum 2 decision 11: here the second opinion never answers whole (each of its ladder's
  // attempts is invalid output), so every item the suites' checks decide is reported unverified, and
  // the project is still delivered. With the claim's undecided rows dropped, the report calls them
  // decided on the first review alone, as when no second review was asked of a clean one, and I6
  // names each from the stand-ins' answers. The first review is the first call; its ladder's
  // attempts, escalation included, are the next four.
  it("delivers with every item unverified when a clean review's confirmation fails, and catches a report that calls them decided", async () => {
    const directions = [2, 3, 4, 5].map((nth) => draw("model.suite-review.invalid", nth));
    const clean = await directed(directions);
    expect(clean.outcome.kind, statements(clean)).toBe("accepted");
    expect(keys(clean), statements(clean)).toEqual([]);
    expect(clean.log.some((line) => line.includes("the second review failed at every strength, so no finding it was asked for acts and no item reads as verified on it"))).toBe(true);
    expect(clean.log.some((line) => line.includes("Not verified, to be reported unverified (the review that found no problem in them was not confirmed"))).toBe(true);
    const planted = keys(await directed(directions, { mutation: "unconfirmed-claim-dropped" }));
    expect(planted.length).toBeGreaterThan(0);
    expect(planted.every((key) => key.startsWith("I6:unconfirmed-clean:")), planted.join(", ")).toBe(true);
  }, 120_000);

  // ADR-084 addenda 2 and 3 applied to intake, I3's intake clause: the lazy intake persona's reading asks
  // the client nothing. The simulator's catalog holds one model family, so the second reading is
  // another model of it, asked what is ambiguous or assumed; it raises the question the tender leaves
  // open, which is the one the client is sent, and the project is delivered. With the second reading
  // dropped (the reading that asked nothing taken as the tender being unambiguous, recorded as another
  // family's agreement no model gave), I3 names the reading no second reading was asked of.
  const LAZY_INTAKE = [draw("persona.intake.on", 1), draw("persona.intake", 1), draw("persona.intake.fires", "every")];
  it("puts a lazy intake's reading to a second reading whose question the client is sent, and catches an intake that drops it", async () => {
    const clean = await directed(LAZY_INTAKE);
    expect(clean.trace.some((line) => line.includes("intake=lazy")), clean.trace.slice(0, 5).join("\n")).toBe(true);
    expect(clean.outcome.kind, statements(clean)).toBe("accepted");
    expect(keys(clean), statements(clean)).toEqual([]);
    const planted = await directed(LAZY_INTAKE, { mutation: "intake-second-reading-dropped" });
    expect(keys(planted), statements(planted)).toEqual(["I3:lazy-intake"]);
  }, 120_000);

  // A second reading that never answers whole at any strength (every attempt is invalid output) leaves
  // the reading unconfirmed: recorded, told to the client and in the delivered report, never holding
  // the tender, and the project is still delivered.
  it("delivers on an unconfirmed reading when the second reading fails at every strength", async () => {
    const failing = [...LAZY_INTAKE, draw("model.liaison-intake.second.invalid", "every")];
    const result = await directed(failing);
    expect(result.outcome.kind, statements(result)).toBe("accepted");
    expect(keys(result), statements(result)).toEqual([]);
    expect(result.log.some((line) => line.includes("no second reading answered at any strength"))).toBe(true);
  }, 120_000);

  // I9 (text against fact): what a composer states is what the store held when it composed it. Every
  // brief carries the stand-ins' asked assumption with its standing, and the question states it. The
  // delivered report states the standing of an asked-for item no stored check decides, so its plant
  // stores a check set with that item undecided, which I6 names too.
  it("catches a brief, a question and a delivered report that state what their records do not hold", async () => {
    const briefs = keys(await directed([], { mutation: "brief-misstates-standing" }));
    expect(briefs).toContain("I9:brief-assumptions:Define and commit the project environment");
    expect(briefs.every((key) => key.startsWith("I9:brief-assumptions:"))).toBe(true);
    expect(keys(await directed([], { mutation: "delivered-report-misstates-standing" }))).toEqual([...SKIPPED_ITEM, "I9:delivered-standing:A1"]);
    expect(keys(await directed([], { mutation: "question-misstates-assumption" }))).toEqual(["I9:question:A1"]);
  }, 120_000);

  // The delivered report quotes the public interface file main holds, cut when it is too long. The
  // scaffold writes a short one (benign), none (1) or a long one (2); with none, acceptance refuses
  // main, the repair plans the file, and the report quotes it once written.
  it("catches a delivered report whose how-to-run section is not main's public interface file", async () => {
    const scaffold = (form: number): Direction => draw("agent.scaffold.public-interface", "every", form, "scaffold");
    const oversized = await directed([scaffold(2)]);
    expect(oversized.outcome.kind).toBe("accepted");
    expect(keys(oversized)).toEqual([]);
    expect(keys(await directed([], { mutation: "delivered-report-misquotes-interface" }))).toEqual(["I9:delivered-interface"]);
    expect(keys(await directed([scaffold(1)], { mutation: "delivered-report-misquotes-interface" }))).toEqual(["I9:delivered-interface"]);
  }, 180_000);

  // Every implementer leaves the scaffold's public interface file as it was: acceptance refuses main
  // while it is the scaffold's, the repair plans its update, and the project is accepted only once
  // main's file describes the product, so no delivered report quotes the placeholder.
  it("refuses acceptance while main's public interface file is the scaffold's, and accepts it once updated", async () => {
    const stale = await directed([implementation("agent.interface-left-stale", "every")]);
    expect(stale.outcome.kind).toBe("accepted");
    expect(keys(stale)).toEqual([]);
    const sweeps = stale.trace.filter((line) => line.startsWith("acceptance sweep "));
    expect(sweeps[0]).toBe("acceptance sweep ran:failed");
    expect(sweeps.at(-1)).toBe("acceptance sweep ran:passed");
  }, 180_000);

  // W6/W7: a halt's report quotes the cause recorded on its episode. Under a cell outage the project
  // halts on infrastructure and then undeliverable (plan_repair); at the low cap it halts at once.
  it("catches a halt report that states a fixed cause instead of the recorded one", async () => {
    const outage = await directed([], { cellOutage: true, mutation: "halt-report-fixed-cause" });
    expect(keys(outage)).toEqual(["I4:halt-cause:infrastructure", "I4:halt-cause:plan_repair"]);
    const spend = await directed([draw("finance.low-budget", 1)], { mutation: "halt-report-fixed-cause" });
    expect(spend.outcome).toMatchObject({ kind: "halted", cause: "spend_cap" });
    expect(keys(spend)).toEqual(["I4:halt-cause:budget_cap"]);
  }, 120_000);

  // The stop report names exactly the merges recorded: the client stops the project at cycle 5
  // (2 plus the stop-cycle draw), after three tasks merged.
  it("catches a stop report that leaves out a merge on record", async () => {
    const stop = [draw("client.stop", 1), draw("client.stop-cycle", 1, 3)];
    const clean = await directed(stop);
    expect(clean.outcome.kind).toBe("stopped");
    expect(clean.trace).toContain("client stop at cycle 5");
    expect(keys(clean)).toEqual([]);
    expect(keys(await directed(stop, { mutation: "stop-report-omits-merge" }))).toEqual(["I4:stop-merges"]);
  }, 90_000);

  // A plant whose query production never sends planted nothing: the run says so instead of
  // reporting the mutation as not caught. At a cap of $0.02 nothing merges, so no merge record is written.
  it("throws for a plant that rewrote no query", async () => {
    await expect(directed([], { capUsd: 0.02, mutation: "skip-merge-record" })).rejects.toThrow(/plant of mutation skip-merge-record rewrote no query/);
  }, 90_000);

  // I10 (ADR-080 d10 C1): the first cell start fails, before the agent of the environment task ran.
  // Production refunds the dispatch as a substrate fault; planted, the refund gives nothing back,
  // and the attempt stays charged for work no model did.
  it("charges no attempt for a cell that could not start, and names one charged when its refund is skipped", async () => {
    const unstarted = [fault("podman", "run", "cell-start-failed")];
    expect(keys(await directed(unstarted))).toEqual([]);
    const planted = await directed(unstarted, { mutation: "dispatch-refund-skipped" });
    expect(keys(planted), statements(planted)).toEqual(["I10:dispatch:Define and commit the project environment"]);
  }, 90_000);

  // I1:cycle-error: a listing of the projects at work names a table that does not exist, so every
  // cycle throws with no fault beneath it.
  it("names a cycle that throws with no fault injected beneath it", async () => {
    const planted = await directed([], { mutation: "active-listing-throws" });
    expect(keys(planted)).toContain("I1:cycle-error");
    expect(planted.faults).toEqual([]);
  }, 90_000);

  // C9, containment (ADR-080 d10): the second project's rows are corrupted as the run reaches them,
  // its first task_spec (the gate halts it) and then its halt episode's kind (the block report's
  // listing reads it, contained to that report). The first project is accepted all the same; the
  // corrupted episode can never be reported, which I2 names on the second project. With containment
  // undone (a contained fault cannot be kept, so it throws through), every cycle fails for both
  // projects, and the healthy one makes no progress (I8).
  it("keeps one project's corrupted rows from stopping the other, and names the stall when containment is undone", async () => {
    const corrupted = { projects: 2, corruptSecondProject: true } as const;
    const contained = await directed([], corrupted);
    expect(contained.outcome.kind).toBe("accepted");
    expect(contained.trace).toEqual(expect.arrayContaining(["plant: the second project's first task_spec corrupted", "contained block-report"]));
    expect(keys(contained), statements(contained)).toEqual(["I2:p2:episode:planted-unknown-kind"]);
    const uncontained = await directed([], { ...corrupted, mutation: "step-fault-unrecorded" });
    expect(keys(uncontained)).toEqual(expect.arrayContaining(["I1:cycle-error", "I8:Pending"]));
  }, 120_000);

  it("catches a merge recorded under a commit main does not hold", async () => {
    const clean = await directed([]);
    expect(failed(clean)).toEqual([]);
    const planted = await directed([], { mutation: "skip-merge-record" });
    expect(failed(planted)).toContain("I7");
  }, 90_000);
});
