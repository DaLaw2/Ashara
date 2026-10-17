/**
 * The whole run report of one project (scripts/run-report.ts), read from the database: the run's
 * evidence, then the suite reviews' judgements, then their claims, each through its reader. Prints
 * nothing; the caller prints the text and exits 1 when `failed`.
 */

import type { DbHandle } from "@ashara/db";
import { suiteReviewClaimsOf, suiteReviewJudgementsOf } from "@ashara/quality";
import type { ProjectId } from "@ashara/shared";
import { readRunEvidence } from "@ashara/workplace";
import { formatRunReport, formatSuiteReviewClaims, formatSuiteReviewJudgements } from "./run-report-format.js";

/** The report's text, and whether an llm_calls row is priced at $0 or the spend does not add up to every row. */
export async function runReport(db: DbHandle, projectId: ProjectId): Promise<{ readonly text: string; readonly failed: boolean }> {
  const report = formatRunReport(await readRunEvidence(db, projectId));
  const judgements = formatSuiteReviewJudgements(await suiteReviewJudgementsOf(db, projectId));
  const claims = formatSuiteReviewClaims(await suiteReviewClaimsOf(db, projectId));
  return { text: [report.text, judgements, claims].join("\n"), failed: report.zeroCostCalls > 0 || report.attributionViolation };
}
