/**
 * The wall bound a test run of a given selection gets.
 *
 * The bound is derived from the files a run selects, never fixed: a fixed bound on a growing suite
 * either cuts a correct whole-suite run short or is so loose it bounds no small one. Each file is
 * budgeted by its class (the podman project's files, the simulator's, every other), at the class's
 * measured per-file wall times, heaviest first: a selection of k files of a class is budgeted the
 * sum of the k heaviest, each file past the measured list at the mean of the rest, so a selection
 * of the slow files of a class is never budgeted as an average one. vitest runs its sequence groups
 * one after the other, each on the workers vitest resolves for it (its projects' own maxWorkers, else
 * the run's), so a group's wall is at most its files' sum over its workers plus its longest file
 * (list scheduling leaves no worker idle while a file waits); the bound is the run's fixed overhead
 * plus BOUND_MARGIN times the sum of the groups' walls.
 *
 * Every per-file figure is the larger of two whole-suite runs' measured wall times for that rank,
 * one at 2 workers and one at 3, under MemoryMax=8G CPUQuota=400%; a figure a class outgrows shows
 * as a run cut off at its bound naming the files it did not finish, never as a pass.
 */

class TestRunBudgetError extends Error {
  constructor(
    readonly subject: string,
    readonly reason: string,
  ) {
    super(`test-run-budget: ${subject}: ${reason}`);
    this.name = "TestRunBudgetError";
  }
}

/** The simulator's directory: its test files each run seeded scenarios end to end. */
export const SIMULATOR_DIR = "packages/integration/src/simulator/";

/**
 * A test file as a run selects it: its path from the root, the vitest project that runs it, and the
 * sequence group that project runs in with the workers vitest resolves for that group.
 */
export interface SuiteFile {
  readonly path: string;
  readonly project: string;
  readonly group: number;
  readonly workers: number;
}

interface ClassBudget {
  /** The class's heaviest measured per-file wall times, in seconds, heaviest first. */
  readonly heaviestS: readonly number[];
  /** The mean measured wall time of the class's files past that list, in seconds. */
  readonly restMeanS: number;
}

type FileClass = "podman" | "simulator" | "other";

/**
 * The whole suite as the class budgets were measured on: its test files and the larger of the two
 * runs' sums of their wall times, so its mean is the measured per-file budget.
 * @testseam affected-tests.test.ts holds a whole-suite bound to it
 */
export const MEASURED_SUITE = { files: 327, fileWallS: 2741 } as const;

const CLASS_BUDGETS: Readonly<Record<FileClass, ClassBudget>> = {
  podman: { heaviestS: [128, 96, 79, 53, 38, 31, 30, 10, 8, 4], restMeanS: 1.6 },
  simulator: { heaviestS: [146, 145, 123, 121, 119, 116, 112, 99, 96, 91], restMeanS: 18.9 },
  other: { heaviestS: [127, 69, 27, 24, 19, 15, 14, 14, 13, 11], restMeanS: 0.9 },
};

/**
 * What every run spends outside its test files, in seconds: globalSetup's guards and migration, and
 * at its end the teardown, which vitest gives up to 150 s (vitest.config.mts teardownTimeout).
 */
const RUN_OVERHEAD_S = 240;
/**
 * How far past its derived wall a correct run may go before its bound cuts it off.
 * @testseam affected-tests.test.ts holds a whole-suite bound to it
 */
export const BOUND_MARGIN = 1.25;

function classOf(file: SuiteFile): FileClass {
  if (file.project === "podman") return "podman";
  return file.path.startsWith(SIMULATOR_DIR) ? "simulator" : "other";
}

/** The budget of `count` files of `budget`'s class: the heaviest `count` measured, each past the list at the rest's mean. */
function classSum(budget: ClassBudget, count: number): number {
  const listed = budget.heaviestS.slice(0, count).reduce((sum, seconds) => sum + seconds, 0);
  return listed + Math.max(0, count - budget.heaviestS.length) * budget.restMeanS;
}

/** A group's wall at `workers`: its files' budgets over the workers, plus its longest file. */
function groupWall(files: readonly SuiteFile[], workers: number): number {
  if (files.length === 0) return 0;
  let sum = 0;
  let longest = 0;
  for (const fileClass of new Set(files.map(classOf))) {
    const budget = CLASS_BUDGETS[fileClass];
    sum += classSum(budget, files.filter((file) => classOf(file) === fileClass).length);
    longest = Math.max(longest, budget.heaviestS[0] ?? budget.restMeanS);
  }
  return sum / Math.min(workers, files.length) + longest;
}

/** The wall bound of one run and how it was derived, for the line that announces it and the failure that names it. */
export interface RunBound {
  readonly seconds: number;
  readonly rule: string;
}

/** The files of each sequence group of `files`, in vitest's order, with the one worker count vitest runs the group on. */
function sequenceGroups(files: readonly SuiteFile[]): { readonly order: number; readonly workers: number; readonly files: readonly SuiteFile[] }[] {
  const groups = new Map<number, SuiteFile[]>();
  for (const file of files) {
    if (!Number.isInteger(file.workers) || file.workers < 1) throw new TestRunBudgetError(file.path, `${file.workers} is not a whole number of workers`);
    const members = groups.get(file.group);
    if (members === undefined) groups.set(file.group, [file]);
    else members.push(file);
  }
  return [...groups].sort(([a], [b]) => a - b).map(([order, members]) => {
    const workers = new Set(members.map((file) => file.workers));
    const [only] = workers;
    // vitest refuses projects of one group with different maxWorkers, so a mixed group is a misread run.
    if (only === undefined || workers.size !== 1) throw new TestRunBudgetError(`sequence group ${order}`, `its files run on ${[...workers].join(", ")} workers; vitest runs a group on one count`);
    return { order, workers: only, files: members };
  });
}

/** The wall bound of a run of `files`, each group of them at the workers vitest runs it on. */
export function runBound(files: readonly SuiteFile[]): RunBound {
  if (files.length === 0) throw new TestRunBudgetError("files", "a run of no test file has no bound to derive");
  const groups = sequenceGroups(files);
  const wall = groups.reduce((sum, group) => sum + groupWall(group.files, group.workers), 0);
  const seconds = Math.ceil(RUN_OVERHEAD_S + BOUND_MARGIN * wall);
  const rule =
    `${files.length} test file(s) (${groups.map((group) => `${group.files.length} in group ${group.order} at ${group.workers} worker(s)`).join(", ")}): ` +
    `${RUN_OVERHEAD_S} s overhead + ${BOUND_MARGIN} x ${Math.round(wall)} s of measured per-file wall`;
  return { seconds, rule };
}
