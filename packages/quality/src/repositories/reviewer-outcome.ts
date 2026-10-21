import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { checkDisputes, reviewerOutcomes, suiteReviewJudgements } from "@ashara/db/schema/quality";
import type { DbHandle } from "@ashara/db";
import { siteCostOf } from "@ashara/finance";

// Quality's reviewer record: each reviewer's verdict set against what later evidence showed of it.
// A suite review claim is a pass on the check tasks it covers; a witness against one of those check
// tasks contradicts the pass of every reviewer whose answer the claim rests on, and witnesses the
// second opinion's finding where that finding named the check task. A routed rejection names a
// check; the check task's re-authored revision changing that check witnesses it, keeping it
// unchanged refutes it. Writers run inside the transaction that records the evidence, so evidence
// and outcome land together or not at all.

type VerdictKind = "claim" | "judgement" | "intake-reading";
type ReviewerRole = "first" | "second";
type Outcome = "pass-contradicted" | "finding-witnessed" | "finding-refuted";
type EvidenceKind = "dispute-upheld" | "acceptance-failed" | "check-reauthored";

interface OutcomeRow {
  readonly verdictKind: VerdictKind;
  readonly verdictId: string;
  readonly reviewerModel: string;
  readonly reviewerRole: ReviewerRole;
  readonly outcome: Outcome;
}

/** The check task ids each second-opinion finding names; the rest of a stored finding is the suite review's to read. */
const SecondFindingsSchema = z.array(z.looseObject({ checkTasks: z.array(z.string().min(1)).min(1) }));

const CoveringClaimSchema = z.strictObject({
  id: z.string().min(1),
  firstModel: z.string().min(1),
  secondModel: z.string().min(1).nullable(),
  secondFindings: z.unknown(),
});

type CoveringClaim = z.infer<typeof CoveringClaimSchema>;

/** A stored claim's second findings do not parse: which of its reviewers a witness contradicts cannot be read. */
class ClaimFindingsUnreadable extends Error {
  constructor(
    readonly claimId: string,
    readonly issues: string,
  ) {
    super(`suite_review_claims row ${claimId}: second_findings cannot be read for its reviewer record: ${issues}`);
    this.name = "ClaimFindingsUnreadable";
  }
}

/** The claims of the project covering `checkTaskId`, oldest first: those written by the time of the dispute `byDispute` when one is named. */
async function claimsCovering(tx: DbHandle, projectId: string, checkTaskId: string, byDispute: string | null): Promise<CoveringClaim[]> {
  const result = await tx.execute(sql`
    SELECT c.id, c.first_model AS "firstModel", c.second_model AS "secondModel", c.second_findings AS "secondFindings"
    FROM suite_review_claims c
    WHERE c.project_id = ${projectId}
      AND c.covered @> jsonb_build_array(${checkTaskId}::text)
      ${byDispute === null ? sql`` : sql`AND c.created_at <= (SELECT d.created_at FROM check_disputes d WHERE d.id = ${byDispute})`}
    ORDER BY c.created_at, c.id`);
  return z.array(CoveringClaimSchema).parse(result.rows);
}

/**
 * What a witness against `checkTasks` says of each reviewer of `claim`: the first review passed
 * them; the second opinion, where one answered, passed them too unless a finding of it named one.
 */
function claimOutcomes(claim: CoveringClaim, checkTasks: ReadonlySet<string>): OutcomeRow[] {
  const first: OutcomeRow = { verdictKind: "claim", verdictId: claim.id, reviewerModel: claim.firstModel, reviewerRole: "first", outcome: "pass-contradicted" };
  if (claim.secondModel === null) return [first];
  const findings = SecondFindingsSchema.safeParse(claim.secondFindings);
  if (!findings.success) throw new ClaimFindingsUnreadable(claim.id, z.prettifyError(findings.error));
  const named = findings.data.some((finding) => finding.checkTasks.some((id) => checkTasks.has(id)));
  return [first, { verdictKind: "claim", verdictId: claim.id, reviewerModel: claim.secondModel, reviewerRole: "second", outcome: named ? "finding-witnessed" : "pass-contradicted" }];
}

async function insertOutcomes(tx: DbHandle, projectId: string, evidenceKind: EvidenceKind, evidenceRef: string, rows: readonly OutcomeRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const inserted = await tx
    .insert(reviewerOutcomes)
    .values(rows.map((row) => ({ projectId, ...row, evidenceKind, evidenceRef })))
    .onConflictDoNothing({ target: [reviewerOutcomes.verdictKind, reviewerOutcomes.verdictId, reviewerOutcomes.reviewerRole, reviewerOutcomes.evidenceKind, reviewerOutcomes.evidenceRef] })
    .returning({ id: reviewerOutcomes.id });
  return inserted.length;
}

/** A check task's re-authored revision, set against the revision before it. */
interface ReauthoredRevision {
  readonly projectId: string;
  readonly taskId: string;
  readonly checkTaskId: string;
  /** The new revision; the one before it is `revision - 1`. */
  readonly revision: number;
  /** Checks of the revision before that the new one drops or changes (its command, or the files every command runs over). */
  readonly changed: ReadonlySet<string>;
  /** Checks of the revision before that the new one keeps as they were. */
  readonly kept: ReadonlySet<string>;
}

const DisputeRowSchema = z.strictObject({ id: z.string().min(1), checkName: z.string().min(1) });

const RoutedJudgementSchema = z.strictObject({
  id: z.string().min(1),
  checkName: z.string().min(1),
  firstModel: z.string().min(1),
  secondModel: z.string().min(1).nullable(),
});

/**
 * The reviewer outcomes a re-authored revision is evidence of: a dispute of the revision before it,
 * whichever task raised it, whose check the new one changes is upheld, and contradicts the pass of
 * every claim written by the time of the dispute that covers the check task; a rejection a review routed against a check of the
 * revision before it is witnessed when the new revision changes that check, refuted when it keeps it.
 * Returns how many rows were written.
 */
export async function recordReauthoredRevisionOutcomes(tx: DbHandle, write: ReauthoredRevision): Promise<number> {
  const previous = write.revision - 1;
  const disputes = z.array(DisputeRowSchema).parse(
    await tx
      .select({ id: checkDisputes.id, checkName: checkDisputes.checkName })
      .from(checkDisputes)
      .where(and(eq(checkDisputes.checkTaskId, write.checkTaskId), eq(checkDisputes.revision, previous)))
      .orderBy(asc(checkDisputes.createdAt), asc(checkDisputes.id)),
  );
  let written = 0;
  for (const dispute of disputes) {
    if (!write.changed.has(dispute.checkName)) continue;
    const claims = await claimsCovering(tx, write.projectId, write.checkTaskId, dispute.id);
    const rows = claims.flatMap((claim) => claimOutcomes(claim, new Set([write.checkTaskId])));
    written += await insertOutcomes(tx, write.projectId, "dispute-upheld", dispute.id, rows);
  }
  const routed = z.array(RoutedJudgementSchema).parse(
    await tx
      .select({
        id: suiteReviewJudgements.id,
        checkName: suiteReviewJudgements.checkName,
        firstModel: suiteReviewJudgements.firstModel,
        secondModel: suiteReviewJudgements.secondModel,
      })
      .from(suiteReviewJudgements)
      .where(
        and(
          eq(suiteReviewJudgements.checkTaskId, write.checkTaskId),
          eq(suiteReviewJudgements.outcome, "routed"),
          sql`${suiteReviewJudgements.checkName} IS NOT NULL`,
          sql`${suiteReviewJudgements.createdAt} >= (SELECT min(t.created_at) FROM task_checks t WHERE t.task_id = ${write.taskId} AND t.revision = ${previous})`,
        ),
      )
      .orderBy(asc(suiteReviewJudgements.createdAt), asc(suiteReviewJudgements.id)),
  );
  const rows = routed.flatMap((judgement): OutcomeRow[] => {
    const outcome: Outcome | null = write.changed.has(judgement.checkName) ? "finding-witnessed" : write.kept.has(judgement.checkName) ? "finding-refuted" : null;
    if (outcome === null) return [];
    const first: OutcomeRow = { verdictKind: "judgement", verdictId: judgement.id, reviewerModel: judgement.firstModel, reviewerRole: "first", outcome };
    return judgement.secondModel === null ? [first] : [first, { ...first, reviewerModel: judgement.secondModel, reviewerRole: "second" }];
  });
  written += await insertOutcomes(tx, write.projectId, "check-reauthored", `${write.taskId}#${write.revision}`, rows);
  return written;
}

/**
 * The reviewer outcomes a failed acceptance sweep is evidence of: a stored check that failed on main
 * contradicts the pass of every claim of the project covering its check task. Returns how many rows
 * were written.
 */
export async function recordFailedSweepOutcomes(tx: DbHandle, sweep: { readonly projectId: string; readonly sweepId: string; readonly failedCheckTasks: readonly string[] }): Promise<number> {
  const failing = new Set(sweep.failedCheckTasks);
  const byClaim = new Map<string, CoveringClaim>();
  for (const checkTaskId of failing) {
    for (const claim of await claimsCovering(tx, sweep.projectId, checkTaskId, null)) byClaim.set(claim.id, claim);
  }
  const rows = [...byClaim.values()].flatMap((claim) => claimOutcomes(claim, failing));
  return insertOutcomes(tx, sweep.projectId, "acceptance-failed", sweep.sweepId, rows);
}

/** The model call site each kind of verdict is answered at. */
const SITE_OF_VERDICT: Readonly<Record<VerdictKind, string>> = {
  claim: "suite-review",
  judgement: "suite-review",
  "intake-reading": "liaison-intake",
};

const ReviewerRecordRowSchema = z.strictObject({
  verdictKind: z.enum(["claim", "judgement", "intake-reading"]),
  reviewerModel: z.string().min(1),
  passesContradicted: z.number().int().nonnegative(),
  findingsWitnessed: z.number().int().nonnegative(),
  findingsRefuted: z.number().int().nonnegative(),
  evidence: z.number().int().nonnegative(),
});

const SiteCostRowSchema = z.strictObject({
  calls: z.number().int().nonnegative(),
  measuredCalls: z.number().int().nonnegative(),
  measuredUsd: z.number().nonnegative(),
});

/** An aggregate over llm_calls returned no row. */
class ReviewerCostUnreadable extends Error {
  constructor(
    readonly reviewerModel: string,
    readonly site: string,
  ) {
    super(`the llm_calls of ${reviewerModel} at site ${site} returned no aggregate row`);
    this.name = "ReviewerCostUnreadable";
  }
}

/** One reviewer model's record at one kind of verdict, with what that model's calls at the verdict's site cost the project. */
export interface ReviewerRecordLine {
  readonly verdictKind: VerdictKind;
  readonly site: string;
  readonly reviewerModel: string;
  /** Distinct verdicts of the model whose pass a witness contradicted. */
  readonly passesContradicted: number;
  /** Distinct verdicts of the model whose finding later evidence witnessed. */
  readonly findingsWitnessed: number;
  /** Distinct verdicts of the model whose finding later evidence refuted. */
  readonly findingsRefuted: number;
  /** reviewer_outcomes rows behind the counts: one per verdict, role and piece of evidence. */
  readonly evidence: number;
  readonly cost: z.infer<typeof SiteCostRowSchema>;
}

/** The project's reviewer record from reviewer_outcomes, per kind of verdict and reviewer model. */
export async function reviewerRecordOf(db: DbHandle, projectId: string): Promise<ReviewerRecordLine[]> {
  const result = await db.execute(sql`
    SELECT verdict_kind AS "verdictKind", reviewer_model AS "reviewerModel",
           count(DISTINCT verdict_id) FILTER (WHERE outcome = 'pass-contradicted')::int AS "passesContradicted",
           count(DISTINCT verdict_id) FILTER (WHERE outcome = 'finding-witnessed')::int AS "findingsWitnessed",
           count(DISTINCT verdict_id) FILTER (WHERE outcome = 'finding-refuted')::int AS "findingsRefuted",
           count(*)::int AS evidence
    FROM reviewer_outcomes
    WHERE project_id = ${projectId}
    GROUP BY verdict_kind, reviewer_model
    ORDER BY verdict_kind, reviewer_model`);
  const lines: ReviewerRecordLine[] = [];
  for (const row of z.array(ReviewerRecordRowSchema).parse(result.rows)) {
    const site = SITE_OF_VERDICT[row.verdictKind];
    const [spent] = z.array(SiteCostRowSchema).length(1).parse(await siteCostOf(db, projectId, site, row.reviewerModel));
    if (spent === undefined) throw new ReviewerCostUnreadable(row.reviewerModel, site);
    lines.push({ ...row, site, cost: spent });
  }
  return lines;
}
