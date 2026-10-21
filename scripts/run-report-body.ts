/**
 * The whole run report of one project (scripts/run-report.ts), read from the database: the run's
 * evidence, with the tender pick and the hidden suite's verdict beside Ashara's (its latest acceptance sweep) after its first line,
 * then one Ashara/hidden pair per intended guarantee of the mapping (Ashara's side from the guarantee_verdicts of its
 * last terminal report), then the suite reviews' judgements, then their claims, then each reviewer's record, each
 * through its reader. Prints nothing; the caller prints the text and exits 1 when `failed`.
 */

import type { DbHandle } from "@ashara/db";
import { lastReportGuaranteeVerdictsOf } from "@ashara/engagement";
import { latestAcceptanceSweepOf, reviewerRecordOf, suiteReviewClaimsOf, suiteReviewJudgementsOf } from "@ashara/quality";
import type { ProjectId } from "@ashara/shared";
import { projectHalted } from "@ashara/delivery/predicates";
import { projectWorkItems } from "@ashara/delivery/reads";
import { readRunEvidence } from "@ashara/workplace";
import {
  asharaGuaranteesOf,
  asharaVerdictOf,
  formatGuaranteePairs,
  formatPoolVerdicts,
  formatReviewerRecord,
  formatRunReport,
  formatSuiteReviewClaims,
  formatSuiteReviewJudgements,
  type PoolEvidence,
} from "./run-report-format.js";

/**
 * The report's text, and whether an llm_calls row is priced at $0, the spend does not add up to every row, the
 * hidden verdict judges another tender than the pick, or the mapping does not join to the last terminal report.
 */
export async function runReport(db: DbHandle, projectId: ProjectId, pool: PoolEvidence): Promise<{ readonly text: string; readonly failed: boolean }> {
  const evidence = await readRunEvidence(db, projectId, projectHalted, projectWorkItems);
  const report = formatRunReport(evidence);
  const verdicts = formatPoolVerdicts(asharaVerdictOf(projectId, await latestAcceptanceSweepOf(db, projectId)), pool);
  const pairs = formatGuaranteePairs(asharaGuaranteesOf(projectId, await lastReportGuaranteeVerdictsOf(db, projectId)), pool);
  const [head, ...rest] = report.text.split("\n");
  const judgements = formatSuiteReviewJudgements(await suiteReviewJudgementsOf(db, projectId));
  const claims = formatSuiteReviewClaims(await suiteReviewClaimsOf(db, projectId));
  const reviewers = formatReviewerRecord(await reviewerRecordOf(db, projectId));
  return {
    text: [head, ...verdicts.lines, ...pairs.lines, ...rest, judgements, claims, reviewers].join("\n"),
    failed: report.zeroCostCalls > 0 || report.attributionViolation || verdicts.violation || pairs.violation,
  };
}
