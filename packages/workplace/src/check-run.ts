import type { VerdictReport } from "./verdict-report.js";

/** One check run in a cell. */
export interface CheckRun {
  readonly name: string;
  readonly command: string;
  /** null when the host had to kill the podman client (timedOut is then true) or the command's exit status was lost in the cell. */
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  /** stdout and stderr together, their middle cut to a bound with a marker counting the characters cut. */
  readonly output: string;
}

/**
 * Z0's side of run_checks, supplied by the dispatch for a task decided by stored checks: it runs
 * those checks, with their stored files written over a throwaway copy of the worktree's current
 * files, in a fresh cell, and returns Quality's verdict on the run with its report. The model cannot
 * choose or change what runs. A substrate that cannot run them throws.
 */
export interface TaskCheckRunPort {
  /** The stored checks' names: the task's own checks dispute_check may name. */
  readonly checkNames: readonly string[];
  /**
   * The checks of the tasks already merged, which verification also runs on the merge: any of them
   * that blocks the merge may be disputed too, named with its task's id.
   */
  readonly mergedChecks: ReadonlyArray<{ readonly taskId: string; readonly name: string }>;
  run(timeoutSeconds: number): Promise<VerdictReport>;
}
