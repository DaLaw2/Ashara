import type { Logger, ProjectId, StepContainment } from "@ashara/shared";
import { containEach, describeErrorChain } from "@ashara/shared";
import type { TerminalSweeper } from "./acl/quality-acl.js";
import { INFRASTRUCTURE_FAULT_BUDGET } from "./execution/halt-causes.js";

// A project that reaches a terminal short of acceptance, the client's stop or a halt of any kind (a
// budget stop among them), gets one terminal sweep: the acceptance sweep's commands-only run of
// every stored check on main HEAD, with no model called, so each guarantee's evidence on the last
// commit is on record whatever ended the work. The stop's and the halt's report wait for it: each is
// told only once its terminal's sweep is on record. A sweep that could not run (the substrate not
// answering, any other fault) is counted on its terminal, durably, against the dispatch path's
// INFRASTRUCTURE_FAULT_BUDGET, and retried next cycle, so a transient fault does not cost the report
// its evidence; the fault past the budget is recorded as the terminal's sweep, with no check run, no
// commit and the fault named in why, so its guarantees read as having no sweep on a commit and the
// report is told. A fault in recording the sweep counts the same, and a sweep past the budget whose
// evidence cannot be built is recorded with none, so the report is never left waiting unbounded. A
// project that never had a workspace has nothing on main to sweep: that is recorded at once. A sweep
// the shutdown interrupted is no fault: it escapes to the containment, uncounted, and runs again
// after the restart.

type Sweep = Awaited<ReturnType<TerminalSweeper["sweepForTerminal"]>>;

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
  /** Every stop and halt episode owed a terminal sweep with none recorded yet, oldest first. */
  dueTerminalSweeps(): Promise<readonly DueTerminalSweep[]>;
  /** Records the sweep with each guarantee's evidence, together; "already-recorded" when its terminal has one. */
  recordTerminalSweep(sweep: TerminalSweepRecord): Promise<"recorded" | "already-recorded">;
  /** Records the sweep with no check run and no guarantee evidence, for when its evidence cannot be built; "already-recorded" as above. */
  recordWithoutEvidence(sweep: TerminalSweepRecord): Promise<"recorded" | "already-recorded">;
  /** Counts one sweep of the terminal that could not run, durably; returns the count with it. */
  recordSweepFault(projectId: ProjectId, terminal: Terminal): Promise<number>;
}

interface TerminalSweepDeps {
  readonly terminalSweeps: TerminalSweepStore;
  readonly terminalSweeper: Pick<TerminalSweeper, "sweepForTerminal">;
  /** Each terminal's own fault is contained to it (containEach). */
  readonly containment: StepContainment;
  readonly logger: Logger;
}

function terminalId(terminal: Terminal): string {
  return terminal.kind === "stop" ? `stop ${terminal.stopId}` : `halt ${terminal.blockId}`;
}

/** The record of a sweep that ran no check on any commit: nothing checked, no commit, and why. */
function unswept(due: DueTerminalSweep, details: string): TerminalSweepRecord {
  return { projectId: due.projectId, terminal: due.terminal, mainCommit: null, environmentVersion: null, checkedTasks: [], uncheckedTasks: [], checkOutcomes: [], details };
}

/** What one attempt at a due terminal's sweep came to: a record to write, or a fault that kept it from running. */
type Attempt = { readonly kind: "record"; readonly record: TerminalSweepRecord } | { readonly kind: "fault"; readonly why: string; readonly error: Error };

/** One attempt at a due terminal's sweep, run when its project has a workspace. */
async function attemptOf(deps: TerminalSweepDeps, due: DueTerminalSweep): Promise<Attempt> {
  if (due.workspacePath === null) {
    return { kind: "record", record: unswept(due, "No terminal sweep ran: the project never had a workspace, so main holds nothing of its work to check.") };
  }
  const sweep = await deps.terminalSweeper.sweepForTerminal(due.projectId, due.workspacePath);
  switch (sweep.kind) {
    case "ran":
      return {
        kind: "record",
        record: {
          projectId: due.projectId,
          terminal: due.terminal,
          mainCommit: sweep.mainCommit,
          environmentVersion: sweep.environmentVersion,
          checkedTasks: sweep.checkedTasks,
          uncheckedTasks: sweep.uncheckedTasks,
          checkOutcomes: sweep.checkOutcomes,
          details: sweep.details,
        },
      };
    case "unrunnable":
      return { kind: "fault", why: `Ashara's execution substrate did not answer: ${describeErrorChain(sweep.error)}`, error: sweep.error };
    case "faulted": {
      const read = sweep.mainCommit === null ? "" : ` on main at commit ${sweep.mainCommit}`;
      return { kind: "fault", why: `the sweep faulted${read}: ${describeErrorChain(sweep.error)}`, error: sweep.error };
    }
  }
}

/** What one due terminal's sweep step did: recorded its sweep, found one already recorded, or counted a fault to retry. */
type SweepStep = "recorded" | "already-recorded" | "fault-counted";

/** The error a thrown attempt carries, as an Error, so its chain is logged whole. */
function thrownError(thrown: unknown): Error {
  return thrown instanceof Error ? thrown : new TerminalSweepThrew(thrown);
}

/** An attempt at a terminal sweep threw something that is not an Error. */
class TerminalSweepThrew extends Error {
  constructor(readonly thrown: unknown) {
    super(`the terminal sweep threw a non-Error value: ${String(thrown)}`);
    this.name = "TerminalSweepThrew";
  }
}

/**
 * One attempt at the due terminal's sweep, run and recorded: "recorded" or "already-recorded" when
 * it is on record, or the fault that kept it from running or from being recorded. A fault the
 * containment lets escape (the shutdown) is thrown, uncounted.
 */
async function attemptAndRecord(deps: TerminalSweepDeps, due: DueTerminalSweep): Promise<"recorded" | "already-recorded" | Extract<Attempt, { readonly kind: "fault" }>> {
  try {
    const attempt = await attemptOf(deps, due);
    if (attempt.kind === "fault") return attempt;
    return await deps.terminalSweeps.recordTerminalSweep(attempt.record);
  } catch (thrown) {
    if (deps.containment.escapes(thrown)) throw thrown;
    const error = thrownError(thrown);
    return { kind: "fault", why: `the sweep or its recording threw: ${describeErrorChain(error)}`, error };
  }
}

/**
 * Records the sweep of a terminal whose retries are exhausted, with no check run, naming the fault:
 * with every guarantee's evidence when the guarantees in force read, and with none when even that
 * record cannot be built, so the report is told on what the records hold rather than never.
 */
async function recordExhausted(deps: TerminalSweepDeps, due: DueTerminalSweep, details: string): Promise<"recorded" | "already-recorded"> {
  const record = unswept(due, details);
  try {
    return await deps.terminalSweeps.recordTerminalSweep(record);
  } catch (thrown) {
    if (deps.containment.escapes(thrown)) throw thrown;
    deps.logger.error(
      "delivery.terminal-sweep-unevidenced",
      `terminal sweep for ${terminalId(due.terminal)}: its evidence could not be recorded, so it is recorded with none`,
      { projectId: due.projectId },
      thrownError(thrown),
    );
    return deps.terminalSweeps.recordWithoutEvidence(record);
  }
}

/**
 * The due terminal's sweep step: its sweep recorded when it ran, or when the project had no
 * workspace; a fault of the sweep or of its recording counted and left for the next cycle's retry
 * while within the budget, and recorded as the sweep, naming the fault, once past it.
 */
async function sweepStep(deps: TerminalSweepDeps, due: DueTerminalSweep): Promise<SweepStep> {
  const attempt = await attemptAndRecord(deps, due);
  if (attempt === "recorded" || attempt === "already-recorded") return attempt;
  const faults = await deps.terminalSweeps.recordSweepFault(due.projectId, due.terminal);
  const context = { projectId: due.projectId, faults, budget: INFRASTRUCTURE_FAULT_BUDGET };
  if (faults <= INFRASTRUCTURE_FAULT_BUDGET) {
    deps.logger.warn(
      "delivery.terminal-sweep-fault",
      `terminal sweep for ${terminalId(due.terminal)} could not run (fault ${faults} of ${INFRASTRUCTURE_FAULT_BUDGET}); retried next cycle: ${attempt.why}`,
      context,
      attempt.error,
    );
    return "fault-counted";
  }
  deps.logger.error(
    "delivery.terminal-sweep-exhausted",
    `terminal sweep for ${terminalId(due.terminal)} could not run in ${faults} attempts; recorded with no check run: ${attempt.why}`,
    context,
    attempt.error,
  );
  return recordExhausted(deps, due, `No terminal sweep ran: it could not run in ${faults} attempts, the last because ${attempt.why}`);
}

/**
 * Runs the terminal sweep step of every due stop and halt episode, each contained to its terminal
 * (containEach); returns how many sweeps were recorded.
 */
export async function runTerminalSweeps(deps: TerminalSweepDeps): Promise<number> {
  const due = await deps.terminalSweeps.dueTerminalSweeps();
  const outcomes = await containEach(
    deps.containment,
    "terminal-sweep",
    due,
    (each) => ({ id: terminalId(each.terminal), projectId: each.projectId }),
    async (each) => {
      const outcome = await sweepStep(deps, each);
      deps.logger.info("delivery.terminal-sweep", `terminal sweep for ${terminalId(each.terminal)}: ${outcome}`, { projectId: each.projectId, outcome });
      return outcome;
    },
  );
  return outcomes.filter((outcome) => outcome === "recorded").length;
}
