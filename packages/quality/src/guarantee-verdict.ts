import { z } from "zod";
import type { Observation, VisionGuarantee } from "./acl/engagement-acl.js";

// The verdict a delivery earns on one guarantee, kept apart from how well the guarantee's footing is
// known (its basis) and from what kind of evidence was seen. The verdict speaks the hidden suite's
// vocabulary, so the two can be laid side by side guarantee by guarantee. Quality alone judges it:
// every terminal message's table and the project's acceptance read the verdicts judged here. This
// module imports nothing of Quality at run time, so the published verdict read can load it without a
// cycle.

/**
 * What a piece of evidence about a guarantee is: a check written after the work by someone other than
 * its implementer ("witness"), a check the implementer saw before working ("implementer-visible"), a
 * review's reading of checks as text ("review-only"), or nothing at all ("none"). Only the first two
 * are executed evidence.
 */
const EvidenceClassSchema = z.enum(["witness", "implementer-visible", "review-only", "none"]);

export type EvidenceClass = z.infer<typeof EvidenceClassSchema>;

type ExecutedClass = Extract<EvidenceClass, "witness" | "implementer-visible">;

/**
 * One check's evidence on a guarantee. `lowered` is set when a suite review's finding still stands
 * that this check, as its own check task wrote it, may not decide the guarantee: the finding speaks
 * of that check task's checks alone, never of another's.
 */
export const CheckEvidenceSchema = z.strictObject({
  checkId: z.string().min(1),
  outcome: z.enum(["passed", "failed", "not-run"]),
  class: EvidenceClassSchema,
  lowered: z.boolean(),
});

type CheckEvidence = z.infer<typeof CheckEvidenceSchema>;

/**
 * Everything seen about one guarantee on one commit. An empty check list is a recorded absence of
 * evidence, and it reads unjudged, never pass.
 * @testseam guarantee-verdict.test.ts judges every evidence combination through it; production builds Evidence from stored rows instead
 */
export const EvidenceSchema = z.strictObject({
  checks: z.array(CheckEvidenceSchema),
});

export type Evidence = z.infer<typeof EvidenceSchema>;

const UnjudgedReasonSchema = z.enum([
  "not-verifiable-by-ashara",
  "no-executed-evidence",
  "review-only",
  "stored-data-unjudged",
  "not-checkable-as-written",
  "lowered-by-review",
  "out-of-scope-of-run",
  "no-sweep-on-commit",
]);

/**
 * One verdict per guarantee. A pass names the weakest executed evidence class it rests on; an
 * unjudged verdict names why it could not be judged.
 * @testseam guarantee-verdict.test.ts judges every evidence combination through it; production types verdicts with Verdict
 */
export const VerdictSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("pass"), evidence: z.enum(["witness", "implementer-visible"]) }),
  z.strictObject({ kind: z.literal("fail") }),
  z.strictObject({ kind: z.literal("unjudged"), reason: UnjudgedReasonSchema }),
]);

export type UnjudgedReason = z.infer<typeof UnjudgedReasonSchema>;

export type Verdict = z.infer<typeof VerdictSchema>;

/**
 * Whether the fault set that exercises stored data is available to the checks. While it is deferred, a
 * passing check cannot show that stored data survives a fault, so a stored-data guarantee stays unjudged.
 */
type FaultSet = "available" | "deferred";

/** The fault set every verdict is judged under: deferred, since no check of a stored-data guarantee can show stored data surviving a fault. */
const FAULT_SET: FaultSet = "deferred";

/**
 * Whether Ashara can judge a guarantee observed at `observation` with the checks it runs today: one
 * about stored data cannot be while the fault set that exercises stored data is deferred. Engagement
 * records it in the contract when the guarantee is proposed, so the client is told before work starts.
 */
export function verificationOf(observation: Observation): Exclude<VisionGuarantee["verification"], "unmarked"> {
  return observation === "stored-data" && FAULT_SET === "deferred" ? "not-by-ashara" : "by-ashara";
}

/**
 * What a guarantee's verdict reads of it: its key, where it is observed, what would refute it and
 * whether the contract marks it not verifiable by Ashara.
 */
export type JudgedGuarantee = Pick<VisionGuarantee, "id" | "observation" | "refutedBy" | "verification">;

function isExecuted(check: CheckEvidence): check is CheckEvidence & { readonly class: ExecutedClass } {
  return check.class === "witness" || check.class === "implementer-visible";
}

/**
 * The verdict on one guarantee from the evidence seen on the commit, by the first rule that applies:
 * an executed check failed; the contract marks it not verifiable by Ashara; the guarantee names
 * nothing that would refute it; its stored data cannot be exercised; no executed check passed; a
 * review lowers every executed check that passed, or a review-only reading failed; otherwise pass,
 * resting on the passing checks no finding stands against. A finding lowers only the checks it
 * speaks of, so another passing check it does not speak of still decides the guarantee. Reviews are
 * read only by the rules that end unjudged, so no review evidence ever yields pass, and a guarantee
 * marked not verifiable never passes either.
 * @testseam guarantee-verdict.test.ts judges every evidence combination and fault set through it; production judges through judgeGuarantees
 */
export function verdictOf(guarantee: Pick<JudgedGuarantee, "observation" | "refutedBy" | "verification">, evidence: Evidence, faultSet: FaultSet): Verdict {
  const executed = evidence.checks.filter(isExecuted);
  if (executed.some((c) => c.outcome === "failed")) return { kind: "fail" };
  if (guarantee.verification === "not-by-ashara") return { kind: "unjudged", reason: "not-verifiable-by-ashara" };
  if (guarantee.observation === "unclassified" || guarantee.refutedBy.length === 0) {
    return { kind: "unjudged", reason: "not-checkable-as-written" };
  }
  if (guarantee.observation === "stored-data" && faultSet === "deferred") return { kind: "unjudged", reason: "stored-data-unjudged" };
  const passed = executed.filter((c) => c.outcome === "passed");
  const reviews = evidence.checks.filter((c) => c.class === "review-only");
  if (passed.length === 0) return { kind: "unjudged", reason: reviews.length > 0 ? "review-only" : "no-executed-evidence" };
  const standing = passed.filter((c) => !c.lowered);
  if (standing.length === 0 || reviews.some((c) => c.outcome === "failed")) return { kind: "unjudged", reason: "lowered-by-review" };
  return { kind: "pass", evidence: standing.every((c) => c.class === "witness") ? "witness" : "implementer-visible" };
}

/**
 * Quality's published verdict on one guarantee: the verdict, and the strongest class of evidence seen
 * for it (a pass names the weakest it rests on instead). Engagement renders it and never judges one.
 */
export interface GuaranteeVerdict {
  readonly guaranteeId: string;
  readonly verdict: Verdict;
  readonly evidenceClass: EvidenceClass;
}

/**
 * Each guarantee's evidence on a sweep, by guarantee id: recorded, or not on record at all (a sweep
 * recorded before evidence per guarantee was), which judges every guarantee on no evidence.
 */
export type SweepEvidence = { readonly kind: "recorded"; readonly byGuarantee: ReadonlyMap<string, Evidence> } | { readonly kind: "unrecorded" };

/** The sweep a set of verdicts is judged on: its id, and the commit of main it ran on, null when it ran on none. */
export interface JudgedSweep {
  readonly id: string;
  readonly mainCommit: string | null;
}

/** A sweep's evidence names a guarantee the vision version it was recorded against does not hold, or misses one it holds. */
export class GuaranteeEvidenceMismatch extends Error {
  constructor(
    readonly sweepId: string,
    readonly visionVersion: number,
    readonly guaranteeId: string,
    readonly detail: "missing" | "unmatched",
  ) {
    super(
      detail === "missing"
        ? `sweep ${sweepId} records evidence for some guarantees of vision v${visionVersion} but none for ${guaranteeId}: its verdicts cannot be judged`
        : `sweep ${sweepId} records evidence for ${guaranteeId}, which vision v${visionVersion} does not hold: its verdicts cannot be judged`,
    );
    this.name = "GuaranteeEvidenceMismatch";
  }
}

const NO_EVIDENCE: Evidence = { checks: [] };

const CLASS_RANK: readonly EvidenceClass[] = ["witness", "implementer-visible", "review-only"];

/** The strongest class among the checks seen for a guarantee: an executed one only when it ran. */
function strongestClass(evidence: Evidence): EvidenceClass {
  const seen = evidence.checks.filter((check) => check.class === "review-only" || check.outcome !== "not-run").map((check) => check.class);
  return CLASS_RANK.find((cls) => seen.includes(cls)) ?? "none";
}

function judged(guarantee: JudgedGuarantee, evidence: Evidence, onCommit: boolean): GuaranteeVerdict {
  if (!onCommit) return { guaranteeId: guarantee.id, verdict: { kind: "unjudged", reason: "no-sweep-on-commit" }, evidenceClass: "none" };
  const verdict = verdictOf(guarantee, evidence, FAULT_SET);
  return { guaranteeId: guarantee.id, verdict, evidenceClass: verdict.kind === "pass" ? verdict.evidence : strongestClass(evidence) };
}

/**
 * The verdict on every guarantee of the version `visionVersion` holds, each exactly once and in its
 * order, from the sweep's evidence. No sweep, or one that ran on no commit, judges nothing: every
 * guarantee reads unjudged for want of a sweep on a commit. Evidence that misses a guarantee or names
 * one the version does not hold is a record that does not hold together: it throws, never reads as no
 * evidence.
 */
export function judgeGuarantees(
  guarantees: readonly JudgedGuarantee[],
  visionVersion: number,
  sweep: JudgedSweep | null,
  evidence: SweepEvidence,
): GuaranteeVerdict[] {
  const onCommit = sweep !== null && sweep.mainCommit !== null;
  if (sweep === null || evidence.kind === "unrecorded") return guarantees.map((guarantee) => judged(guarantee, NO_EVIDENCE, onCommit));
  const ids = new Set(guarantees.map((guarantee) => guarantee.id));
  for (const id of evidence.byGuarantee.keys()) {
    if (!ids.has(id)) throw new GuaranteeEvidenceMismatch(sweep.id, visionVersion, id, "unmatched");
  }
  return guarantees.map((guarantee) => {
    const seen = evidence.byGuarantee.get(guarantee.id);
    if (seen === undefined) throw new GuaranteeEvidenceMismatch(sweep.id, visionVersion, guarantee.id, "missing");
    return judged(guarantee, seen, onCommit);
  });
}

/** A guarantee in force whose verdict on the sweep is anything but a pass, with that verdict. */
interface UnjudgedGuarantee {
  readonly guaranteeId: string;
  readonly verdict: Exclude<Verdict, { readonly kind: "pass" }>;
}

/** A verdict outside coverage: the one a guarantee the contract marks not verifiable by Ashara reads. */
function outsideCoverage(verdict: Verdict): boolean {
  return verdict.kind === "unjudged" && verdict.reason === "not-verifiable-by-ashara";
}

/**
 * Whether a passed sweep covers the contract in force: every guarantee of it that Ashara can verify
 * judged pass. A guarantee the contract marks not verifiable by Ashara is outside coverage and named
 * apart (`notVerifiable`). A project with no contract on record, or a version holding no guarantee
 * Ashara can verify, is not covered: an empty set of guarantees judges nothing, so it is never read
 * as every guarantee judged.
 */
export type Coverage =
  | { readonly kind: "covered"; readonly notVerifiable: readonly string[] }
  | { readonly kind: "nothing-to-judge"; readonly visionVersion: number | null; readonly notVerifiable: readonly string[] }
  | { readonly kind: "unjudged"; readonly visionVersion: number; readonly guarantees: readonly UnjudgedGuarantee[]; readonly notVerifiable: readonly string[] };

/** The coverage of the verdicts judged on the version `visionVersion`; a null `visionVersion` is no contract on record. */
export function coverageOf(visionVersion: number | null, verdicts: readonly GuaranteeVerdict[]): Coverage {
  const notVerifiable = verdicts.filter((each) => outsideCoverage(each.verdict)).map((each) => each.guaranteeId);
  const inCoverage = verdicts.filter((each) => !outsideCoverage(each.verdict));
  if (visionVersion === null || inCoverage.length === 0) return { kind: "nothing-to-judge", visionVersion, notVerifiable };
  const unjudged = inCoverage.flatMap((each) => (each.verdict.kind === "pass" ? [] : [{ guaranteeId: each.guaranteeId, verdict: each.verdict }]));
  return unjudged.length === 0 ? { kind: "covered", notVerifiable } : { kind: "unjudged", visionVersion, guarantees: unjudged, notVerifiable };
}
