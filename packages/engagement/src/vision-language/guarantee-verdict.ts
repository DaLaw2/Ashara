import { z } from "zod";
import type { GuaranteeBasis, VisionGuarantee } from "./guarantee.js";

// The verdict a delivery earns on one guarantee, kept apart from how well the guarantee's footing is
// known (its basis) and from what kind of evidence was seen. The verdict speaks the hidden suite's
// vocabulary, so the two can be laid side by side guarantee by guarantee.

const BASIS: { readonly [B in GuaranteeBasis]: B } = {
  "client-stated": "client-stated",
  "assumed-unconfirmed": "assumed-unconfirmed",
  derived: "derived",
};

/**
 * A guarantee's basis as a report or a stored verdict row carries it; it never changes the verdict.
 * @testseam guarantee-verdict.test.ts judges every evidence combination through it; no production caller reads it yet
 */
export const GuaranteeBasisSchema = z.enum(BASIS);

/**
 * What a piece of evidence about a guarantee is: a check written after the work by someone other than
 * its implementer ("witness"), a check the implementer saw before working ("implementer-visible"), a
 * review's reading of checks as text ("review-only"), or nothing at all ("none"). Only the first two
 * are executed evidence.
 */
const EvidenceClassSchema = z.enum(["witness", "implementer-visible", "review-only", "none"]);

export type EvidenceClass = z.infer<typeof EvidenceClassSchema>;

type ExecutedClass = Extract<EvidenceClass, "witness" | "implementer-visible">;

export const CheckEvidenceSchema = z.strictObject({
  checkId: z.string().min(1),
  outcome: z.enum(["passed", "failed", "not-run"]),
  class: EvidenceClassSchema,
});

type CheckEvidence = z.infer<typeof CheckEvidenceSchema>;

/**
 * Everything seen about one guarantee on one commit. An empty check list is a recorded absence of
 * evidence, and it reads unjudged, never pass. `reviewLowers` is set when a review finding or an
 * undecided item names the guarantee.
 * @testseam guarantee-verdict.test.ts judges every evidence combination through it; production builds Evidence from stored rows instead
 */
export const EvidenceSchema = z.strictObject({
  checks: z.array(CheckEvidenceSchema),
  reviewLowers: z.boolean(),
});

export type Evidence = z.infer<typeof EvidenceSchema>;

const UnjudgedReasonSchema = z.enum([
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
export type FaultSet = "available" | "deferred";

function isExecuted(check: CheckEvidence): check is CheckEvidence & { readonly class: ExecutedClass } {
  return check.class === "witness" || check.class === "implementer-visible";
}

/**
 * The verdict on one guarantee from the evidence seen on the commit, by the first rule that applies:
 * an executed check failed; the guarantee names nothing that would refute it; its stored data cannot
 * be exercised; no executed check passed; a review lowers it; otherwise pass. Reviews are read only by
 * the two rules that end unjudged, so no review evidence ever yields pass.
 */
export function verdictOf(
  guarantee: Pick<VisionGuarantee, "observation" | "refutedBy">,
  evidence: Evidence,
  faultSet: FaultSet,
): Verdict {
  const executed = evidence.checks.filter(isExecuted);
  if (executed.some((c) => c.outcome === "failed")) return { kind: "fail" };
  if (guarantee.observation === "unclassified" || guarantee.refutedBy.length === 0) {
    return { kind: "unjudged", reason: "not-checkable-as-written" };
  }
  if (guarantee.observation === "stored-data" && faultSet === "deferred") return { kind: "unjudged", reason: "stored-data-unjudged" };
  const passed = executed.filter((c) => c.outcome === "passed");
  const reviews = evidence.checks.filter((c) => c.class === "review-only");
  if (passed.length === 0) return { kind: "unjudged", reason: reviews.length > 0 ? "review-only" : "no-executed-evidence" };
  if (evidence.reviewLowers || reviews.some((c) => c.outcome === "failed")) return { kind: "unjudged", reason: "lowered-by-review" };
  return { kind: "pass", evidence: passed.every((c) => c.class === "witness") ? "witness" : "implementer-visible" };
}
