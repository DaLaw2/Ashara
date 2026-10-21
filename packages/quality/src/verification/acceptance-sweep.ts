import { join } from "node:path";
import type { CurrentEnvironment, EnvironmentImages } from "@ashara/execution-infra";
import { checkoutsRoot, resolveCurrentEnvironment, targetRepo } from "@ashara/execution-infra";
import type { ProjectId } from "@ashara/shared";
import { describeErrorChain } from "@ashara/shared";
import { createSessionId } from "@ashara/workplace";
import { checkPassed } from "../check-verdict.js";
import type { ExecutionEventSink, VerificationCells } from "../dispatch-result.js";
import type { EnvironmentStatementStore } from "../environment-check.js";
import { readEnvironmentDefinition } from "../environment-definition.js";
import type { EnvironmentDefinition } from "../environment-definition.js";
import { environmentErrorOf } from "../fault-class.js";
import type { EnvironmentError } from "../fault-class.js";
import { interfaceDefectLine, interfaceStandingOnMain, PUBLIC_INTERFACE_FILE } from "../public-interface.js";
import type { InterfaceStanding, ScaffoldMerge } from "../public-interface.js";
import { mainCommit, runSuitesOnCheckout } from "../task-checks.js";
import type { CheckCells, CheckSuite, SuiteRun, TaskCheckStore } from "../task-checks.js";
import type { CellTeardown } from "./cell-teardown.js";
import { RED_RUN_ROLE } from "./dispatch-cells.js";
import { suitesVerdict } from "./suites-verdict.js";

/**
 * An acceptance sweep on main HEAD (AcceptanceSweeper.sweepForAcceptance): `ran` with its verdict
 * and the run as the verdict states it, `environmentVersion` null when main defines no environment
 * its cells can be built from; `unrunnable`, nothing decided, when the substrate failed under it
 * (its probe failed, or an EnvironmentError stopped a stage); or `faulted`, nothing decided, when
 * anything else stopped it (Z0's git or checkout machinery, a store, a bug): not the machines, so
 * never reported as the machines. `mainCommit` of a fault is null when main could not be read.
 */
export type AcceptanceSweep =
  | {
      readonly kind: "ran";
      readonly passed: boolean;
      readonly mainCommit: string;
      readonly environmentVersion: string | null;
      /** Completed implementation tasks whose latest stored checks ran. */
      readonly checkedTasks: readonly string[];
      /** Completed implementation tasks with no stored check: nothing of theirs ran, so they are not checked. */
      readonly uncheckedTasks: readonly string[];
      /** The public interface file on main against the product scaffold's: a scaffold's byte for byte, or none, is not accepted. */
      readonly publicInterface: InterfaceStanding;
      /**
       * Every stored check of the checked tasks with how it ended on main, passed, failed or not
       * run, task by task in the order run: the evidence each guarantee the checks decide is
       * recorded with. The passed ones are the only ways of running the product the sweep saw work
       * (the public interface file's entries are never run).
       */
      readonly checkOutcomes: readonly SweptCheck[];
      /** Every stored check this sweep ran that failed on main, in the order run: the witnesses a failed sweep rests on. */
      readonly failedChecks: readonly FailedCheck[];
      readonly details: string;
    }
  | { readonly kind: "unrunnable"; readonly error: EnvironmentError }
  | { readonly kind: "faulted"; readonly mainCommit: string | null; readonly error: AcceptanceSweepFault };

/**
 * One stored check of a sweep: whose it is (its task's checks revision, by name), the command it
 * runs, the vision items it decides (null on a check stored before they were recorded, which
 * decides none), and how it ended. "not-run" when its suite reached no verdict (its files
 * refused, or the product changed under it) or never reached it: nothing it ran there is a
 * witness either way.
 */
export interface SweptCheck {
  readonly taskId: string;
  readonly revision: number;
  readonly checkTaskId: string;
  readonly name: string;
  readonly command: string;
  readonly decides: readonly string[] | null;
  readonly outcome: "passed" | "failed" | "not-run";
}

/** One stored check an acceptance sweep ran and saw fail: whose it is, and the check task that wrote it. */
export interface FailedCheck {
  readonly taskId: string;
  readonly checkTaskId: string;
  readonly name: string;
}

/**
 * Each task's stored checks that ran in `runs` and failed, in run order. A suite that reached no
 * verdict (its files refused, or the product changed under it) holds no failed check: nothing it ran was a witness.
 */
function failedChecksOf(stored: ReadonlyArray<{ readonly taskId: string; readonly checkTaskId: string; readonly suite: CheckSuite }>, runs: readonly SuiteRun[]): FailedCheck[] {
  return stored.flatMap(({ taskId, checkTaskId, suite }) => {
    const report = runs.find((run) => run.suite === suite)?.report;
    if (report?.kind !== "ran") return [];
    return report.runs.filter((run) => !checkPassed(run)).map((run) => ({ taskId, checkTaskId, name: run.name }));
  });
}

/** Every stored check of each task in `stored`, with how it ended in `runs`; one its suite's report does not name as run is not run. */
function checkOutcomesOf(stored: readonly StoredSuite[], runs: readonly SuiteRun[]): SweptCheck[] {
  return stored.flatMap(({ taskId, revision, checkTaskId, checks, suite }) => {
    const report = runs.find((run) => run.suite === suite)?.report;
    return checks.map((check): SweptCheck => {
      const run = report?.kind === "ran" ? report.runs.find((each) => each.name === check.name) : undefined;
      const outcome = run === undefined ? "not-run" : checkPassed(run) ? "passed" : "failed";
      return { taskId, revision, checkTaskId, name: check.name, command: check.command, decides: check.decides, outcome };
    });
  });
}

/** A completed task's latest stored checks as one suite of a sweep, each check with what it decides. */
interface StoredSuite {
  readonly taskId: string;
  readonly revision: number;
  readonly checkTaskId: string;
  readonly checks: ReadonlyArray<{ readonly name: string; readonly command: string; readonly decides: readonly string[] | null }>;
  readonly suite: CheckSuite;
}

/** A step of an acceptance sweep failed on something other than the substrate: no verdict exists. */
class AcceptanceSweepFault extends Error {
  constructor(
    readonly projectId: ProjectId,
    /** What Z0 was doing when it failed, e.g. "read main". */
    readonly step: string,
    options: { readonly cause: unknown },
  ) {
    super(`the acceptance sweep of project ${projectId} could not run: ${step} failed: ${describeErrorChain(options.cause)}`, { cause: options.cause });
    this.name = "AcceptanceSweepFault";
  }
}

/** Sees every acceptance sweep's result as production returns it; null in production. */
let sweepObserver: ((sweep: AcceptanceSweep) => void) | null = null;

/** The sweep's result, handed to the installed observer first. */
function observed(sweep: AcceptanceSweep): AcceptanceSweep {
  sweepObserver?.(sweep);
  return sweep;
}

/**
 * Installs `next` for the process: it is handed every acceptance sweep's result (the lifecycle
 * simulator counts their kinds). Returns what puts the previous observer back.
 */
export function observeAcceptanceSweeps(next: (sweep: AcceptanceSweep) => void): () => void {
  const previous = sweepObserver;
  sweepObserver = next;
  return () => {
    sweepObserver = previous;
  };
}

/** What a sweep of main reaches: the substrate's cells, main's environment, the stored checks of the completed tasks. */
export interface MainSweepDeps {
  readonly config: { readonly workdirBase: string };
  readonly cells: VerificationCells;
  readonly attemptPolicy: { readonly perCommandTimeoutSeconds: number };
  readonly environment: {
    readonly images: EnvironmentImages;
    readonly statements: EnvironmentStatementStore;
  };
  readonly checks: Pick<TaskCheckStore, "completedOf">;
  readonly teardown: Pick<CellTeardown, "teardownCell">;
  readonly eventSink?: ExecutionEventSink;
}

/** What a sweep is judged for acceptance against; null judges no acceptance. */
type AcceptanceTerms = { readonly goalTaskIds: readonly string[]; readonly scaffolds: readonly ScaffoldMerge[] } | null;

/** A sweep of main, judged for acceptance against `acceptance`, or for no verdict when null. */
export async function sweepMain(deps: MainSweepDeps, projectId: ProjectId, targetProjectPath: string, acceptance: AcceptanceTerms): Promise<AcceptanceSweep> {
  const label = `acceptance-${projectId}`;
  let step = "probe the substrate";
  let main: string | null = null;
  try {
    await deps.cells.substrate.probeSubstrate();
    step = "read main";
    main = await mainCommit(targetProjectPath, label);
    return await runSweep(deps, projectId, targetProjectPath, acceptance, main, (next) => {
      step = next;
    });
  } catch (e) {
    const substrate = environmentErrorOf(e);
    if (substrate !== null) return { kind: "unrunnable", error: substrate };
    return { kind: "faulted", mainCommit: main, error: new AcceptanceSweepFault(projectId, step, { cause: e }) };
  }
}

/** The sweep once the substrate answered and main was read; `at` names each step, for a fault. */
async function runSweep(
  deps: MainSweepDeps,
  projectId: ProjectId,
  targetProjectPath: string,
  acceptance: AcceptanceTerms,
  main: string,
  at: (step: string) => void,
): Promise<AcceptanceSweep> {
  const { cells, eventSink } = deps;
  const label = `acceptance-${projectId}`;
  at("resolve main's environment");
  const resolution = await resolveCurrentEnvironment(projectId, targetRepo(targetProjectPath), deps.environment.images, deps.environment.statements, readEnvironmentDefinition);
  if (resolution.kind === "undefined") {
    return {
      kind: "ran",
      passed: false,
      mainCommit: main,
      environmentVersion: null,
      checkedTasks: [],
      uncheckedTasks: [],
      publicInterface: { kind: "not-compared" },
      checkOutcomes: [],
      failedChecks: [],
      details: `no environment its cells can be built from: ${resolution.reason}`,
    };
  }
  const environment: CurrentEnvironment<EnvironmentDefinition> = resolution.environment;
  let publicInterface: InterfaceStanding = { kind: "not-compared" };
  if (acceptance !== null) {
    at(`compare ${PUBLIC_INTERFACE_FILE} on main with the product scaffold's`);
    publicInterface = await interfaceStandingOnMain(targetProjectPath, main, acceptance.scaffolds);
  }
  at("read the stored checks of the completed tasks");
  const completed = await deps.checks.completedOf(projectId, null);
  const checkedIds = new Set(completed.checked.map((prior) => prior.taskId));
  const neverChecked = acceptance === null ? [] : acceptance.goalTaskIds.filter((id) => !checkedIds.has(id));
  const stored: StoredSuite[] = completed.checked.map((prior) => ({
    taskId: prior.taskId,
    revision: prior.revision,
    checkTaskId: prior.checkTaskId,
    checks: prior.checks,
    suite: {
      label: `task ${prior.taskId}'s checks revision ${prior.revision} (check task ${prior.checkTaskId})`,
      checks: prior.checks,
      files: prior.files,
    },
  }));
  const suites: CheckSuite[] = [
    { label: `the environment's test (version ${environment.version})`, checks: [{ name: "environment test", command: environment.definition.test }], files: [] },
    ...stored.map((each) => each.suite),
  ];
  at("run the suites on a checkout of main");
  const checkCells: CheckCells = {
    targetProjectPath,
    createCell: ({ image, role, hostPath }) =>
      cells.substrate.createCell({ image, project: projectId, task: label, role, instance: cells.instance, mount: { hostPath, shared: true } }),
    teardownCell: (cell) => deps.teardown.teardownCell({ projectId }, cell),
    timeoutSeconds: deps.attemptPolicy.perCommandTimeoutSeconds,
  };
  const dir = join(checkoutsRoot(deps.config.workdirBase), `acceptance-${projectId}-${createSessionId()}`);
  const runs: readonly SuiteRun[] = await runSuitesOnCheckout(checkCells, RED_RUN_ROLE, environment.imageId, main, dir, suites);
  const ran = suitesVerdict(suites, runs, completed.checked.length, "main");
  const gaps = [
    ...(neverChecked.length === 0 ? [] : [`Goal task(s) with no stored checks, so never checked: ${neverChecked.join(", ")}`]),
    ...(completed.unchecked.length === 0 ? [] : [`Not re-run, no check is stored for them: ${completed.unchecked.join(", ")}`]),
  ];
  const interfaceDefect = publicInterface.kind === "not-compared" ? null : interfaceDefectLine(publicInterface);
  const passed = ran.passed && neverChecked.length === 0 && interfaceDefect === null;
  // The interface line comes first: a repair reads the start of these details when they are long.
  const details = [...(interfaceDefect === null ? [] : [interfaceDefect]), ran.details, ...gaps].join("\n");
  const checkedTasks = completed.checked.map((prior) => prior.taskId);
  if (acceptance !== null) {
    eventSink?.emit({
      event: "acceptance_sweep",
      projectId,
      mainCommit: main,
      verdict: passed ? "passed" : "failed",
      checkedTasks,
      neverChecked,
      details,
    });
  }
  return {
    kind: "ran",
    passed,
    mainCommit: main,
    environmentVersion: environment.version,
    checkedTasks,
    uncheckedTasks: completed.unchecked,
    publicInterface,
    checkOutcomes: checkOutcomesOf(stored, runs),
    failedChecks: failedChecksOf(stored, runs),
    details,
  };
}

/** Z0's acceptance sweep of a project on main HEAD; no model is called. */
export class AcceptanceSweeper {
  private readonly deps: MainSweepDeps;

  constructor(deps: MainSweepDeps) {
    this.deps = deps;
  }

  /**
   * The acceptance sweep: once every task of a
   * project's plan is settled with its goal tasks done, Z0 runs, on main HEAD in one CI cell from
   * main's environment image, the environment's test and the latest checks of every Completed
   * implementation task (the regression suite), each suite's files written over the checkout, with
   * no model called. Passed only when every suite ran every check and each passed, and every goal
   * task in `goalTaskIds` has checks stored: a goal never checked is not accepted on its word.
   * Completed tasks with no stored check are named apart (`uncheckedTasks`), never counted as
   * passed. A main whose public interface file is byte for byte the one a product scaffold in
   * `scaffolds` wrote, or that holds no such file, fails the sweep, its details opening with what to
   * update or restore. Passing that comparison verifies nothing the file says: the delivered report
   * quotes the file as unverified, and presents as verified only the stored checks this sweep ran
   * and saw pass (`checkOutcomes`). A main with no environment its cells can be built from fails the sweep, with the
   * reason. A sweep that could not run is `unrunnable` only when the substrate failed (its probe, or
   * an EnvironmentError); any other error is `faulted`, with the step it stopped at. The caller
   * bounds both (orchestrator acceptance.ts).
   */
  async sweepForAcceptance(
    projectId: ProjectId,
    targetProjectPath: string,
    goalTaskIds: readonly string[],
    scaffolds: readonly ScaffoldMerge[],
  ): Promise<AcceptanceSweep> {
    return observed(await sweepMain(this.deps, projectId, targetProjectPath, { goalTaskIds, scaffolds }));
  }
}
