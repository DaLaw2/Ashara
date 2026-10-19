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
 * What I6 names when a check set of the stand-ins is stored with its last decided item undecided
 * (check-set-skips-item): the guarantee naming no behaviour, the last the scripted intake drafts for
 * the directed tier's two behaviours.
 */
const SKIPPED_ITEM = ["I6:unchecked-item:G3"];

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
  // guarantee decided by none of its checks leaves it unchecked, though an acceptance line still
  // cites it: I6 names it.
  it("catches a check set stored with a cited item no check decides", async (ctx) => {
    expect(keys(await directed(ctx, [], { mutation: "check-set-skips-item" }))).toEqual(SKIPPED_ITEM);
  }, 90_000);

  // The delivered report's table holds every guarantee in force once, each with the verdict its
  // sweep's evidence reads: dropped, or an unjudged one told as passing, it is named.
  it("catches a delivered report whose table leaves out a guarantee", async (ctx) => {
    expect(keys(await directed(ctx, [], { mutation: "delivered-report-drops-guarantee" }))).toEqual(["I4:guarantee-table:delivered"]);
  }, 90_000);

  it("catches a delivered report whose table says an unjudged guarantee passed", async (ctx) => {
    expect(keys(await directed(ctx, [], { mutation: "delivered-report-passes-unjudged" }))).toEqual(["I4:guarantee-table:delivered", ...SKIPPED_ITEM]);
  }, 90_000);

  it("catches a delivered report posted with no record of it", async (ctx) => {
    expect(keys(await directed(ctx, [], { mutation: "delivered-report-unrecorded" }))).toContain("I4:unrecorded-report");
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
  // every item the suites' checks decide is reported unverified, and the project is still delivered.
  // With the claim's undecided rows dropped, no review holds them back on the first review alone,
  // as when no second review was asked of a clean one, and I6 names each from the stand-ins'
  // answers. The first review is the first call; its ladder's attempts, escalation included, are the
  // next four.
  const CONFIRMATION_FAILS = [2, 3, 4, 5].map((nth) => draw("model.suite-review.invalid", nth));
  it("delivers with every item unverified when a clean review's confirmation fails", async (ctx) => {
    const clean = await directed(ctx, CONFIRMATION_FAILS);
    expect(clean.outcome.kind, statements(clean)).toBe("accepted");
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
