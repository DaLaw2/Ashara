import type { Logger, ProjectId, StepContainment } from "@ashara/shared";
import { containEach, describeErrorChain } from "@ashara/shared";
import type { TaskVerification } from "./acl/quality-acl.js";

// A project that reaches a terminal short of acceptance, the client's stop or a halt of any kind (a
// budget stop among them), gets one terminal sweep: the acceptance sweep's commands-only run of
// every stored check on main HEAD, with no model called, so each guarantee's evidence on the last
// commit is on record whatever ended the work. It runs once per stop and per halt episode, before
// the halt's report. A sweep that cannot run on a commit (no workspace, the substrate not answering,
// any other fault) is recorded all the same, with no check run and why, so its guarantees read as
// having no evidence on a commit rather than having no record at all.

type Sweep = Awaited<ReturnType<TaskVerification["sweepForTerminal"]>>;

/** What a terminal sweep is run for: the client's consumed stop, or a halt episode. */
type Terminal = { readonly kind: "stop"; readonly stopId: string } | { readonly kind: "halt"; readonly blockId: string };

/** A project at a terminal short of acceptance with no terminal sweep recorded for it yet. */
interface DueTerminalSweep {
  readonly projectId: ProjectId;
  /** null when no workspace was ever minted: main holds nothing of the project's to sweep. */
  readonly workspacePath: string | null;
  readonly terminal: Terminal;
}

/** What one terminal sweep recorded, whether or not it ran on a commit. */
interface TerminalSweepRecord {
  readonly projectId: ProjectId;
  readonly terminal: Terminal;
  /** null when the sweep read no main commit. */
  readonly mainCommit: string | null;
  readonly environmentVersion: string | null;
  readonly checkedTasks: readonly string[];
  readonly uncheckedTasks: readonly string[];
  /** Every stored check the sweep could run, with how it ended; none when it ran nothing. */
  readonly checkOutcomes: Extract<Sweep, { readonly kind: "ran" }>["checkOutcomes"];
  readonly details: string;
}

/** The terminal sweep store; the composition root supplies it. */
export interface TerminalSweepStore {
  /** Every stop and open halt episode with no terminal sweep yet, oldest first. */
  dueTerminalSweeps(): Promise<readonly DueTerminalSweep[]>;
  /** Records the sweep with each guarantee's evidence, together; "already-recorded" when its terminal has one. */
  recordTerminalSweep(sweep: TerminalSweepRecord): Promise<"recorded" | "already-recorded">;
}

interface TerminalSweepDeps {
  readonly terminalSweeps: TerminalSweepStore;
  readonly terminalSweeper: Pick<TaskVerification, "sweepForTerminal">;
  /** Each terminal's own fault is contained to it (containEach). */
  readonly containment: StepContainment;
  readonly logger: Logger;
}

function terminalId(terminal: Terminal): string {
  return terminal.kind === "stop" ? `stop ${terminal.stopId}` : `halt ${terminal.blockId}`;
}

/** The record of a sweep that ran on no commit's checks: nothing checked, and why. */
function unswept(due: DueTerminalSweep, mainCommit: string | null, details: string): TerminalSweepRecord {
  return { projectId: due.projectId, terminal: due.terminal, mainCommit, environmentVersion: null, checkedTasks: [], uncheckedTasks: [], checkOutcomes: [], details };
}

/** The record of one due terminal's sweep, run when its project has a workspace. */
async function sweepOf(deps: TerminalSweepDeps, due: DueTerminalSweep): Promise<TerminalSweepRecord> {
  if (due.workspacePath === null) {
    return unswept(due, null, "No terminal sweep ran: the project never had a workspace, so main holds nothing of its work to check.");
  }
  const sweep = await deps.terminalSweeper.sweepForTerminal(due.projectId, due.workspacePath);
  switch (sweep.kind) {
    case "ran":
      return {
        projectId: due.projectId,
        terminal: due.terminal,
        mainCommit: sweep.mainCommit,
        environmentVersion: sweep.environmentVersion,
        checkedTasks: sweep.checkedTasks,
        uncheckedTasks: sweep.uncheckedTasks,
        checkOutcomes: sweep.checkOutcomes,
        details: sweep.details,
      };
    case "unrunnable":
      return unswept(due, null, `No terminal sweep ran: Ashara's execution substrate did not answer: ${describeErrorChain(sweep.error)}`);
    case "faulted":
      return unswept(due, sweep.mainCommit, `No terminal sweep ran: ${describeErrorChain(sweep.error)}`);
  }
}

/**
 * Runs and records the terminal sweep of every due stop and halt episode, each contained to its
 * terminal (containEach); returns how many were recorded.
 */
export async function runTerminalSweeps(deps: TerminalSweepDeps): Promise<number> {
  const due = await deps.terminalSweeps.dueTerminalSweeps();
  const outcomes = await containEach(
    deps.containment,
    "terminal-sweep",
    due,
    (each) => ({ id: terminalId(each.terminal), projectId: each.projectId }),
    async (each) => {
      const record = await sweepOf(deps, each);
      const outcome = await deps.terminalSweeps.recordTerminalSweep(record);
      deps.logger.info("delivery.terminal-sweep", `terminal sweep for ${terminalId(each.terminal)} on main ${record.mainCommit ?? "(none)"}: ${outcome}`, {
        projectId: each.projectId,
        mainCommit: record.mainCommit,
        checks: record.checkOutcomes.length,
        outcome,
      });
      return outcome;
    },
  );
  return outcomes.filter((outcome) => outcome === "recorded").length;
}
