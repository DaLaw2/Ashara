import type { CheckRun, VerdictReport } from "@ashara/workplace";

/** A task's stored checks run on a checkout, or why they could not be placed on it. */
export type CheckRunReport =
  | { readonly kind: "ran"; readonly runs: readonly CheckRun[] }
  /** A stored check file could not be written into the checkout: the checks cannot run there. */
  | { readonly kind: "files_refused"; readonly detail: string }
  /**
   * The check files, or a check's command, left files the checkout's commit tracks changed: the
   * product the checks judge is no longer the one checked out, so the run reached no verdict on it
   * (a check defect). Nothing after that runs on the checkout.
   */
  | ProductChangedReport;

export interface ProductChangedReport {
  readonly kind: "product_changed";
  /** The check whose command changed them; null when writing the check files over the checkout did. */
  readonly check: string | null;
  /** The tracked paths changed, deleted or changed in kind, repository-relative. */
  readonly paths: readonly string[];
  /** The checks that ran before the change was found, the changing one last. */
  readonly runs: readonly CheckRun[];
}

/** Why a run that changed the project's tracked files has no verdict, naming the files. */
export function describeProductChange(report: ProductChangedReport): string {
  const by = report.check === null ? "writing the check files over it" : `check ${JSON.stringify(report.check)}`;
  return (
    `${by} changed files the project tracks: ${report.paths.join(", ")}. A check must not change the project's own ` +
    `files, so this run reached no verdict on the project`
  );
}

/** A check passes: it exited 0 within its time and printed something (an empty pass proves nothing). */
export function checkPassed(run: CheckRun): boolean {
  return run.exitCode === 0 && !run.timedOut && run.output.trim() !== "";
}

/** The verification verdict on one run, as the record and the model read it. */
export function checkVerdict(run: CheckRun): string {
  if (checkPassed(run)) return "PASSED";
  if (run.timedOut) return "FAILED: timed out";
  if (run.exitCode === null) return "FAILED: ended with its exit status unknown";
  return run.exitCode !== 0 ? `FAILED: exited ${run.exitCode}` : "FAILED: printed nothing";
}

export function formatCheckRuns(runs: readonly CheckRun[], verdictOf: (run: CheckRun) => string): string {
  return runs
    .map((run) =>
      [
        `Check ${JSON.stringify(run.name)}: ${verdictOf(run)}`,
        `  command: ${run.command}`,
        `  exit code: ${run.exitCode ?? "none (killed)"}${run.timedOut ? " (timed out)" : ""}`,
        `  output: ${run.output === "" ? "(empty)" : run.output}`,
      ].join("\n"),
    )
    .join("\n");
}

/** run_checks' report: each check's verdict, exactly as verification would read it. */
function formatCheckRunReport(report: CheckRunReport): string {
  if (report.kind === "files_refused") return `The checks could not be placed on your work: ${report.detail}`;
  if (report.kind === "product_changed") {
    return (
      `The checks could not be run on your work: ${describeProductChange(report)}. This is a defect of the checks, ` +
      `not of your work${report.check === null ? "" : `: dispute check ${JSON.stringify(report.check)} with dispute_check`}.`
    );
  }
  const passed = report.runs.filter(checkPassed).length;
  return `${passed} of ${report.runs.length} check(s) pass on your current work.\n${formatCheckRuns(report.runs, checkVerdict)}`;
}

/** run_checks' answer to the model: passed only when at least one check ran and every one passed. */
export function checkRunVerdict(report: CheckRunReport): VerdictReport {
  const passed = report.kind === "ran" && report.runs.length > 0 && report.runs.every(checkPassed);
  return { passed, report: formatCheckRunReport(report) };
}
