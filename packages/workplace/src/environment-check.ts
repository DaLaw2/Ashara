import type { VerdictReport } from "./verdict-report.js";

/**
 * Z0's side of build_environment, supplied by the dispatch for an environment task only: it reads
 * the definition from the worktree, builds the image from the worktree's committed tree, runs
 * `probe` in a cell from it, and returns Quality's verdict on the check with its report. The tool
 * itself runs nothing on the host.
 */
export interface EnvironmentCheckPort {
  check(testTimeoutSeconds: number): Promise<VerdictReport>;
}
