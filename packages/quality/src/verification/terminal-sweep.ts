import type { ProjectId } from "@ashara/shared";
import { sweepMain } from "./acceptance-sweep.js";
import type { AcceptanceSweep, MainSweepDeps } from "./acceptance-sweep.js";

/** Z0's terminal sweep of a stopped or halted project on main HEAD; no model is called. */
export class TerminalSweeper {
  private readonly deps: MainSweepDeps;

  constructor(deps: MainSweepDeps) {
    this.deps = deps;
  }

  /**
   * The terminal sweep: the same commands-only run of every Completed implementation task's latest
   * checks on main HEAD, with no model called, for a project that stopped or halted short of
   * acceptance, so each guarantee's evidence on its last commit is on record. It judges no
   * acceptance: no goal task or public interface file is held against it, and its `passed` accepts
   * nothing. Neither the acceptance event nor the sweep observer sees it.
   */
  async sweepForTerminal(projectId: ProjectId, targetProjectPath: string): Promise<AcceptanceSweep> {
    return sweepMain(this.deps, projectId, targetProjectPath, null);
  }
}
