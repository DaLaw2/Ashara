import { sampleCorrection } from "./correction-coverage.js";
import { sampleModelPaths } from "./coverage.js";
import { asharaFaultHaltOf, checkSnapshot, checkTotality, mainFiles, outcomeOf, sourceOf } from "./invariants.js";
import type { Snapshot } from "./invariants.js";
import { readCorrelationRows } from "./log-correlation.js";
import type { Mutation } from "./plants.js";
import { behaviourPath } from "./product.js";
import { checkResidue } from "./residue.js";
import { CORRECTION_BODY, NO_PROGRESS_CYCLES, snapshotsOf } from "./run-cycle-loop.js";
import { ofProject } from "./run-instance.js";
import type { RunState } from "./run-instance.js";
import type { ProcessWide, Provisioned, RunDraws, RunResources, RunWorld } from "./run-setup.js";
import type { RunOptions } from "./run.js";
import { checkLiveness, checkWork, readRequests } from "./termination.js";

/** A query plant matched no query the run sent: the mutation planted nothing, so nothing was tested. */
class PlantInert extends Error {
  constructor(
    readonly seed: number,
    readonly mutation: Mutation,
  ) {
    super(
      `seed ${seed}: the plant of mutation ${mutation} rewrote no query of the run; production no longer ` +
        `sends what it matches`,
    );
    this.name = "PlantInert";
  }
}

/** What the run's end is judged over. */
export interface EndParts {
  readonly options: RunOptions;
  readonly draws: RunDraws;
  readonly world: RunWorld;
  readonly state: RunState;
  readonly provisioned: Provisioned;
  readonly resources: RunResources;
  readonly processWide: ProcessWide;
  /** Whether the cycle loop ended on no progress. */
  readonly noProgress: boolean;
}

/**
 * The run's end, judged on every project's final snapshot: the invariants with the report clause,
 * the residue left, the accepted product, the work bounds, the log correlation and, under the
 * liveness profile, liveness; the run's outcome settled and traced last.
 */
export async function judgeRunEnd(parts: EndParts): Promise<void> {
  const { options, draws, world, state, provisioned, noProgress } = parts;
  const { observer, projectIds, standIns, startedCells } = provisioned;
  if (options.mutation !== undefined && world.queryPlant !== null && state.bites === 0) {
    throw new PlantInert(options.seed, options.mutation);
  }
  const finals = await snapshotsOf(observer, projectIds);
  await sampleModelPaths(state.coverage, observer, projectIds);
  // The correction is the first project's, recorded as the system stored it, never as drawn.
  const [corrected] = projectIds;
  if (draws.correctionDraw !== null && corrected !== undefined) {
    const stored = await sampleCorrection(state.coverage, observer, corrected, draws.correctionDraw, CORRECTION_BODY);
    state.trace.push(stored);
  }
  for (const fallback of standIns.correctionFallbacks()) {
    state.trace.push(`the Liaison stand-in read the client's ${fallback.asked} as add-exclusion: ${fallback.reason}`);
  }
  // The second reading's seam: a first reading answered with no question, which the plant would leave unconfirmed.
  if (standIns.observedIntakes().some((reading) => reading.kind === "reading" && reading.questions === 0)) {
    state.coverage.plants.add("intake-second-reading-dropped");
  }
  const [final] = finals;
  for (const [index, each] of finals.entries()) {
    const halt = asharaFaultHaltOf(each);
    if (halt !== null) state.asharaHalts.push(`project ${index + 1}: ${halt}`);
  }
  // The report clause needs the settle cycles a halt's report is posted on: a run cut off for no
  // progress had none, and may end on a halt begun in its last cycle (I8 judges that run).
  for (const [index, each] of finals.entries()) {
    const judged = checkSnapshot(state.cycles, each, {
      spendCapUsd: draws.capUsd,
      cells: startedCells,
      final: !noProgress,
      reviews: standIns.observedReviews(),
      intakes: standIns.observedIntakes(),
    });
    for (const violation of judged) state.report(ofProject(index, violation));
  }
  const overCommitted = await world.admissions.judge(observer, draws.capUsd, state.cycles);
  if (overCommitted !== null) state.report(overCommitted);
  await judgeResidue(parts, finals);
  const spendHalted = state.outcome.kind === "halted" && state.outcome.cause === "spend_cap";
  // A run that made no progress did not end, whatever its last snapshot shows (a halt it resumes).
  if (noProgress) state.outcome = { kind: "open" };
  else if (state.outcome.kind !== "open" && !spendHalted) state.outcome = outcomeOf(final);
  await judgeProduct(parts, finals);
  // W1 and W4, judged whatever the run ended in: a spend-cap halt is how a runaway loop would
  // otherwise pass (termination.ts).
  for (const { project, violation } of checkWork(state.cycles, world.port, await readRequests(observer, projectIds))) {
    state.report(ofProject(project, violation));
  }
  const rows = await readCorrelationRows(observer);
  for (const violation of world.correlation.verdict(state.cycles, rows, state.dispatches > 0)) state.report(violation);
  if (options.profile === "liveness") {
    for (const [index, each] of finals.entries()) {
      const end = index === 0 || spendHalted ? state.outcome : outcomeOf(each);
      for (const violation of checkLiveness(state.cycles, end, noProgress, options.maxCycles)) {
        state.report(ofProject(index, violation));
      }
    }
  }
  judgeOpen(parts, finals, spendHalted);
  const outcome = state.outcome;
  state.trace.push(`outcome ${outcome.kind}${outcome.kind === "halted" ? ` ${outcome.cause}` : ""}`);
}

async function judgeResidue(parts: EndParts, finals: readonly Snapshot[]): Promise<void> {
  const { state, world, resources, processWide, provisioned } = parts;
  for (const [index, each] of finals.entries()) {
    const host = {
      git: resources.gitBroker.runner,
      workdirBase: processWide.workdir,
      cells: provisioned.podman.liveCells(),
    };
    for (const violation of await checkResidue(state.cycles, each, world.residue.judgeable, host)) {
      state.report(ofProject(index, violation));
    }
  }
}

/** I6, the product clause: an accepted project's main holds every behaviour the client asked for. */
async function judgeProduct(parts: EndParts, finals: readonly Snapshot[]): Promise<void> {
  const { state, draws } = parts;
  for (const [index, each] of finals.entries()) {
    const end = index === 0 ? state.outcome : outcomeOf(each);
    if (end.kind !== "accepted" || each.project.workspacePath === null) continue;
    const files = new Set(await mainFiles(each.project.workspacePath));
    const missing = draws.universe.behaviours.filter((b) => !files.has(behaviourPath(b)));
    if (missing.length > 0) {
      state.report(
        ofProject(index, {
          invariant: "I6",
          step: state.cycles,
          statement: `the project was accepted with behaviour(s) ${missing.join(", ")} absent from main`,
          key: "I6:accepted-missing",
        }),
      );
    }
  }
}

/** I1's open clause: a project that never ended, or a run that made no progress, named with every task still open. */
function judgeOpen(parts: EndParts, finals: readonly Snapshot[], spendHalted: boolean): void {
  const { state, options, noProgress } = parts;
  const open = finals.filter(
    (each, index) =>
      noProgress || (index === 0 ? state.outcome.kind === "open" : !spendHalted && outcomeOf(each).kind === "open"),
  );
  if (open.length === 0) return;
  const stuck = open
    .flatMap((each) => each.items)
    .filter((item) => item.level === "Task" && item.status !== "Completed" && item.status !== "Abandoned")
    .map((item) => {
      const source = sourceOf(item.blockedReason);
      return `"${item.title}" ${item.status}${source === null ? "" : ` (${source})`}`;
    });
  const statement = noProgress
    ? `the project made no progress for ${NO_PROGRESS_CYCLES} fault-free cycles and is neither accepted, ` +
      `halted nor stopped: ${stuck.join(", ")}`
    : `the project did not end within ${options.maxCycles} cycles: ${stuck.join(", ")}`;
  state.replace({ invariant: "I1", step: state.cycles, statement, key: "I1:open" });
  if (!noProgress) return;
  for (const [index, each] of finals.entries()) {
    for (const violation of checkTotality(state.cycles, each, NO_PROGRESS_CYCLES))
      state.replace(ofProject(index, violation));
  }
}
