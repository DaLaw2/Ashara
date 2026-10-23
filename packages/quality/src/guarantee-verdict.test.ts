import { describe, expect, test } from "vitest";
import { EvidenceSchema, VerdictSchema, coverageOf, judgeGuarantees, verdictOf, verificationOf } from "./guarantee-verdict.js";
import type { Evidence, JudgedGuarantee, Verdict } from "./guarantee-verdict.js";

const OUTCOMES = ["passed", "failed", "not-run"] as const;
const CLASSES = ["witness", "implementer-visible", "review-only", "none"] as const;
const FAULT_SETS = ["available", "deferred"] as const;

type Check = Evidence["checks"][number];

const SINGLE: readonly Check[] = OUTCOMES.flatMap((outcome) =>
  CLASSES.flatMap((cls, i) => [false, true].map((lowered) => ({ checkId: `c-${outcome}-${i}-${String(lowered)}`, outcome, class: cls, lowered }))),
);

/** Every check set of up to two checks over every outcome and class, the empty set first. */
const CHECK_SETS: readonly (readonly Check[])[] = [
  [],
  ...SINGLE.map((c) => [c]),
  ...SINGLE.flatMap((a) => SINGLE.map((b) => [a, { ...b, checkId: `${b.checkId}-b` }])),
];

const GUARANTEES = {
  output: { observation: "output", refutedBy: ["get returns a value never put"], verification: "by-ashara" },
  storedData: { observation: "stored-data", refutedBy: ["an acknowledged put is lost after a crash"], verification: "unmarked" },
  notVerifiable: { observation: "stored-data", refutedBy: ["an acknowledged put is lost after a kill"], verification: "not-by-ashara" },
  legacy: { observation: "unclassified", refutedBy: [], verification: "unmarked" },
  unrefutable: { observation: "errors", refutedBy: [], verification: "by-ashara" },
} as const;

interface Case {
  readonly label: string;
  readonly guarantee: (typeof GUARANTEES)[keyof typeof GUARANTEES];
  readonly evidence: Evidence;
  readonly faultSet: (typeof FAULT_SETS)[number];
}

const CASES: readonly Case[] = Object.entries(GUARANTEES).flatMap(([name, guarantee]) =>
  FAULT_SETS.flatMap((faultSet) =>
    CHECK_SETS.map((checks) => ({
      label: `${name} ${faultSet} [${checks.map((c) => `${c.class}:${c.outcome}${c.lowered ? ":lowered" : ""}`).join(", ")}]`,
      guarantee,
      evidence: { checks: [...checks] },
      faultSet,
    })),
  ),
);

const executedPassed = (e: Evidence): boolean => e.checks.some((c) => (c.class === "witness" || c.class === "implementer-visible") && c.outcome === "passed");
const standingPassed = (e: Evidence): boolean => e.checks.some((c) => (c.class === "witness" || c.class === "implementer-visible") && c.outcome === "passed" && !c.lowered);
const executedFailed = (e: Evidence): boolean => e.checks.some((c) => (c.class === "witness" || c.class === "implementer-visible") && c.outcome === "failed");

function mismatches(predicate: (c: Case, v: Verdict) => boolean): string[] {
  return CASES.flatMap((c) => {
    const verdict = verdictOf(c.guarantee, c.evidence, c.faultSet);
    return predicate(c, verdict) ? [] : [`${c.label} -> ${JSON.stringify(verdict)}`];
  });
}

describe("verdictOf over every combination of outcomes, classes, lowerings and fault sets", () => {
  test("the table covers every case it claims to", () => {
    expect(CHECK_SETS).toHaveLength(1 + 24 + 576);
    expect(CASES).toHaveLength(5 * 2 * 601);
  });

  test("every verdict parses as a Verdict", () => {
    expect(mismatches((_, v) => VerdictSchema.safeParse(v).success)).toEqual([]);
  });

  test("pass only when some executed check passed that no review lowers, and none failed", () => {
    expect(mismatches((c, v) => v.kind !== "pass" || (standingPassed(c.evidence) && !executedFailed(c.evidence)))).toEqual([]);
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

  test("a guarantee every passing executed check of which a review lowers is unjudged, never pass", () => {
    expect(mismatches((c, v) => !executedPassed(c.evidence) || standingPassed(c.evidence) || v.kind !== "pass")).toEqual([]);
  });

  test("a stored-data guarantee is never pass while the fault set is deferred", () => {
    expect(mismatches((c, v) => !(c.guarantee.observation === "stored-data" && c.faultSet === "deferred") || v.kind !== "pass")).toEqual([]);
  });

  test("a guarantee the contract marks not verifiable by Ashara is never pass, and unjudged naming that unless a check failed", () => {
    expect(mismatches((c, v) => c.guarantee.verification !== "not-by-ashara" || v.kind !== "pass")).toEqual([]);
    expect(
      mismatches((c, v) => c.guarantee.verification !== "not-by-ashara" || executedFailed(c.evidence) || (v.kind === "unjudged" && v.reason === "not-verifiable-by-ashara")),
    ).toEqual([]);
  });

  test("a guarantee with no refuting observation is never pass", () => {
    expect(mismatches((c, v) => c.guarantee.refutedBy.length > 0 || v.kind !== "pass")).toEqual([]);
  });

  test("a checkable guarantee with a passing executed check no review lowers, no failure and no failed review reading is pass", () => {
    const deserves = (c: Case) =>
      c.guarantee.refutedBy.length > 0 &&
      c.guarantee.observation !== "unclassified" &&
      c.guarantee.verification !== "not-by-ashara" &&
      !(c.guarantee.observation === "stored-data" && c.faultSet === "deferred") &&
      standingPassed(c.evidence) &&
      !executedFailed(c.evidence) &&
      !c.evidence.checks.some((k) => k.class === "review-only" && k.outcome === "failed");
    expect(mismatches((c, v) => !deserves(c) || v.kind === "pass")).toEqual([]);
  });
});

describe("verdictOf names why a guarantee is unjudged", () => {
  const output = GUARANTEES.output;
  const passing: Check = { checkId: "c1", outcome: "passed", class: "implementer-visible", lowered: false };
  const witnessed: Check = { checkId: "c2", outcome: "passed", class: "witness", lowered: false };
  const reviewClaim: Check = { checkId: "r1", outcome: "passed", class: "review-only", lowered: false };
  const lowered: Check = { checkId: "c3", outcome: "passed", class: "implementer-visible", lowered: true };

  test("an empty evidence set has no executed evidence", () => {
    expect(verdictOf(output, { checks: [] }, "available")).toEqual({ kind: "unjudged", reason: "no-executed-evidence" });
  });

  test("a review claim alone, however clean, is review-only", () => {
    expect(verdictOf(output, { checks: [reviewClaim] }, "available")).toEqual({ kind: "unjudged", reason: "review-only" });
  });

  test("a stored-data guarantee with passing checks is stored-data-unjudged while deferred, pass once available", () => {
    const evidence = { checks: [passing] };
    expect(verdictOf(GUARANTEES.storedData, evidence, "deferred")).toEqual({ kind: "unjudged", reason: "stored-data-unjudged" });
    expect(verdictOf(GUARANTEES.storedData, evidence, "available")).toEqual({ kind: "pass", evidence: "implementer-visible" });
  });

  test("a guarantee marked not verifiable by Ashara is not verified, even with passing checks and every fault set", () => {
    const evidence = { checks: [passing, witnessed] };
    for (const faultSet of FAULT_SETS) expect(verdictOf(GUARANTEES.notVerifiable, evidence, faultSet)).toEqual({ kind: "unjudged", reason: "not-verifiable-by-ashara" });
  });

  test("a legacy guarantee is not checkable as written", () => {
    expect(verdictOf(GUARANTEES.legacy, { checks: [passing] }, "available")).toEqual({ kind: "unjudged", reason: "not-checkable-as-written" });
  });

  test("a finding that lowers every passing executed check turns a pass into lowered-by-review", () => {
    expect(verdictOf(output, { checks: [lowered] }, "available")).toEqual({ kind: "unjudged", reason: "lowered-by-review" });
    expect(verdictOf(output, { checks: [lowered, { ...witnessed, lowered: true }] }, "available")).toEqual({ kind: "unjudged", reason: "lowered-by-review" });
  });

  test("a finding lowers only the check it speaks of: another passing executed check no finding stands against still passes the guarantee", () => {
    expect(verdictOf(output, { checks: [lowered, passing] }, "available")).toEqual({ kind: "pass", evidence: "implementer-visible" });
    expect(verdictOf(output, { checks: [lowered, witnessed] }, "available")).toEqual({ kind: "pass", evidence: "witness" });
  });

  test("with no passing executed check a guarantee stays unjudged, lowered or not", () => {
    const notRun: Check = { checkId: "c4", outcome: "not-run", class: "implementer-visible", lowered: false };
    expect(verdictOf(output, { checks: [notRun] }, "available")).toEqual({ kind: "unjudged", reason: "no-executed-evidence" });
    expect(verdictOf(output, { checks: [{ ...notRun, lowered: true }, reviewClaim] }, "available")).toEqual({ kind: "unjudged", reason: "review-only" });
  });

  test("a lowered check that failed still fails the guarantee", () => {
    expect(verdictOf(output, { checks: [{ ...lowered, outcome: "failed" }, passing] }, "available")).toEqual({ kind: "fail" });
  });

  test("a pass carries the weakest executed evidence class it rests on", () => {
    expect(verdictOf(output, { checks: [witnessed] }, "available")).toEqual({ kind: "pass", evidence: "witness" });
    expect(verdictOf(output, { checks: [witnessed, passing] }, "available")).toEqual({ kind: "pass", evidence: "implementer-visible" });
  });
});

describe("the vocabulary's schemas", () => {
  test("an unjudged verdict needs its reason and a pass its evidence class", () => {
    expect(VerdictSchema.safeParse({ kind: "unjudged" }).success).toBe(false);
    expect(VerdictSchema.safeParse({ kind: "pass" }).success).toBe(false);
    expect(VerdictSchema.safeParse({ kind: "pass", evidence: "review-only" }).success).toBe(false);
  });

  test("a check needs its outcome, class and lowering: a missing lowering is never read as unlowered", () => {
    expect(EvidenceSchema.safeParse({ checks: [] }).success).toBe(true);
    expect(EvidenceSchema.safeParse({ checks: [{ checkId: "c1", outcome: "passed", class: "witness" }] }).success).toBe(false);
    expect(EvidenceSchema.safeParse({ checks: [{ checkId: "c1", outcome: "passed", lowered: false }] }).success).toBe(false);
  });
});

describe("judgeGuarantees: every guarantee of the version once, in its order", () => {
  const MAIN = "d".repeat(40);
  const SWEEP = { id: "sweep-1", mainCommit: MAIN };
  const NONE: Evidence = { checks: [] };
  const passed = (cls: "witness" | "implementer-visible" | "review-only", id = "c1") => ({ checkId: id, outcome: "passed" as const, class: cls, lowered: false });
  const IN_FORCE: readonly JudgedGuarantee[] = [
    { id: "G1", observation: "output", refutedBy: ["a get returns another value"], verification: "by-ashara" },
    { id: "G2", observation: "stored-data", refutedBy: ["a get misses an acknowledged put after a kill"], verification: "unmarked" },
    { id: "G3", observation: "exit-status", refutedBy: ["a get of a missing key exits 0"], verification: "by-ashara" },
    { id: "G4", observation: "output", refutedBy: ["a get after a delete returns the value"], verification: "by-ashara" },
  ];
  const IDS = IN_FORCE.map((g) => g.id);
  const recorded = (byGuarantee: Readonly<Record<string, Evidence>>) => ({ kind: "recorded" as const, byGuarantee: new Map(Object.entries(byGuarantee)) });

  test("each verdict follows the evidence, with the class of evidence it names", () => {
    const verdicts = judgeGuarantees(IN_FORCE, 2, SWEEP, recorded({
      G1: { checks: [passed("implementer-visible")] },
      G2: { checks: [passed("implementer-visible", "c2")] },
      G3: { checks: [{ checkId: "c3", outcome: "failed", class: "implementer-visible", lowered: false }] },
      G4: { checks: [passed("review-only", "r4")] },
    }));
    expect(verdicts).toEqual([
      { guaranteeId: "G1", verdict: { kind: "pass", evidence: "implementer-visible" }, evidenceClass: "implementer-visible" },
      { guaranteeId: "G2", verdict: { kind: "unjudged", reason: "stored-data-unjudged" }, evidenceClass: "implementer-visible" },
      { guaranteeId: "G3", verdict: { kind: "fail" }, evidenceClass: "implementer-visible" },
      { guaranteeId: "G4", verdict: { kind: "unjudged", reason: "review-only" }, evidenceClass: "review-only" },
    ]);
  });

  test("evidence that misses a guarantee of the version, or names one it does not hold, is refused, never read as no evidence", () => {
    const { G4: _dropped, ...missing } = Object.fromEntries(IDS.map((id) => [id, NONE]));
    expect(() => judgeGuarantees(IN_FORCE, 2, SWEEP, recorded(missing))).toThrow(/none for G4/);
    expect(() => judgeGuarantees(IN_FORCE, 2, SWEEP, recorded({ ...Object.fromEntries(IDS.map((id) => [id, NONE])), G9: NONE }))).toThrow(/G9, which vision v2 does not hold/);
  });

  test("no sweep, or a sweep on no commit, judges every guarantee unjudged for want of a sweep on a commit, whatever is recorded", () => {
    const off = [null, { id: "sweep-3", mainCommit: null }];
    for (const sweep of off) {
      expect(judgeGuarantees(IN_FORCE, 2, sweep, { kind: "unrecorded" })).toEqual(
        IDS.map((guaranteeId) => ({ guaranteeId, verdict: { kind: "unjudged", reason: "no-sweep-on-commit" }, evidenceClass: "none" })),
      );
    }
  });

  test("off a commit, a guarantee the contract marks not verifiable by Ashara reads not verifiable, never unjudged for want of a sweep", () => {
    const marked: readonly JudgedGuarantee[] = [
      { id: "G1", observation: "stored-data", refutedBy: ["x"], verification: "not-by-ashara" },
      { id: "G2", observation: "output", refutedBy: ["y"], verification: "by-ashara" },
    ];
    for (const sweep of [null, { id: "sweep-4", mainCommit: null }]) {
      expect(judgeGuarantees(marked, 1, sweep, { kind: "unrecorded" }).map((v) => [v.guaranteeId, v.verdict])).toEqual([
        ["G1", { kind: "unjudged", reason: "not-verifiable-by-ashara" }],
        ["G2", { kind: "unjudged", reason: "no-sweep-on-commit" }],
      ]);
    }
  });

  test("a sweep recorded before evidence per guarantee judges every guarantee on none: a legacy one is not checkable as written", () => {
    const legacy: readonly JudgedGuarantee[] = [
      { id: "S1", observation: "unclassified", refutedBy: [], verification: "unmarked" },
      { id: "G1", observation: "output", refutedBy: ["x"], verification: "unmarked" },
    ];
    expect(judgeGuarantees(legacy, 1, SWEEP, { kind: "unrecorded" }).map((v) => v.verdict)).toEqual([
      { kind: "unjudged", reason: "not-checkable-as-written" },
      { kind: "unjudged", reason: "no-executed-evidence" },
    ]);
  });
});

describe("coverageOf: a sweep covers the contract only when every guarantee in force Ashara can verify is judged pass", () => {
  const pass = (guaranteeId: string) => ({ guaranteeId, verdict: { kind: "pass" as const, evidence: "witness" as const }, evidenceClass: "witness" as const });
  const notVerifiable = (guaranteeId: string) => ({ guaranteeId, verdict: { kind: "unjudged" as const, reason: "not-verifiable-by-ashara" as const }, evidenceClass: "none" as const });

  test("every guarantee passed is covered", () => {
    expect(coverageOf(3, [pass("G1"), pass("G2")])).toEqual({ kind: "covered", notVerifiable: [] });
  });

  test("one guarantee with no executed evidence leaves the contract uncovered, naming it and why", () => {
    const unjudged = { guaranteeId: "G2", verdict: { kind: "unjudged" as const, reason: "no-executed-evidence" as const }, evidenceClass: "none" as const };
    expect(coverageOf(3, [pass("G1"), unjudged])).toEqual({ kind: "unjudged", visionVersion: 3, guarantees: [{ guaranteeId: "G2", verdict: unjudged.verdict }], notVerifiable: [] });
  });

  test("a guarantee the contract marks not verifiable by Ashara lies outside coverage and is named apart, never as passed", () => {
    expect(coverageOf(3, [pass("G1"), notVerifiable("G2")])).toEqual({ kind: "covered", notVerifiable: ["G2"] });
    const stored = { guaranteeId: "G3", verdict: { kind: "unjudged" as const, reason: "stored-data-unjudged" as const }, evidenceClass: "none" as const };
    expect(coverageOf(3, [pass("G1"), notVerifiable("G2"), stored])).toEqual({
      kind: "unjudged",
      visionVersion: 3,
      guarantees: [{ guaranteeId: "G3", verdict: stored.verdict }],
      notVerifiable: ["G2"],
    });
  });

  test("a version holding only guarantees Ashara cannot verify judges nothing, so it is never covered", () => {
    expect(coverageOf(3, [notVerifiable("G1")])).toEqual({ kind: "nothing-to-judge", visionVersion: 3, notVerifiable: ["G1"] });
  });

  test("Ashara cannot verify a stored-data guarantee while the fault set is deferred, and can verify every other observation", () => {
    expect(verificationOf("stored-data")).toBe("not-by-ashara");
    for (const observation of ["output", "errors", "exit-status"] as const) expect(verificationOf(observation)).toBe("by-ashara");
  });

  test("a failed guarantee is never covered", () => {
    expect(coverageOf(3, [{ guaranteeId: "G1", verdict: { kind: "fail" }, evidenceClass: "witness" }]).kind).toBe("unjudged");
  });

  test("no contract, or a version holding no guarantee, judges nothing and is never read as covered", () => {
    expect(coverageOf(null, [])).toEqual({ kind: "nothing-to-judge", visionVersion: null, notVerifiable: [] });
    expect(coverageOf(4, [])).toEqual({ kind: "nothing-to-judge", visionVersion: 4, notVerifiable: [] });
  });
});
