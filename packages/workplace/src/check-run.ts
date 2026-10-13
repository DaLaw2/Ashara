/** One check run in a cell. */
export interface CheckRun {
  readonly name: string;
  readonly command: string;
  /** null when the host had to kill the podman client; timedOut is then true. */
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  /** The end of stdout and stderr together. */
  readonly output: string;
}

/** A task's stored checks run on a checkout, or why they could not be placed on it. */
export type CheckRunReport =
  | { readonly kind: "ran"; readonly runs: readonly CheckRun[] }
  /** A stored check file could not be written into the checkout: the checks cannot run there. */
  | { readonly kind: "files_refused"; readonly detail: string };

/**
 * Z0's side of run_checks, supplied by the execution service for a task decided by stored checks:
 * it runs those checks, with their stored files written over a throwaway copy of the worktree's
 * current files, in a fresh cell. The model cannot choose or change what runs. A substrate that
 * cannot run them throws.
 */
export interface TaskCheckRunPort {
  run(timeoutSeconds: number): Promise<CheckRunReport>;
}

/** A check passes: it exited 0 within its time and printed something (an empty pass proves nothing). */
export function checkPassed(run: CheckRun): boolean {
  return run.exitCode === 0 && !run.timedOut && run.output.trim() !== "";
}

/** The verification verdict on one run, as the record and the model read it. */
export function checkVerdict(run: CheckRun): string {
  if (checkPassed(run)) return "PASSED";
  if (run.timedOut) return "FAILED: timed out";
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
export function formatCheckRunReport(report: CheckRunReport): string {
  if (report.kind === "files_refused") return `The checks could not be placed on your work: ${report.detail}`;
  const passed = report.runs.filter(checkPassed).length;
  return `${passed} of ${report.runs.length} check(s) pass on your current work.\n${formatCheckRuns(report.runs, checkVerdict)}`;
}
