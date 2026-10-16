import { and, asc, count, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { suiteReviewFindings, suiteReviewJudgements } from "@ashara/db";
import type { Database, DbHandle } from "@ashara/db";
import type { SuiteReviewJudgementStore } from "../suite-review.js";

// Quality's record of the reviews of plan revisions' check suites (migration 044): each review
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

/**
 * What the record holds of the check tasks one review named: per check task, how many reviews have
 * named it, this one included, and every problem the earlier ones found in its checks, oldest first.
 */
interface RecordedSuiteReview {
  readonly timesNamed: ReadonlyMap<string, number>;
  readonly earlierFindings: ReadonlyMap<string, readonly ReviewProblem[]>;
}

export class SuiteReviewFindingRepository {
  constructor(private readonly db: Database) {}

  /**
   * Appends one row per check task the problems name and returns, per named check task, how many
   * reviews have named it, this one included, and what the earlier reviews found in its checks
   * (ADR-074 addendum 2 d89 F: a rewrite shown only the latest review can put back what an earlier
   * one had it drop), read in the same transaction as the insert.
   */
  async record(findings: NewSuiteReviewFindings): Promise<RecordedSuiteReview> {
    const named = [...new Set(findings.problems.flatMap((problem) => problem.checkTaskIds))];
    if (named.length === 0) throw new SuiteReviewFindingsUnrecordable(findings.reviewTaskId, "its problems name no check task");
    return this.db.transaction(async (tx) => {
      const inserted = await tx
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
        )
        .returning({ id: suiteReviewFindings.id });
      const earlierRows = await tx
        .select({ id: suiteReviewFindings.id, checkTaskId: suiteReviewFindings.checkTaskId, problems: suiteReviewFindings.problems })
        .from(suiteReviewFindings)
        .where(
          and(
            inArray(suiteReviewFindings.checkTaskId, named),
            notInArray(
              suiteReviewFindings.id,
              inserted.map((row) => row.id),
            ),
          ),
        )
        .orderBy(asc(suiteReviewFindings.createdAt), asc(suiteReviewFindings.id));
      const earlierFindings = new Map<string, ReviewProblem[]>(named.map((checkTaskId) => [checkTaskId, []]));
      for (const row of earlierRows) {
        const parsed = ReviewProblemsSchema.safeParse(row.problems);
        if (!parsed.success) throw new SuiteReviewFindingCorrupt(row.id, `problems do not parse: ${z.prettifyError(parsed.error)}`);
        earlierFindings.get(row.checkTaskId)?.push(...parsed.data);
      }
      const rows = await tx
        .select({ checkTaskId: suiteReviewFindings.checkTaskId, times: count() })
        .from(suiteReviewFindings)
        .where(inArray(suiteReviewFindings.checkTaskId, named))
        .groupBy(suiteReviewFindings.checkTaskId);
      const times = new Map(rows.map((row) => [row.checkTaskId, row.times]));
      // Every row just inserted is counted: a named check task below one means the count read another table state.
      const uncounted = named.filter((checkTaskId) => (times.get(checkTaskId) ?? 0) < 1);
      if (uncounted.length > 0) {
        throw new SuiteReviewFindingsUnrecordable(findings.reviewTaskId, `check task(s) ${uncounted.join(", ")} counted no review right after one was recorded`);
      }
      return { timesNamed: times, earlierFindings };
    });
  }
}

const StoredFindingSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("contradiction"),
    checkTasks: z.array(z.string().min(1)).min(1),
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
]);

const StoredJudgementSchema = z.strictObject({
  reviewTaskId: z.string().min(1),
  checkTaskId: z.string().min(1),
  checkName: z.string().min(1),
  outcome: z.enum(["routed", "released"]),
  firstFinding: StoredFindingSchema.refine((finding) => finding.kind === "outside-vision", "the first finding of a judgement is an outside-vision rejection"),
  secondFindings: z.array(StoredFindingSchema),
  firstModel: z.string().min(1),
  secondModel: z.string().min(1),
  secondReview: z.enum(["other-model", "re-sample"]),
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

/** Quality's record of a suite review's judgements on the rejections it routed or released (migration 063). */
export class SuiteReviewJudgementRepository implements SuiteReviewJudgementStore {
  constructor(private readonly db: DbHandle) {}

  async record(review: Parameters<SuiteReviewJudgementStore["record"]>[0]): Promise<void> {
    if (review.judgements.length === 0) return;
    await this.db.insert(suiteReviewJudgements).values(
      review.judgements.map((judgement) => ({
        projectId: review.projectId,
        reviewTaskId: review.reviewTaskId,
        checkTaskId: judgement.checkTaskId,
        checkName: judgement.check,
        outcome: judgement.outcome,
        firstFinding: judgement.first,
        secondFindings: judgement.second,
        firstModel: `${judgement.secondReview.first.provider}/${judgement.secondReview.first.model}`,
        secondModel: `${judgement.secondReview.second.provider}/${judgement.secondReview.second.model}`,
        secondReview: judgement.secondReview.kind,
      })),
    );
  }
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
      firstFinding: suiteReviewJudgements.firstFinding,
      secondFindings: suiteReviewJudgements.secondFindings,
      firstModel: suiteReviewJudgements.firstModel,
      secondModel: suiteReviewJudgements.secondModel,
      secondReview: suiteReviewJudgements.secondReview,
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
