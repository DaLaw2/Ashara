/**
 * The wall bound a test run of a given selection gets.
 *
 * The bound is derived from the files a run selects, never fixed: a fixed bound on a growing suite
 * either cuts a correct whole-suite run short or is so loose it bounds no small one. Each file is
 * budgeted by its class (the podman project's files, the simulator's, every other), at the class's
 * measured per-file wall times, heaviest first: a selection of k files of a class is budgeted the
 * sum of the k heaviest, each file past the measured list at the mean of the rest, so a selection
 * of the slow files of a class is never budgeted as an average one. vitest runs its sequence groups
 * one after the other, each on the workers vitest resolves for it (a project's own maxWorkers, held
 * under the run's by vitest.config.mts, else the run's), so a group's wall is at most its files' sum
 * over its workers plus its longest file (list scheduling leaves no worker idle while a file waits);
 * the bound is the run's fixed overhead plus BOUND_MARGIN times the sum of the groups' walls.
 *
 * A per-file wall time is a property of the host that ran the file as much as of the file: the same
 * suite takes different times on hosts of different cores, disks and contention. So the figures are
 * kept per host (BUDGET_PROFILES), each measured on the host that enforces the bounds derived from
 * it, and every run names the profile of its host. A figure a class outgrows shows as a run cut off
 * at its bound naming the files it did not finish, never as a pass.
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

export type FileClass = "podman" | "simulator" | "other";

/** The per-file figures measured on one host, with the suite and the worker counts they were measured at. */
interface BudgetProfile {
  /** The host the figures were measured on, and what each figure counts. */
  readonly measuredOn: string;
  /** The workers of the whole-suite runs measured; each figure is the larger of those runs' for its rank. */
  readonly workers: readonly number[];
  /** The suite as measured: its test files and the sum of their wall times, so its mean is the measured per-file budget. */
  readonly suite: { readonly files: number; readonly fileWallS: number };
  readonly classes: Readonly<Record<FileClass, ClassBudget>>;
}

/**
 * The per-file figures of each host a bounded run is enforced on. `scripts/test-run-profile.ts`
 * derives a profile's classes from the per-file wall times a run on that host records.
 */
export const BUDGET_PROFILES = {
  dev: {
    measuredOn: "the development host, each file's wall time, under MemoryMax=8G CPUQuota=400%",
    workers: [2, 3],
    suite: { files: 327, fileWallS: 2741 },
    classes: {
      podman: { heaviestS: [128, 96, 79, 53, 38, 31, 30, 10, 8, 4], restMeanS: 1.6 },
      simulator: { heaviestS: [146, 145, 123, 121, 119, 116, 112, 99, 96, 91], restMeanS: 18.9 },
      other: { heaviestS: [127, 69, 27, 24, 19, 15, 14, 14, 13, 11], restMeanS: 0.9 },
    },
  },
  ci: {
    measuredOn:
      "CI's ubuntu-24.04 runner, each file's test time as vitest's default reporter logs it plus an equal share of the run's import and transform time",
    workers: [4],
    suite: { files: 327, fileWallS: 2394 },
    classes: {
      podman: { heaviestS: [100.9, 88.3, 67.5, 38.1, 22.9, 22.6, 19.9, 7.8, 6, 4.5], restMeanS: 2.2 },
      simulator: { heaviestS: [91.2, 79.5, 69, 67.3, 60.4, 59.8, 58.5, 56.3, 56.1, 52.6], restMeanS: 15.2 },
      other: { heaviestS: [160.2, 55.7, 36.8, 33.5, 23, 22.9, 18.9, 16.8, 12.1, 12], restMeanS: 2 },
    },
  },
} as const satisfies Readonly<Record<string, BudgetProfile>>;

/** The name of a host whose per-file figures BUDGET_PROFILES holds. */
export type BudgetProfileName = keyof typeof BUDGET_PROFILES;

/** Whether `name` names a host whose per-file figures BUDGET_PROFILES holds. */
export function isBudgetProfileName(name: string): name is BudgetProfileName {
  return Object.hasOwn(BUDGET_PROFILES, name);
}

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

/** The class a test file is budgeted by. */
export function classOf(file: { readonly path: string; readonly project: string }): FileClass {
  if (file.project === "podman") return "podman";
  return file.path.startsWith(SIMULATOR_DIR) ? "simulator" : "other";
}

/** The budget of `count` files of `budget`'s class: the heaviest `count` measured, each past the list at the rest's mean. */
function classSum(budget: ClassBudget, count: number): number {
  const listed = budget.heaviestS.slice(0, count).reduce((sum, seconds) => sum + seconds, 0);
  return listed + Math.max(0, count - budget.heaviestS.length) * budget.restMeanS;
}

/** A group's wall at `workers` on `profile`'s host: its files' budgets over the workers, plus its longest file. */
function groupWall(profile: BudgetProfile, files: readonly SuiteFile[], workers: number): number {
  if (files.length === 0) return 0;
  let sum = 0;
  let longest = 0;
  for (const fileClass of new Set(files.map(classOf))) {
    const budget = profile.classes[fileClass];
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

/** The wall bound of a run of `files` on the host `profileName` names, each group of them at the workers vitest runs it on. */
export function runBound(files: readonly SuiteFile[], profileName: BudgetProfileName): RunBound {
  if (files.length === 0) throw new TestRunBudgetError("files", "a run of no test file has no bound to derive");
  const profile: BudgetProfile = BUDGET_PROFILES[profileName];
  const groups = sequenceGroups(files);
  const wall = groups.reduce((sum, group) => sum + groupWall(profile, group.files, group.workers), 0);
  const seconds = Math.ceil(RUN_OVERHEAD_S + BOUND_MARGIN * wall);
  const rule =
    `${files.length} test file(s) (${groups.map((group) => `${group.files.length} in group ${group.order} at ${group.workers} worker(s)`).join(", ")}): ` +
    `${RUN_OVERHEAD_S} s overhead + ${BOUND_MARGIN} x ${Math.round(wall)} s of per-file wall measured on the ${profileName} host`;
  return { seconds, rule };
}
