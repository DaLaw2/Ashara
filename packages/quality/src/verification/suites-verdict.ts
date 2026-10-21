import { checkPassed, checkVerdict, describeProductChange, formatCheckRuns } from "../check-verdict.js";
import type { PostMergeVerdict } from "../gates/finalize.js";
import type { CheckSuite, SuiteRun } from "../task-checks.js";

/**
 * The verdict on suites run in order (the environment's test, then `regressionCount` earlier
 * tasks' checks, then the task's own) on the task's tentative merge, or on main itself for a task
 * that changed nothing: passed only when every suite ran every one of its checks and each passed.
 * The details open with each failure, naming its suite and check. Only on a merge is an earlier
 * task's failing check this task's regression; on main the task changed nothing to cause it.
 */
export function suitesVerdict(
  suites: readonly CheckSuite[],
  runs: readonly SuiteRun[],
  regressionCount: number,
  on: "merge" | "main",
): PostMergeVerdict {
  const failures: string[] = [];
  const sections: string[] = [];
  let regressed = false;
  if (runs.length !== suites.length) failures.push(`${runs.length} of ${suites.length} suites reported a run`);
  suites.forEach((suite, index) => {
    const regression = on === "merge" && index >= 1 && index <= regressionCount;
    const prefix = regression ? "REGRESSION: " : "";
    const run = runs[index];
    if (run === undefined || run.suite !== suite) {
      failures.push(`${prefix}${suite.label}: did not run`);
      regressed ||= regression;
      return;
    }
    if (run.report.kind === "files_refused") {
      failures.push(`${prefix}${suite.label}: its check files could not be written over ${on === "merge" ? "the merged work" : "main"}: ${run.report.detail}`);
      sections.push(`${suite.label}: not run, its check files could not be written: ${run.report.detail}`);
      regressed ||= regression;
      return;
    }
    // Callers turn a product change into CheckRunChangedProduct first (productChangeOf); stated
    // here too, so this verdict never reads one as a pass.
    if (run.report.kind === "product_changed") {
      failures.push(`${suite.label}: no verdict: ${describeProductChange(run.report)}`);
      sections.push(`${suite.label}: no verdict: ${describeProductChange(run.report)}`);
      return;
    }
    const ran = run.report.runs;
    if (ran.length !== suite.checks.length || ran.length === 0) {
      failures.push(`${prefix}${suite.label}: ${ran.length} of ${suite.checks.length} checks ran`);
      regressed ||= regression;
    }
    for (const failed of ran.filter((check) => !checkPassed(check))) {
      failures.push(`${prefix}${suite.label}: check ${JSON.stringify(failed.name)} ${checkVerdict(failed)}`);
      regressed ||= regression;
    }
    sections.push(`${suite.label}:\n${formatCheckRuns(ran, checkVerdict)}`);
  });
  if (failures.length === 0) return { passed: true, details: sections.join("\n") };
  const head = [`${failures.length} failure(s) on ${on === "merge" ? "the merge" : "main"}:`, ...failures.map((failure) => `- ${failure}`)];
  if (regressed) {
    head.push("This task's merge breaks checks of a task already merged: the regression is this task's, and nothing was merged.");
  }
  return { passed: false, details: [...head, "", ...sections].join("\n") };
}
