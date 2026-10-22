import { describe, expect, it } from "vitest";
import { directed, draw, keys, statements, useSimulatorDatabase } from "./simulator-harness.js";

/*
 * The directed tier's plants (simulator-harness.ts directed) on acceptance, the delivered report
 * and the review's confirmation: each mutation an invariant must catch, most beside the clean run
 * of the same tape, which passes.
 * Each test makes one directed run, or two where one judgment needs both, so a test's time is a
 * run's and fits its timeout under the whole suite's load. The directed tier's plants are split
 * across the simulator-plants*.test.ts files so vitest runs them on separate workers.
 */
useSimulatorDatabase();

/**
 * The guarantee a check set of the stand-ins leaves undecided when stored with its last decided item
 * undecided (check-set-skips-item): the one naming no behaviour, the last the scripted intake drafts
 * for the directed tier's two behaviours.
 */
const SKIPPED_ITEM = "G3";

/**
 * The cause a project halts on when its sweep passed and Quality's coverage refuses its acceptance:
 * a guarantee in force is not judged pass.
 */
const UNCOVERED = "acceptance_uncovered: AcceptanceSweepUncovered:";

/** The outcome's detail when the run halted, or what the run ended in instead. */
function haltDetail(result: Awaited<ReturnType<typeof directed>>): string {
  return result.outcome.kind === "halted" ? result.outcome.detail : `the run ended ${result.outcome.kind}`;
}

describe("lifecycle simulator, directed", () => {
  // With no adversary the stand-ins drive the project to Accepted on one passed sweep of main;
  // the delivered report is judged against the goal tasks' merge records and the task and check
  // records, so a report that drops a goal's close, misstates what no stored check covers, leaves out
  // an asked-for item no acceptance line cites, or is posted with no record of it (and so posted
  // again) is named.
  it("accepts a project on a passed sweep", async (ctx) => {
    const clean = await directed(ctx, []);
    expect(clean.outcome.kind).toBe("accepted");
    expect(keys(clean)).toEqual([]);
    expect([...clean.coverage.projectStatuses]).toContain("accepted");
    expect([...clean.coverage.sweeps]).toEqual(["ran:passed"]);
  }, 90_000);

  it("catches a delivered report that drops a goal's close", async (ctx) => {
    expect(keys(await directed(ctx, [], { mutation: "delivered-report-omits-goal" }))).toEqual(["I4:delivered-close"]);
  }, 90_000);

  it("catches a delivered report that misstates what no stored check covers", async (ctx) => {
    expect(keys(await directed(ctx, [], { mutation: "delivered-report-misstates-unchecked" }))).toEqual(["I4:delivered-unchecked"]);
  }, 90_000);

  // Every guarantee of the version in force must be decided by a stored check; the asked assumption
  // underpins a guarantee and is never held to a check of its own. A check set stored with one cited
  // guarantee decided by none of its checks leaves it unjudged on no executed evidence, so the passed
  // sweep does not cover the contract: Quality refuses the acceptance and the project halts with that
  // guarantee named, and no invariant finds it accepted.
  it("catches a check set stored with a cited item no check decides", async (ctx) => {
    const planted = await directed(ctx, [], { mutation: "check-set-skips-item" });
    expect(keys(planted), statements(planted)).toEqual([]);
    expect(planted.outcome.kind).toBe("halted");
    expect(haltDetail(planted)).toContain(UNCOVERED);
    expect(haltDetail(planted)).toContain(`${SKIPPED_ITEM} (unjudged, no-executed-evidence)`);
    expect([...planted.coverage.projectStatuses]).not.toContain("accepted");
  }, 90_000);

  // The delivered report's table holds every guarantee in force once, each with the verdict its
  // sweep's evidence reads: dropped, it is named. A project is accepted only with every guarantee
  // judged pass, so an unjudged one is told only in a report short of acceptance: the halt's, where
  // one told as passing is named.
  it("catches a delivered report whose table leaves out a guarantee", async (ctx) => {
    expect(keys(await directed(ctx, [], { mutation: "delivered-report-drops-guarantee" }))).toEqual(["I4:guarantee-table:delivered"]);
  }, 90_000);

  it("catches a halt report whose table says an unjudged guarantee passed", async (ctx) => {
    const planted = await directed(ctx, [], { mutation: "halt-report-passes-unjudged" });
    expect(haltDetail(planted)).toContain(UNCOVERED);
    expect(keys(planted)).toEqual(["I4:guarantee-table:halt:acceptance_uncovered"]);
  }, 90_000);

  // Its sweep never records it, so the acceptance reads as untold too (I4's silence clause).
  it("catches a delivered report posted with no record of it", async (ctx) => {
    const planted = keys(await directed(ctx, [], { mutation: "delivered-report-unrecorded" }));
    expect(planted).toContain("I4:unrecorded-report");
    expect(planted).toContain("I4:accepted-unreported");
  }, 90_000);

  // The first review finds nothing. The simulator's catalog holds one model family, so the second
  // opinion is asked within it, from what each check cannot observe; its clean answer confirms the
  // claim, and every item the suites' checks decide reads as verified.
  it("verifies the items a clean review covered on a second opinion within the one model family", async (ctx) => {
    const clean = await directed(ctx, []);
    expect(clean.outcome.kind, statements(clean)).toBe("accepted");
    expect(keys(clean), statements(clean)).toEqual([]);
    const reviewed = clean.records.filter((r) => r.event === "quality.suites-reviewed");
    expect(reviewed.some((r) => r.fields?.["claim"] === "verified")).toBe(true);
    expect(reviewed.some((r) => r.fields?.["claim"] === "unverified")).toBe(false);
  }, 90_000);

  // Here the second opinion never answers whole (each of its ladder's attempts is invalid output), so
  // every item the suites' checks decide is reported unverified: the review lowers each guarantee to
  // unjudged, so the passed sweep does not cover the contract and the project halts short of
  // acceptance with each named. With the claim's undecided rows dropped, no review holds them back on
  // the first review alone, as when no second review was asked of a clean one, and I6 names each from
  // the stand-ins' answers. The first review is the first call; its ladder's attempts, escalation
  // included, are the next four.
  const CONFIRMATION_FAILS = [2, 3, 4, 5].map((nth) => draw("model.suite-review.invalid", nth));
  it("halts short of acceptance with every item unverified when a clean review's confirmation fails", async (ctx) => {
    const clean = await directed(ctx, CONFIRMATION_FAILS);
    expect(clean.outcome.kind, statements(clean)).toBe("halted");
    expect(haltDetail(clean)).toContain(UNCOVERED);
    for (const guarantee of ["G1", "G2", "G3"]) expect(haltDetail(clean)).toContain(`${guarantee} (unjudged, lowered-by-review)`);
    expect(keys(clean), statements(clean)).toEqual([]);
    expect(clean.records.some((r) => r.event === "quality.second-review-failed" && r.level === "warn")).toBe(true);
    expect(
      clean.records.some(
        (r) => r.event === "quality.suites-reviewed" && r.fields?.["claim"] === "unverified" && `${r.fields["claimWhy"] ?? ""}`.includes("the review that found no problem in them was not confirmed"),
      ),
    ).toBe(true);
  }, 90_000);

  it("catches a report that calls decided the items an unconfirmed clean review covered", async (ctx) => {
    const planted = keys(await directed(ctx, CONFIRMATION_FAILS, { mutation: "unconfirmed-claim-dropped" }));
    expect(planted.length).toBeGreaterThan(0);
    expect(planted.every((key) => key.startsWith("I6:unconfirmed-clean:")), planted.join(", ")).toBe(true);
  }, 90_000);
});
