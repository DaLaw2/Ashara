import { describe, expect, test } from "vitest";
import { EvidenceSchema, GuaranteeBasisSchema, VerdictSchema, verdictOf } from "./guarantee-verdict.js";
import type { Evidence, Verdict } from "./guarantee-verdict.js";

const OUTCOMES = ["passed", "failed", "not-run"] as const;
const CLASSES = ["witness", "implementer-visible", "review-only", "none"] as const;
const FAULT_SETS = ["available", "deferred"] as const;

type Check = Evidence["checks"][number];

const SINGLE: readonly Check[] = OUTCOMES.flatMap((outcome) => CLASSES.map((cls, i) => ({ checkId: `c-${outcome}-${i}`, outcome, class: cls })));

/** Every check set of up to two checks over every outcome and class, the empty set first. */
const CHECK_SETS: readonly (readonly Check[])[] = [
  [],
  ...SINGLE.map((c) => [c]),
  ...SINGLE.flatMap((a) => SINGLE.map((b) => [a, { ...b, checkId: `${b.checkId}-b` }])),
];

const GUARANTEES = {
  output: { observation: "output", refutedBy: ["get returns a value never put"] },
  storedData: { observation: "stored-data", refutedBy: ["an acknowledged put is lost after a crash"] },
  legacy: { observation: "unclassified", refutedBy: [] },
  unrefutable: { observation: "errors", refutedBy: [] },
} as const;

interface Case {
  readonly label: string;
  readonly guarantee: (typeof GUARANTEES)[keyof typeof GUARANTEES];
  readonly evidence: Evidence;
  readonly faultSet: (typeof FAULT_SETS)[number];
}

const CASES: readonly Case[] = Object.entries(GUARANTEES).flatMap(([name, guarantee]) =>
  FAULT_SETS.flatMap((faultSet) =>
    [false, true].flatMap((reviewLowers) =>
      CHECK_SETS.map((checks) => ({
        label: `${name} ${faultSet} reviewLowers=${String(reviewLowers)} [${checks.map((c) => `${c.class}:${c.outcome}`).join(", ")}]`,
        guarantee,
        evidence: { checks: [...checks], reviewLowers },
        faultSet,
      })),
    ),
  ),
);

const executedPassed = (e: Evidence): boolean => e.checks.some((c) => (c.class === "witness" || c.class === "implementer-visible") && c.outcome === "passed");
const executedFailed = (e: Evidence): boolean => e.checks.some((c) => (c.class === "witness" || c.class === "implementer-visible") && c.outcome === "failed");

function mismatches(predicate: (c: Case, v: Verdict) => boolean): string[] {
  return CASES.flatMap((c) => {
    const verdict = verdictOf(c.guarantee, c.evidence, c.faultSet);
    return predicate(c, verdict) ? [] : [`${c.label} -> ${JSON.stringify(verdict)}`];
  });
}

describe("verdictOf over every combination of outcomes, classes, reviewLowers and fault sets", () => {
  test("the table covers every case it claims to", () => {
    expect(CHECK_SETS).toHaveLength(1 + 12 + 144);
    expect(CASES).toHaveLength(4 * 2 * 2 * 157);
  });

  test("every verdict parses as a Verdict", () => {
    expect(mismatches((_, v) => VerdictSchema.safeParse(v).success)).toEqual([]);
  });

  test("pass only when some executed check passed and none failed", () => {
    expect(mismatches((c, v) => v.kind !== "pass" || (executedPassed(c.evidence) && !executedFailed(c.evidence)))).toEqual([]);
  });

  test("any executed check that failed is fail, whatever reviews or the guarantee say", () => {
    expect(mismatches((c, v) => !executedFailed(c.evidence) || v.kind === "fail")).toEqual([]);
  });

  test("fail only when an executed check failed: a review never yields fail either", () => {
    expect(mismatches((c, v) => v.kind !== "fail" || executedFailed(c.evidence))).toEqual([]);
  });

  test("a set with no executed evidence, the empty set and review-only sets included, is unjudged", () => {
    const unexecuted = (c: Case) => c.evidence.checks.every((k) => k.class === "review-only" || k.class === "none");
    expect(mismatches((c, v) => !unexecuted(c) || v.kind === "unjudged")).toEqual([]);
  });

  test("a review that lowers a guarantee with passing executed checks makes it unjudged, never pass", () => {
    expect(mismatches((c, v) => !c.evidence.reviewLowers || v.kind !== "pass")).toEqual([]);
  });

  test("a stored-data guarantee is never pass while the fault set is deferred", () => {
    expect(mismatches((c, v) => !(c.guarantee.observation === "stored-data" && c.faultSet === "deferred") || v.kind !== "pass")).toEqual([]);
  });

  test("a guarantee with no refuting observation is never pass", () => {
    expect(mismatches((c, v) => c.guarantee.refutedBy.length > 0 || v.kind !== "pass")).toEqual([]);
  });

  test("a checkable guarantee with passing executed checks, no failure and no lowering review is pass", () => {
    const deserves = (c: Case) =>
      c.guarantee.refutedBy.length > 0 &&
      c.guarantee.observation !== "unclassified" &&
      !(c.guarantee.observation === "stored-data" && c.faultSet === "deferred") &&
      executedPassed(c.evidence) &&
      !executedFailed(c.evidence) &&
      !c.evidence.reviewLowers &&
      !c.evidence.checks.some((k) => k.class === "review-only" && k.outcome === "failed");
    expect(mismatches((c, v) => !deserves(c) || v.kind === "pass")).toEqual([]);
  });
});

describe("verdictOf names why a guarantee is unjudged", () => {
  const output = GUARANTEES.output;
  const passing: Check = { checkId: "c1", outcome: "passed", class: "implementer-visible" };
  const witnessed: Check = { checkId: "c2", outcome: "passed", class: "witness" };
  const reviewClaim: Check = { checkId: "r1", outcome: "passed", class: "review-only" };

  test("an empty evidence set has no executed evidence", () => {
    expect(verdictOf(output, { checks: [], reviewLowers: false }, "available")).toEqual({ kind: "unjudged", reason: "no-executed-evidence" });
  });

  test("a review claim alone, however clean, is review-only", () => {
    expect(verdictOf(output, { checks: [reviewClaim], reviewLowers: false }, "available")).toEqual({ kind: "unjudged", reason: "review-only" });
  });

  test("a stored-data guarantee with passing checks is stored-data-unjudged while deferred, pass once available", () => {
    const evidence = { checks: [passing], reviewLowers: false };
    expect(verdictOf(GUARANTEES.storedData, evidence, "deferred")).toEqual({ kind: "unjudged", reason: "stored-data-unjudged" });
    expect(verdictOf(GUARANTEES.storedData, evidence, "available")).toEqual({ kind: "pass", evidence: "implementer-visible" });
  });

  test("a legacy guarantee is not checkable as written", () => {
    expect(verdictOf(GUARANTEES.legacy, { checks: [passing], reviewLowers: false }, "available")).toEqual({ kind: "unjudged", reason: "not-checkable-as-written" });
  });

  test("a lowering review turns a pass into lowered-by-review", () => {
    expect(verdictOf(output, { checks: [passing], reviewLowers: true }, "available")).toEqual({ kind: "unjudged", reason: "lowered-by-review" });
  });

  test("a pass carries the weakest executed evidence class it rests on", () => {
    expect(verdictOf(output, { checks: [witnessed], reviewLowers: false }, "available")).toEqual({ kind: "pass", evidence: "witness" });
    expect(verdictOf(output, { checks: [witnessed, passing], reviewLowers: false }, "available")).toEqual({ kind: "pass", evidence: "implementer-visible" });
  });
});

describe("the vocabulary's schemas", () => {
  test("an unjudged verdict needs its reason and a pass its evidence class", () => {
    expect(VerdictSchema.safeParse({ kind: "unjudged" }).success).toBe(false);
    expect(VerdictSchema.safeParse({ kind: "pass" }).success).toBe(false);
    expect(VerdictSchema.safeParse({ kind: "pass", evidence: "review-only" }).success).toBe(false);
  });

  test("evidence needs its review flag, and a check its outcome and class", () => {
    expect(EvidenceSchema.safeParse({ checks: [] }).success).toBe(false);
    expect(EvidenceSchema.safeParse({ checks: [{ checkId: "c1", outcome: "passed" }], reviewLowers: false }).success).toBe(false);
  });

  test("the basis is one of the three", () => {
    expect(GuaranteeBasisSchema.options).toEqual(["client-stated", "assumed-unconfirmed", "derived"]);
  });
});
