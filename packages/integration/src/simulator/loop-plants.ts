import { rewriteText } from "./faults.js";
import type { QueryPlant } from "./faults.js";

/*
 * The plants that prove the termination invariants bite (termination.ts W1-W4): each removes one
 * bound a loop ends on, at the query production reads or writes it with.
 */

/**
 * The work ledger reads no request as drawn (finance work-ledger.ts, LlmCallRepository.work): its
 * scope's llm_calls rows are filtered out, so no task or project is ever refused for its spent
 * requests (W1).
 */
export const ledgerDrawSkipped: QueryPlant = (args) =>
  rewriteText(args, (text) =>
    text.includes('AS "projectDrawn"')
      ? text.replace(/FROM llm_calls WHERE project_id = /, "FROM llm_calls WHERE false AND project_id = ")
      : text,
  );

/**
 * The reviews naming a check task are read as at most one (Quality SuiteReviewFindingRepository
 * record), so the review's bound is never reached and a check task is reopened on every review that
 * names it (W2's and W3's bound clauses).
 */
export const suiteReviewBoundIgnored: QueryPlant = (args) =>
  rewriteText(args, (text) =>
    /^select "check_task_id", count\(\*\) from "suite_review_findings" .* group by /.test(text)
      ? text.replace("count(*)", "least(count(*), 1)")
      : text,
  );

/**
 * A review's earlier findings are dropped as it records new ones, in the same statement: each check
 * task it names always counts one naming, so its rounds leave no count that grows (W2's counted
 * clause). The review task's id is the insert's own parameter for its first row.
 */
export const reviewCountReset: QueryPlant = (args) =>
  rewriteText(args, (text) => {
    const insert = /^insert into "suite_review_findings" \(([^)]*)\) values \(([^)]*)\)/.exec(text);
    if (insert === null) return text;
    const columns = insert[1]?.split(", ");
    const values = insert[2]?.split(", ");
    const at = columns?.indexOf('"review_task_id"');
    const parameter = at === undefined || at < 0 ? undefined : values?.[at];
    if (parameter === undefined || !/^\$\d+$/.test(parameter)) return text;
    return `with planted_reset as (delete from "suite_review_findings" where "review_task_id" = ${parameter}) ${text}`;
  });

/** Both the review's bound and the work ledger gone: the review loop has no exit left at all (W4, and W1). */
export const reviewLoopUnbounded: QueryPlant = (args) => suiteReviewBoundIgnored(args) ?? ledgerDrawSkipped(args);
