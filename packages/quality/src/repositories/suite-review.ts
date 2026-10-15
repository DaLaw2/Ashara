import { and, asc, count, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { suiteReviewFindings } from "@ashara/db";
import type { Database, DbHandle } from "@ashara/db";

// Quality's record of the reviews of plan revisions' check suites (migration 044): each review
// that found problems is one row per check task it named.

const ReviewProblemSchema = z.strictObject({
  kind: z.enum(["contradiction", "outside-vision"]),
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
   * (ADR-074 addendum 2 d89 F: a rewrite shown only the latest review put back what an earlier one
   * had it drop), read in the same transaction as the insert.
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
