import { describe, expect, test } from "vitest";
import { SuiteReviewStrengthUnreadable, storedClaimOf } from "./suite-review.js";

const ROW = {
  reviewTaskId: "r1",
  basis: "second-opinion-clean",
  covered: ["c1"],
  firstModel: "a/m",
  secondModel: "b/n",
  secondStrength: "other-family",
  passedOver: [],
  secondFindings: [],
  secondFailure: null,
  unverified: [],
  judgeTier: "Frontier",
  judgedTier: "Strong",
  tierRelation: "above",
  firstTier: "Frontier",
  secondTier: "Frontier",
};

describe("storedClaimOf", () => {
  test("reads a confirmed claim's second opinion with its strength", () => {
    expect(storedClaimOf("k1", ROW).second).toEqual({ kind: "answered", model: "b/n", strength: "other-family", findings: [] });
  });

  test("reads how its judges stood to the work: recorded whole, or unrecorded on a claim written before tiers were", () => {
    expect(storedClaimOf("k1", ROW).tiers).toEqual({ kind: "recorded", judge: "Frontier", judged: "Strong", relation: "above", reviews: { kind: "graded", first: "Frontier", second: "Frontier" } });
    expect(storedClaimOf("k1", { ...ROW, judgeTier: null, judgedTier: null, tierRelation: null, firstTier: null, secondTier: null }).tiers).toEqual({ kind: "unrecorded" });
  });

  test("reads each review's grade: the second opinion's at the work's tier under a stronger first, or ungraded on a claim written before they were", () => {
    const equal = { ...ROW, judgeTier: "Strong", tierRelation: "equal" };
    expect(storedClaimOf("k1", { ...equal, secondTier: "Strong" }).tiers).toEqual({
      kind: "recorded",
      judge: "Strong",
      judged: "Strong",
      relation: "equal",
      reviews: { kind: "graded", first: "Frontier", second: "Strong" },
    });
    expect(storedClaimOf("k1", { ...equal, firstTier: null, secondTier: null }).tiers).toEqual({ kind: "recorded", judge: "Strong", judged: "Strong", relation: "equal", reviews: { kind: "ungraded" } });
  });

  test("review grades that do not fit the judge tier or the second review are corrupt, never read as a review's grade", () => {
    expect(() => storedClaimOf("k6", { ...ROW, secondTier: "Strong" })).toThrow(/suite_review_claims row k6: .*the weaker being the judge tier/);
    expect(() => storedClaimOf("k7", { ...ROW, secondTier: null })).toThrow(/suite_review_claims row k7/);
    expect(() => storedClaimOf("k8", { ...ROW, firstTier: null })).toThrow(/suite_review_claims row k8/);
    expect(() => storedClaimOf("k9", { ...ROW, judgeTier: null, judgedTier: null, tierRelation: null })).toThrow(/suite_review_claims row k9/);
  });

  test("a claim that records only some of its tiers, or a tier the vocabulary does not name, is corrupt, never read as judged from above", () => {
    expect(() => storedClaimOf("k4", { ...ROW, judgedTier: null })).toThrow(/suite_review_claims row k4: .*together, or none of them/);
    expect(() => storedClaimOf("k5", { ...ROW, judgeTier: "Ultra" })).toThrow(/suite_review_claims row k5/);
  });

  test("a second_strength that is no strength of second opinion throws SuiteReviewStrengthUnreadable, never reads as verified", () => {
    const read = () => storedClaimOf("k1", { ...ROW, secondStrength: "another-planet" });
    expect(read).toThrow(SuiteReviewStrengthUnreadable);
    expect(read).toThrow(/^suite_review_claims row k1: second_strength is not a strength of second opinion/);
  });

  test("a confirmed claim that records no strength throws SuiteReviewStrengthUnreadable", () => {
    const read = () => storedClaimOf("k1", { ...ROW, basis: "second-opinion-found", secondStrength: null });
    expect(read).toThrow(SuiteReviewStrengthUnreadable);
    expect(read).toThrow(/^suite_review_claims row k1: second_strength is not a strength of second opinion: the claim is second-opinion-found but records no strength/);
  });

  test("a failed claim reads as failed with why, its unverified items kept", () => {
    const claim = storedClaimOf("k2", {
      ...ROW,
      basis: "second-review-failed",
      secondModel: null,
      secondStrength: null,
      secondTier: null,
      secondFailure: "SecondOpinionUnanswered: no answer",
      unverified: [{ checkTaskId: "c1", itemId: "S1", itemText: "x" }],
    });
    expect(claim.second).toEqual({ kind: "failed", reason: "SecondOpinionUnanswered: no answer" });
    expect(claim.unverified).toHaveLength(1);
  });

  test("a claim whose second review both answered and failed is corrupt, not read either way", () => {
    expect(() => storedClaimOf("k3", { ...ROW, secondFailure: "x" })).toThrow(/suite_review_claims row k3/);
  });
});
