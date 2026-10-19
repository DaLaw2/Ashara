import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { suiteReviewClaims, suiteReviewFindings, suiteReviewJudgements, undecidedItemClaims, undecidedItems } from "@ashara/db";
import type { Database, DbHandle, DbTransaction } from "@ashara/db";
import { CAPABILITY_RANK, CapabilityLevelSchema, SECOND_OPINION_STRENGTHS } from "@ashara/finance";
import type { CapabilityLevel, JudgeRelation } from "@ashara/finance";
import type { SuiteReviewJudgementStore } from "../suite-review.js";

// Quality's record of the reviews of plan revisions' check suites: each review
// that found problems is one row per check task it named.

const ReviewProblemSchema = z.strictObject({
  kind: z.enum(["contradiction", "outside-vision", "undecided-item"]),
  problem: z.string().min(1),
  evidence: z.string().min(1),
});

const ReviewProblemsSchema = z.array(ReviewProblemSchema).min(1);

type ReviewProblem = z.infer<typeof ReviewProblemSchema>;

/** One review that found problems, as its dispatch ended with it. */
interface NewSuiteReviewFindings {
  readonly projectId: string;
  readonly reviewTaskId: string;
  readonly problems: ReadonlyArray<ReviewProblem & { readonly checkTaskIds: readonly string[] }>;
}

/** A count read back after the insert did not include it, or a review that named no check task. */
class SuiteReviewFindingsUnrecordable extends Error {
  constructor(
    readonly reviewTaskId: string,
    readonly detail: string,
  ) {
    super(`the findings of review task ${reviewTaskId} could not be recorded: ${detail}`);
    this.name = "SuiteReviewFindingsUnrecordable";
  }
}

/** A stored finding's problems do not parse. */
class SuiteReviewFindingCorrupt extends Error {
  constructor(
    readonly findingId: string,
    readonly issues: string,
  ) {
    super(`suite_review_findings row ${findingId}: ${issues}`);
    this.name = "SuiteReviewFindingCorrupt";
  }
}

/** What the record holds of the check tasks one review named: per check task, how many reviews have named it, this one included. */
interface RecordedSuiteReview {
  readonly timesNamed: ReadonlyMap<string, number>;
}

export class SuiteReviewFindingRepository {
  constructor(private readonly db: Database) {}

  /**
   * Appends one row per check task the problems name and returns, per named check task, how many
   * reviews have named it, this one included, read in the same transaction as the insert: the
   * count that bounds its reopens, which no refund of the review's dispatch changes.
   */
  async record(findings: NewSuiteReviewFindings): Promise<RecordedSuiteReview> {
    const named = [...new Set(findings.problems.flatMap((problem) => problem.checkTaskIds))];
    if (named.length === 0) throw new SuiteReviewFindingsUnrecordable(findings.reviewTaskId, "its problems name no check task");
    return this.db.transaction(async (tx) => {
      await tx
        .insert(suiteReviewFindings)
        .values(
          named.map((checkTaskId) => ({
            projectId: findings.projectId,
            reviewTaskId: findings.reviewTaskId,
            checkTaskId,
            problems: findings.problems
              .filter((problem) => problem.checkTaskIds.includes(checkTaskId))
              .map(({ kind, problem, evidence }) => ({ kind, problem, evidence })),
          })),
        );
      const rows = await tx
        .select({ checkTaskId: suiteReviewFindings.checkTaskId, times: count() })
        .from(suiteReviewFindings)
        .where(inArray(suiteReviewFindings.checkTaskId, named))
        .groupBy(suiteReviewFindings.checkTaskId);
      const times = new Map(rows.map((row) => [row.checkTaskId, row.times]));
      // Every row just inserted is counted: a named check task below one means the count read another table state.
      // eslint-disable-next-line no-restricted-syntax -- policy default: a check task with no counted row reads 0, which throws SuiteReviewFindingsUnrecordable below
      const uncounted = named.filter((checkTaskId) => (times.get(checkTaskId) ?? 0) < 1);
      if (uncounted.length > 0) {
        throw new SuiteReviewFindingsUnrecordable(findings.reviewTaskId, `check task(s) ${uncounted.join(", ")} counted no review right after one was recorded`);
      }
      return { timesNamed: times };
    });
  }
}

const StoredConflictSideSchema = z.strictObject({ checkTask: z.string().min(1), check: z.string().min(1), requires: z.string().min(1) });

/** A contradiction's two sides, named; an older row holds them as a pair, read as the same two. */
const StoredConflictSchema = z.union([
  z.strictObject({ first: StoredConflictSideSchema, second: StoredConflictSideSchema }),
  z.tuple([StoredConflictSideSchema, StoredConflictSideSchema]).transform(([first, second]) => ({ first, second })),
]);

const StoredFindingSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("contradiction"),
    checkTasks: z.array(z.string().min(1)).min(1),
    // An older second review's contradiction quotes no conflict.
    conflict: StoredConflictSchema.optional(),
    problem: z.string().min(1),
    evidence: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal("outside-vision"),
    checkTasks: z.array(z.string().min(1)).length(1),
    check: z.string().min(1),
    judgedItems: z.array(z.string().min(1)).min(1),
    missingClause: z.string().min(1),
    problem: z.string().min(1),
    evidence: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal("undecided-item"),
    checkTasks: z.array(z.string().min(1)).length(1),
    item: z.string().min(1),
    problem: z.string().min(1),
    evidence: z.string().min(1),
  }),
]);

/** A strength of second opinion a review got no answer at. */
const PassedOverSchema = z.strictObject({ strength: z.enum(SECOND_OPINION_STRENGTHS), outcome: z.enum(["unavailable", "failed"]), reason: z.string().min(1) });

/** The tier columns of a stored judgement or claim, as read. */
const StoredTierColumns = {
  judgeTier: CapabilityLevelSchema.nullable(),
  judgedTier: CapabilityLevelSchema.nullable(),
  tierRelation: z.enum(["above", "equal"]).nullable(),
  firstTier: CapabilityLevelSchema.nullable(),
  secondTier: CapabilityLevelSchema.nullable(),
};

/**
 * The grade of each review a stored row rests on, as called: the first review's, and the second's
 * where one answered (null where none did); or ungraded, on a row written before they were recorded.
 */
type ReviewTiers = { readonly kind: "graded"; readonly first: CapabilityLevel; readonly second: CapabilityLevel | null } | { readonly kind: "ungraded" };

/**
 * How a stored row's judges stood to the check work: the weaker judge's grade, the work's tier,
 * whether the judge stood above it or only equal to it, and each review's grade; or unrecorded, on a
 * row written before they were.
 */
type StoredTiers =
  | { readonly kind: "recorded"; readonly judge: CapabilityLevel; readonly judged: CapabilityLevel; readonly relation: JudgeRelation; readonly reviews: ReviewTiers }
  | { readonly kind: "unrecorded" };

/**
 * The tiers of a row whose three judge columns are all set or all null, and whose review grades are
 * set only beside them, the second exactly where a second review answered, the weaker being the
 * judge's; null on any other row, which no row may hold.
 */
function storedTiersOf(
  row: {
    readonly judgeTier: CapabilityLevel | null;
    readonly judgedTier: CapabilityLevel | null;
    readonly tierRelation: JudgeRelation | null;
    readonly firstTier: CapabilityLevel | null;
    readonly secondTier: CapabilityLevel | null;
  },
  secondAnswered: boolean,
): StoredTiers | null {
  const { judgeTier, judgedTier, tierRelation, firstTier, secondTier } = row;
  if (judgeTier === null && judgedTier === null && tierRelation === null) return firstTier === null && secondTier === null ? { kind: "unrecorded" } : null;
  if (judgeTier === null || judgedTier === null || tierRelation === null) return null;
  const recorded = { kind: "recorded" as const, judge: judgeTier, judged: judgedTier, relation: tierRelation };
  if (firstTier === null) return secondTier === null ? { ...recorded, reviews: { kind: "ungraded" } } : null;
  if ((secondTier !== null) !== secondAnswered) return null;
  const weaker = secondTier !== null && CAPABILITY_RANK[secondTier] < CAPABILITY_RANK[firstTier] ? secondTier : firstTier;
  if (weaker !== judgeTier) return null;
  return { ...recorded, reviews: { kind: "graded", first: firstTier, second: secondTier } };
}

const TIERS_WHOLE =
  "a row records its judge tier, judged tier and tier relation together, or none of them; each review's grade only beside them, the second exactly where a second review answered, the weaker being the judge tier";

const StoredJudgementSchema = z
  .strictObject({
    reviewTaskId: z.string().min(1),
    checkTaskId: z.string().min(1),
    checkName: z.string().min(1).nullable(),
    outcome: z.enum(["routed", "released", "advisory"]),
    // no-other-family: a same-provider answer that confirmed nothing, on rows written before strengths were recorded.
    basis: z.enum(["two-reviews", "second-opinion-agreed", "second-opinion-disagreed", "no-other-family", "second-review-failed", "frozen", "reopened-once"]),
    firstFinding: StoredFindingSchema,
    secondFindings: z.array(StoredFindingSchema),
    firstModel: z.string().min(1),
    secondModel: z.string().min(1).nullable(),
    secondStrength: z.enum(SECOND_OPINION_STRENGTHS).nullable(),
    passedOver: z.array(PassedOverSchema),
    secondFailure: z.string().min(1).nullable(),
    ...StoredTierColumns,
  })
  .refine((row) => (row.firstFinding.kind === "outside-vision") === (row.checkName !== null), "a judgement names a check exactly when its first finding is an outside-vision rejection")
  .refine((row) => (row.secondModel === null) === (row.secondStrength === null), "a judgement records a second review's model exactly when it records that review's strength")
  .refine((row) => (row.basis === "second-review-failed") === (row.secondFailure !== null), "a judgement records why its second review failed exactly when its basis is second-review-failed")
  .transform(({ judgeTier, judgedTier, tierRelation, firstTier, secondTier, ...judgement }, ctx) => {
    const tiers = storedTiersOf({ judgeTier, judgedTier, tierRelation, firstTier, secondTier }, judgement.secondModel !== null);
    if (tiers !== null) return { ...judgement, tiers };
    ctx.addIssue({ code: "custom", message: TIERS_WHOLE });
    return z.NEVER;
  });

export type StoredJudgement = z.infer<typeof StoredJudgementSchema>;

/** A stored judgement does not parse. */
class SuiteReviewJudgementCorrupt extends Error {
  constructor(
    readonly judgementId: string,
    readonly issues: string,
  ) {
    super(`suite_review_judgements row ${judgementId}: ${issues}`);
    this.name = "SuiteReviewJudgementCorrupt";
  }
}

/** An insert of judgements read back fewer rows than it wrote: the items they leave undecided could not be tied to them. */
class SuiteReviewJudgementsUnreturned extends Error {
  constructor(
    readonly reviewTaskId: string,
    readonly written: number,
    readonly returned: number,
  ) {
    super(`review task ${reviewTaskId}: ${written} judgement(s) were written but ${returned} came back`);
    this.name = "SuiteReviewJudgementsUnreturned";
  }
}

/** A claim's insert read back no row: the items it leaves undecided could not be tied to it. */
class SuiteReviewClaimUnreturned extends Error {
  constructor(readonly reviewTaskId: string) {
    super(`review task ${reviewTaskId}: its claim was written but no row came back`);
    this.name = "SuiteReviewClaimUnreturned";
  }
}

/**
 * Quality's record of a suite review's judgements on its findings,
 * of its claim when it routed nothing, and of the cited items either leaves undecided,
 * in one transaction: an item is never kept undecided without the judgement or claim that left it
 * so, nor a judgement or claim without its items.
 */
export class SuiteReviewJudgementRepository implements SuiteReviewJudgementStore {
  constructor(private readonly db: Database) {}

  async record(review: Parameters<SuiteReviewJudgementStore["record"]>[0]): Promise<void> {
    const { claim } = review;
    if (review.judgements.length === 0 && claim === null) return;
    await this.db.transaction(async (tx) => {
      const claimed = claim === null ? [] : await this.recordClaim(tx, review.projectId, review.reviewTaskId, claim);
      if (review.judgements.length === 0) {
        await keepUndecided(tx, review.projectId, review.reviewTaskId, claimed);
        return;
      }
      const ids = await tx
        .insert(suiteReviewJudgements)
        .values(
          review.judgements.map((judgement) => ({
            projectId: review.projectId,
            reviewTaskId: review.reviewTaskId,
            checkTaskId: judgement.checkTaskId,
            checkName: judgement.check,
            outcome: judgement.outcome,
            basis: judgement.basis,
            firstFinding: judgement.first,
            secondFindings: judgement.second,
            firstModel: modelText(judgement.firstModel),
            secondModel: judgement.secondReview === null ? null : modelText(judgement.secondReview.second),
            secondStrength: judgement.secondReview === null ? null : judgement.secondReview.strength,
            passedOver: judgement.passedOver,
            secondFailure: judgement.secondFailure,
            ...tierColumns(judgement),
          })),
        )
        .returning({ id: suiteReviewJudgements.id });
      if (ids.length !== review.judgements.length) throw new SuiteReviewJudgementsUnreturned(review.reviewTaskId, review.judgements.length, ids.length);
      const undecided = review.judgements.flatMap((judgement, i) => {
        const id = ids[i]?.id;
        return judgement.undecided === null || id === undefined ? [] : [{ ...judgement.undecided, judgementId: id, claimId: null }];
      });
      await keepUndecided(tx, review.projectId, review.reviewTaskId, [...undecided, ...claimed]);
    });
  }

  /** The claim's row, and the items it leaves undecided tied to it. */
  private async recordClaim(
    tx: DbTransaction,
    projectId: string,
    reviewTaskId: string,
    claim: NonNullable<Parameters<SuiteReviewJudgementStore["record"]>[0]["claim"]>,
  ): Promise<UndecidedRow[]> {
    const [row] = await tx
      .insert(suiteReviewClaims)
      .values({
        projectId,
        reviewTaskId,
        basis: claim.basis,
        covered: claim.covered,
        firstModel: modelText(claim.firstModel),
        secondModel: claim.secondReview === null ? null : modelText(claim.secondReview.second),
        secondStrength: claim.secondReview === null ? null : claim.secondReview.strength,
        passedOver: claim.passedOver,
        secondFindings: claim.second,
        secondFailure: claim.secondFailure,
        ...tierColumns(claim),
      })
      .returning({ id: suiteReviewClaims.id });
    if (row === undefined) throw new SuiteReviewClaimUnreturned(reviewTaskId);
    return claim.unconfirmed.map((item) => ({ ...item, judgementId: null, claimId: row.id }));
  }
}

/** One cited item to keep undecided, with the judgement or the claim that left it so. */
interface UndecidedRow {
  readonly checkTaskId: string;
  readonly itemId: string;
  readonly itemText: string;
  readonly judgementId: string | null;
  readonly claimId: string | null;
}

/**
 * Keeps each item undecided and ties it to every claim that leaves it so. One
 * undecided_items row per check task and item: an item an earlier round, or this round's judgement,
 * kept is not written again, but a claim leaving it undecided is still tied to it, so the item reads
 * back under every claim that keeps it, never under the first alone.
 */
async function keepUndecided(tx: DbTransaction, projectId: string, reviewTaskId: string, rows: readonly UndecidedRow[]): Promise<void> {
  if (rows.length === 0) return;
  await tx
    .insert(undecidedItems)
    .values(rows.map((item) => ({ projectId, reviewTaskId, ...item })))
    .onConflictDoNothing({ target: [undecidedItems.checkTaskId, undecidedItems.itemId] });
  const claimed = rows.flatMap(({ claimId, checkTaskId, itemId }) => (claimId === null ? [] : [{ claimId, checkTaskId, itemId }]));
  if (claimed.length === 0) return;
  // A claim that names one item twice is tied to it once.
  await tx.insert(undecidedItemClaims).values(claimed).onConflictDoNothing();
}

function modelText(model: { readonly provider: string; readonly model: string }): string {
  return `${model.provider}/${model.model}`;
}

/** The tier columns of a judgement or claim: how its judges stood to the work, and each review's grade as called. */
function tierColumns(row: {
  readonly tiers: { readonly judgeTier: CapabilityLevel; readonly judgedTier: CapabilityLevel; readonly relation: JudgeRelation };
  readonly firstModel: { readonly grade: CapabilityLevel };
  readonly secondReview: { readonly second: { readonly grade: CapabilityLevel } } | null;
}) {
  const { tiers } = row;
  return {
    judgeTier: tiers.judgeTier,
    judgedTier: tiers.judgedTier,
    tierRelation: tiers.relation,
    firstTier: row.firstModel.grade,
    secondTier: row.secondReview === null ? null : row.secondReview.second.grade,
  };
}

/** Every judgement the suite reviews of a project recorded, oldest first, each parsed whole: what the owner's run report states of them. */
export async function suiteReviewJudgementsOf(db: DbHandle, projectId: string): Promise<StoredJudgement[]> {
  const rows = await db
    .select({
      id: suiteReviewJudgements.id,
      reviewTaskId: suiteReviewJudgements.reviewTaskId,
      checkTaskId: suiteReviewJudgements.checkTaskId,
      checkName: suiteReviewJudgements.checkName,
      outcome: suiteReviewJudgements.outcome,
      basis: suiteReviewJudgements.basis,
      firstFinding: suiteReviewJudgements.firstFinding,
      secondFindings: suiteReviewJudgements.secondFindings,
      firstModel: suiteReviewJudgements.firstModel,
      secondModel: suiteReviewJudgements.secondModel,
      secondStrength: suiteReviewJudgements.secondStrength,
      passedOver: suiteReviewJudgements.passedOver,
      secondFailure: suiteReviewJudgements.secondFailure,
      judgeTier: suiteReviewJudgements.judgeTier,
      judgedTier: suiteReviewJudgements.judgedTier,
      tierRelation: suiteReviewJudgements.tierRelation,
      firstTier: suiteReviewJudgements.firstTier,
      secondTier: suiteReviewJudgements.secondTier,
    })
    .from(suiteReviewJudgements)
    .where(eq(suiteReviewJudgements.projectId, projectId))
    // One review's judgements are written in one transaction and share created_at.
    .orderBy(asc(suiteReviewJudgements.createdAt), asc(suiteReviewJudgements.reviewTaskId), asc(suiteReviewJudgements.checkName), asc(suiteReviewJudgements.id));
  return rows.map(({ id, ...row }) => {
    const parsed = StoredJudgementSchema.safeParse(row);
    if (!parsed.success) throw new SuiteReviewJudgementCorrupt(id, z.prettifyError(parsed.error));
    return parsed.data;
  });
}

/** A stored second review's strength; null where none answered. */
const StoredStrengthSchema = z.enum(SECOND_OPINION_STRENGTHS).nullable();

/**
 * A stored claim's second_strength is no strength of second opinion, or a confirmed claim records none: never read as verified.
 * @testseam exported for suite-review.test.ts; storedClaimOf throws it in production
 */
export class SuiteReviewStrengthUnreadable extends Error {
  constructor(
    readonly claimId: string,
    readonly detail: string,
  ) {
    super(`suite_review_claims row ${claimId}: second_strength is not a strength of second opinion: ${detail}`);
    this.name = "SuiteReviewStrengthUnreadable";
  }
}

/** A stored claim, or an item it leaves unverified, does not parse. */
class SuiteReviewClaimCorrupt extends Error {
  constructor(
    readonly claimId: string,
    readonly issues: string,
  ) {
    super(`suite_review_claims row ${claimId}: ${issues}`);
    this.name = "SuiteReviewClaimCorrupt";
  }
}

const StoredClaimSchema = z
  .strictObject({
    reviewTaskId: z.string().min(1),
    // no-other-family: a same-provider answer that confirmed nothing, on rows written before strengths were recorded.
    basis: z.enum(["second-opinion-clean", "second-opinion-found", "no-other-family", "second-review-failed"]),
    covered: z.array(z.string().min(1)).min(1),
    firstModel: z.string().min(1),
    secondModel: z.string().min(1).nullable(),
    secondStrength: StoredStrengthSchema,
    passedOver: z.array(PassedOverSchema),
    secondFindings: z.array(StoredFindingSchema),
    secondFailure: z.string().min(1).nullable(),
    unverified: z.array(z.strictObject({ checkTaskId: z.string().min(1), itemId: z.string().min(1), itemText: z.string() })),
    ...StoredTierColumns,
  })
  .refine((row) => row.basis !== "second-opinion-clean" || row.unverified.length === 0, "a claim a second review confirmed clean leaves no item unverified")
  .transform(({ secondModel, secondStrength, secondFindings, secondFailure, judgeTier, judgedTier, tierRelation, firstTier, secondTier, ...rest }, ctx) => {
    const tiers = storedTiersOf({ judgeTier, judgedTier, tierRelation, firstTier, secondTier }, secondModel !== null);
    if (tiers === null) {
      ctx.addIssue({ code: "custom", message: TIERS_WHOLE });
      return z.NEVER;
    }
    const claim = { ...rest, tiers };
    if (secondModel !== null && secondStrength !== null && secondFailure === null && claim.basis !== "second-review-failed") {
      return { ...claim, second: { kind: "answered" as const, model: secondModel, strength: secondStrength, findings: secondFindings } };
    }
    if (secondModel === null && secondStrength === null && secondFailure !== null && claim.basis === "second-review-failed" && secondFindings.length === 0) {
      return { ...claim, second: { kind: "failed" as const, reason: secondFailure } };
    }
    ctx.addIssue({ code: "custom", message: "a claim's second review either answered (model, strength, no failure) or failed (failure, no model, strength or finding), as its basis says" });
    return z.NEVER;
  });

export type StoredClaim = z.infer<typeof StoredClaimSchema>;

/**
 * One suite_review_claims row with the undecided items tied to it (undecided_item_claims), parsed whole. The strength is read
 * first: one that is no strength of second opinion, or a confirmed claim with none, throws
 * SuiteReviewStrengthUnreadable, so no claim reads as verified at a strength the record does not hold.
 * @testseam exported for suite-review.test.ts; suiteReviewClaimsOf is its production caller
 */
export function storedClaimOf(id: string, row: Record<string, unknown> & { readonly basis: unknown; readonly secondStrength: unknown }): StoredClaim {
  const strength = StoredStrengthSchema.safeParse(row.secondStrength);
  if (!strength.success) throw new SuiteReviewStrengthUnreadable(id, z.prettifyError(strength.error));
  if (strength.data === null && (row.basis === "second-opinion-clean" || row.basis === "second-opinion-found")) {
    throw new SuiteReviewStrengthUnreadable(id, `the claim is ${row.basis} but records no strength`);
  }
  const parsed = StoredClaimSchema.safeParse(row);
  if (!parsed.success) throw new SuiteReviewClaimCorrupt(id, z.prettifyError(parsed.error));
  return parsed.data;
}

/**
 * Every claim the suite reviews of a project recorded when they routed nothing, oldest first, each
 * with the covered items it leaves unverified: what the owner's run report states of them.
 */
export async function suiteReviewClaimsOf(db: DbHandle, projectId: string): Promise<StoredClaim[]> {
  const rows = await db
    .select({
      id: suiteReviewClaims.id,
      reviewTaskId: suiteReviewClaims.reviewTaskId,
      basis: suiteReviewClaims.basis,
      covered: suiteReviewClaims.covered,
      firstModel: suiteReviewClaims.firstModel,
      secondModel: suiteReviewClaims.secondModel,
      secondStrength: suiteReviewClaims.secondStrength,
      passedOver: suiteReviewClaims.passedOver,
      secondFindings: suiteReviewClaims.secondFindings,
      secondFailure: suiteReviewClaims.secondFailure,
      judgeTier: suiteReviewClaims.judgeTier,
      judgedTier: suiteReviewClaims.judgedTier,
      tierRelation: suiteReviewClaims.tierRelation,
      firstTier: suiteReviewClaims.firstTier,
      secondTier: suiteReviewClaims.secondTier,
    })
    .from(suiteReviewClaims)
    .where(eq(suiteReviewClaims.projectId, projectId))
    .orderBy(asc(suiteReviewClaims.createdAt), asc(suiteReviewClaims.id));
  if (rows.length === 0) return [];
  // Through every claim's tie, not undecided_items.claim_id, which names only the first claim that kept the item.
  const items = await db
    .select({ claimId: undecidedItemClaims.claimId, checkTaskId: undecidedItemClaims.checkTaskId, itemId: undecidedItemClaims.itemId, itemText: undecidedItems.itemText })
    .from(undecidedItemClaims)
    .leftJoin(undecidedItems, and(eq(undecidedItems.checkTaskId, undecidedItemClaims.checkTaskId), eq(undecidedItems.itemId, undecidedItemClaims.itemId)))
    .where(inArray(undecidedItemClaims.claimId, rows.map((row) => row.id)))
    .orderBy(asc(undecidedItemClaims.checkTaskId), asc(undecidedItemClaims.itemId));
  return rows.map(({ id, ...row }) =>
    storedClaimOf(id, {
      ...row,
      unverified: items
        .filter((item) => item.claimId === id)
        .map(({ checkTaskId, itemId, itemText }) => {
          // A tie with no kept item would read as an item left unverified with no text: never listed as one.
          if (itemText === null) throw new SuiteReviewClaimCorrupt(id, `it is tied to item ${itemId} of check task ${checkTaskId}, which no undecided_items row keeps`);
          return { checkTaskId, itemId, itemText };
        }),
    }),
  );
}

/** The review a suite_review block was written on: what it found, and how often it had named the check task. */
interface BlockingReviewRow {
  readonly times: number;
  readonly problems: readonly string[];
}

/**
 * The last review of the project recorded at or before `blockedAt`, as the Liaison's report states
 * it: its problems, once each, and the most times any check task it named had been named by then.
 * Null when the project has no review recorded by then.
 */
export async function blockingReview(db: DbHandle, projectId: string, blockedAt: Date): Promise<BlockingReviewRow | null> {
  // A JS Date holds milliseconds and created_at microseconds: every comparison of the two is
  // made in Postgres at millisecond precision, and the review's own timestamp never leaves it.
  const byBlock = sql`date_trunc('milliseconds', ${suiteReviewFindings.createdAt}) <= ${blockedAt.toISOString()}::timestamptz`;
  const [last] = await db
    .select({ id: suiteReviewFindings.id, reviewTaskId: suiteReviewFindings.reviewTaskId })
    .from(suiteReviewFindings)
    .where(and(eq(suiteReviewFindings.projectId, projectId), byBlock))
    .orderBy(desc(suiteReviewFindings.createdAt), desc(suiteReviewFindings.id))
    .limit(1);
  if (!last) return null;
  // One review's rows are written in one transaction, so they share its created_at.
  const rows = await db
    .select({ id: suiteReviewFindings.id, checkTaskId: suiteReviewFindings.checkTaskId, problems: suiteReviewFindings.problems })
    .from(suiteReviewFindings)
    .where(
      and(
        eq(suiteReviewFindings.reviewTaskId, last.reviewTaskId),
        sql`${suiteReviewFindings.createdAt} = (SELECT created_at FROM suite_review_findings WHERE id = ${last.id})`,
      ),
    );
  const [first, ...rest] = rows;
  if (first === undefined) throw new SuiteReviewFindingCorrupt(last.id, "the review it belongs to reads back no row");
  const problems = new Set<string>();
  const counts: number[] = [];
  for (const row of [first, ...rest]) {
    const parsed = ReviewProblemsSchema.safeParse(row.problems);
    if (!parsed.success) throw new SuiteReviewFindingCorrupt(row.id, `problems do not parse: ${z.prettifyError(parsed.error)}`);
    for (const problem of parsed.data) problems.add(problem.problem);
    const [counted] = await db
      .select({ times: count() })
      .from(suiteReviewFindings)
      .where(and(eq(suiteReviewFindings.checkTaskId, row.checkTaskId), byBlock));
    if (counted === undefined || counted.times < 1) throw new SuiteReviewFindingCorrupt(row.id, "its check task counts no review by the block");
    counts.push(counted.times);
  }
  return { times: Math.max(...counts), problems: [...problems] };
}
