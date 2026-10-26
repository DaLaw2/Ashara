/**
 * A vitest run under a wall bound derived from the test files it runs and the workers it runs them
 * on (test-run-budget.ts runBound), never a fixed figure. Every test run goes through it: `just test`
 * (the whole suite, or what its vitest arguments filter), scripts/affected-tests.ts (a selection) and
 * CI. The files and each group's workers are vitest's own answer for the run's arguments (planRun),
 * so a filter, a project, `--maxWorkers=50%` and a project's own maxWorkers count as vitest counts them.
 *
 * Usage: npx tsx scripts/test-run.ts --profile=<host> [--within=<seconds>] [--durations=<file>] [-- <vitest run args>]
 *
 * --profile names the host whose measured per-file figures the bound is derived from
 * (test-run-budget.ts BUDGET_PROFILES): the host the run runs on, since a figure measured on one
 * host bounds nothing on another. --within is the time the caller itself gives the run: a run whose
 * bound and SIGKILL grace do not fit in it stops before any test, naming both, rather than be cut
 * off by its caller with no file named. --durations appends each test file's wall time to <file>
 * as it ends, the measurement a profile is derived from (test-run-profile.ts).
 *
 * vitest runs in a process group of its own, so the bound reaches its forks workers: past the bound
 * the group gets SIGTERM, which the cell-leak guard (vitest.config.mts globalSetup) answers by
 * removing the run's cells before vitest exits, and SIGKILL only if it is still alive KILL_GRACE_MS
 * later. That grace outlasts the guard's signal-time removal at its worst, one podman listing and
 * one podman rm, each bounded by cell-leak-guard.ts PODMAN_TIMEOUT_MS. A run its bound cuts off
 * exits 124 naming the bound, how it was derived and every test file that did not finish (a
 * progress reporter records each file as it ends), never 0. SIGINT, SIGTERM and SIGHUP sent to this
 * process are passed to the group, with the same SIGKILL KILL_GRACE_MS later, so a terminal's Ctrl+C
 * or a caller's timeout still stops the run, and the run fails naming the signal and every file it
 * did not finish. The group's leader stops the group the same way when this process is gone without
 * passing a signal on (a caller's SIGKILL, the OOM killer): its pipe from this process closes, or its
 * parent changes; once its command has exited it names every file the run did not finish, read from
 * the run's expected list and progress file as this process would. Whatever of the group outlives
 * its leader is killed when the leader exits. So no
 * test outlives the run that started it: a test left running past its caller runs against a database
 * its caller may already have dropped.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describeErrorChain } from "@ashara/shared";
import { BUDGET_PROFILES, isBudgetProfileName, runBound, type BudgetProfileName, type RunBound, type SuiteFile } from "./test-run-budget.js";
import { DURATIONS_ENV, PROGRESS_ENV } from "./test-run-progress.js";

class TestRunError extends Error {
  constructor(
    readonly subject: string,
    readonly reason: string,
  ) {
    super(`test-run: ${subject}: ${reason}`);
    this.name = "TestRunError";
  }
}

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const VITEST_BIN = path.resolve(SCRIPTS, "..", "node_modules", "vitest", "vitest.mjs");
const PROGRESS_REPORTER = path.join(SCRIPTS, "test-run-progress.ts");
/**
 * Past the bound, how long the run's group has between SIGTERM and SIGKILL.
 * @testseam test-run.test.ts holds it to the cell-leak guard's podman worst case
 */
export const KILL_GRACE_MS = 150_000;
/** How often a run's group leader checks that the runner that started it is still its parent. */
const PARENT_POLL_MS = 500;
/** The exit status of a run its bound cut off, as timeout(1) gives one. */
const OVERRUN_EXIT = 124;
/**
 * In a run's directory, the file listing the test files the run is expected to finish, one per line.
 * @testseam test-run.test.ts gives a leader it starts itself a run directory
 */
export const RUN_EXPECTED = "expected";
/**
 * In a run's directory, the progress file PROGRESS_ENV names, one finished test file per line.
 * @testseam test-run.test.ts gives a leader it starts itself a run directory
 */
export const RUN_FINISHED = "finished";
/**
 * The leader of a bounded run's process group, plain CommonJS run by `node -e <source> <graceMs>
 * <runDir> <file> <args...>`: it runs the command in its group and exits with its status, 128 plus
 * the signal's number for a command a signal ended. It outlives the signals sent to its group, which
 * reach the command directly, so it is still there to answer the runner's end: when its stdin, a
 * pipe from the runner, closes or its parent is no longer the runner while the command runs, the
 * group gets SIGTERM and, graceMs later, the command gets SIGKILL; once the command has exited, the
 * leader names every file of runDir's RUN_EXPECTED that its RUN_FINISHED does not, removes runDir,
 * which no runner is left to remove, and only then sends SIGKILL to the rest of the group. The parent is read every PARENT_POLL_MS: the pipe alone misses a runner
 * gone while another process still holds the pipe's writing end.
 * @testseam test-run.test.ts starts it under a parent of its own to judge the parent watch
 */
export const LEADER_SOURCE = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const { constants } = require("node:os");
const path = require("node:path");
const [graceMs, runDir, file, ...args] = process.argv.slice(1);
const linesOf = (name) => fs.readFileSync(path.join(runDir, name), "utf-8").split("\\n").filter((line) => line !== "");
const reportUnfinished = () => {
  let expected;
  let finished;
  try {
    expected = linesOf(${JSON.stringify(RUN_EXPECTED)});
    finished = new Set(fs.existsSync(path.join(runDir, ${JSON.stringify(RUN_FINISHED)})) ? linesOf(${JSON.stringify(RUN_FINISHED)}) : []);
  } catch (error) {
    console.error("test-run: which test files the run did not finish is unknown: " + runDir + " could not be read: " + error.message);
    return;
  }
  const unfinished = expected.filter((test) => !finished.has(test));
  console.error(["test-run: " + unfinished.length + " of " + expected.length + " test file(s) did not finish:", ...unfinished.map((test) => "  " + test)].join("\\n"));
  fs.rmSync(runDir, { recursive: true, force: true });
};
const signalGroup = (signal) => {
  try {
    process.kill(0, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
};
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => {});
const child = spawn(file, args, { stdio: ["ignore", "inherit", "inherit"] });
const runner = process.ppid;
let orphaned = false;
child.on("error", (error) => {
  console.error("test-run: " + file + " could not start: " + error.message);
  process.exit(127);
});
child.on("exit", (code, signal) => {
  if (orphaned) {
    reportUnfinished();
    signalGroup("SIGKILL");
  }
  process.exit(code ?? 128 + (constants.signals[signal] ?? 0));
});
const orphan = (why) => {
  if (orphaned) return;
  orphaned = true;
  console.error("test-run: the runner that started this run is gone (" + why + "); its process group is stopped");
  signalGroup("SIGTERM");
  // The grace ends with SIGKILL to the command alone: a SIGKILL to the group would end this leader
  // too, before the command's exit names the unfinished files; the rest of the group gets it then.
  setTimeout(() => child.kill("SIGKILL"), Number(graceMs));
};
process.stdin.on("end", () => orphan("its pipe closed"));
process.stdin.resume();
setInterval(() => {
  if (process.ppid !== runner) orphan("the leader's parent changed");
}, ${PARENT_POLL_MS});
`;

/** A command a bounded run starts in a process group of its own. */
interface Command {
  readonly file: string;
  readonly args: readonly string[];
}

/** What a bounded run hears SIGINT, SIGTERM and SIGHUP from in place of this process: a test's stand-in. */
interface SignalSource {
  on(signal: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): unknown;
  off(signal: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): unknown;
}

/**
 * How a bounded run ended: on its own with its exit status, cut off by its bound, or stopped by a
 * signal passed on to it; the last two with the files it did not finish.
 */
type BoundedExit =
  | { readonly kind: "exited"; readonly exitCode: number }
  | { readonly kind: "overrun"; readonly unfinished: readonly string[] }
  | { readonly kind: "stopped"; readonly signal: NodeJS.Signals; readonly exitCode: number; readonly unfinished: readonly string[] };

/** A bounded run's exit status, and what it says when its bound or a signal stopped it; null when it ended on its own. */
interface BoundedRunResult {
  readonly exitCode: number;
  readonly report: string | null;
}

/** Sends `signal` to the process group `pid` leads and says whether any of the group is left; a group already gone is no failure. */
function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

/** The lines of `file`, none when the run never wrote it. */
function linesOf(file: string): Set<string> {
  if (!fs.existsSync(file)) return new Set();
  return new Set(fs.readFileSync(file, "utf-8").split("\n").filter((line) => line !== ""));
}

/** The exit status of a run a signal stopped: its own when it failed, else the shell's 128 plus the signal's number. */
function stoppedExit(code: number | null, signal: NodeJS.Signals): number {
  if (code !== null && code !== 0) return code;
  return 128 + os.constants.signals[signal];
}

/**
 * Runs `command` in `cwd` under `boundMs`, in a fresh run directory holding `expected` and the
 * progress file PROGRESS_ENV names, which the run appends each finished test file to; past the
 * bound, or on a signal passed on to it, the run's group is stopped and the files of `expected` the
 * progress file does not name are the unfinished ones. `env`, when given, is added to the run's environment.
 */
function runWithin(command: Command, options: { readonly cwd: string; readonly boundMs: number; readonly killGraceMs: number; readonly expected: readonly string[]; readonly signals: SignalSource | undefined; readonly env: Readonly<Record<string, string>> | undefined }): Promise<BoundedExit> {
  const progressDir = fs.mkdtempSync(path.join(os.tmpdir(), "ashara-test-run-"));
  const progress = path.join(progressDir, RUN_FINISHED);
  fs.writeFileSync(path.join(progressDir, RUN_EXPECTED), options.expected.map((file) => `${file}\n`).join(""));
  return new Promise<BoundedExit>((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", LEADER_SOURCE, String(options.killGraceMs), progressDir, command.file, ...command.args], {
      cwd: options.cwd,
      stdio: ["pipe", "inherit", "inherit"],
      detached: true,
      env: { ...process.env, ...options.env, [PROGRESS_ENV]: progress },
    });
    const pid = child.pid;
    let overrun = false;
    let stoppedBy: NodeJS.Signals | null = null;
    let killTimer: NodeJS.Timeout | undefined;
    const forward = (signal: NodeJS.Signals): void => {
      if (pid !== undefined) signalGroup(pid, signal);
    };
    // Every signal that stops the group is followed by SIGKILL, so a group that outlives its SIGTERM
    // still ends.
    const stop = (signal: NodeJS.Signals): void => {
      stoppedBy ??= signal;
      forward(signal);
      killTimer ??= setTimeout(() => forward("SIGKILL"), options.killGraceMs);
    };
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
    const source = options.signals;
    for (const signal of signals) {
      if (source === undefined) process.on(signal, stop);
      else source.on(signal, stop);
    }
    const boundTimer = setTimeout(() => {
      overrun = true;
      stop("SIGTERM");
    }, options.boundMs);
    const settle = (): void => {
      clearTimeout(boundTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      for (const signal of signals) {
        if (source === undefined) process.off(signal, stop);
        else source.off(signal, stop);
      }
    };
    child.on("error", (error) => {
      settle();
      fs.rmSync(progressDir, { recursive: true, force: true });
      reject(new TestRunError(command.file, describeErrorChain(error)));
    });
    child.on("exit", (code, signal) => {
      settle();
      child.stdin?.destroy();
      const finished = linesOf(progress);
      fs.rmSync(progressDir, { recursive: true, force: true });
      // The group's leader is gone, so nothing left of the group belongs to a live run: it is killed
      // however the run ended, and named, so a test that leaves a process behind shows.
      if (pid !== undefined && signalGroup(pid, 0)) {
        console.error(`test-run: processes of the run's group ${pid} outlived its leader; they are killed`);
        forward("SIGKILL");
      }
      const unfinished = options.expected.filter((file) => !finished.has(file));
      if (overrun) {
        resolve({ kind: "overrun", unfinished });
        return;
      }
      if (stoppedBy !== null) {
        resolve({ kind: "stopped", signal: stoppedBy, exitCode: stoppedExit(code, stoppedBy), unfinished });
        return;
      }
      // A run ended by a signal is a failed run, never a pass.
      resolve({ kind: "exited", exitCode: code ?? (signal === null ? 1 : 128) });
    });
  });
}

/** The lines naming each test file of `total` a run did not finish. */
function unfinishedLines(total: number, unfinished: readonly string[]): string[] {
  return [`${unfinished.length} of ${total} test file(s) did not finish:`, ...unfinished.map((file) => `  ${file}`)];
}

/**
 * Runs `command` in `cwd` under `bound`, the test files it runs being `files` (root-relative): its
 * own exit status when it ends within the bound; else OVERRUN_EXIT, or a failing status when a
 * signal passed on to it stopped it, with the report naming why and every file of `files` it did
 * not finish. The signals this process (or `context.signals`, in its place) hears go to the run's
 * group; `context.env` is added to the run's environment.
 * @testseam affected-tests.test.ts and test-run.test.ts drive it with commands of their own
 */
export async function boundedRun(command: Command, cwd: string, bound: RunBound, files: readonly string[], context: { readonly signals?: SignalSource; readonly env?: Readonly<Record<string, string>> } = {}): Promise<BoundedRunResult> {
  const exit = await runWithin(command, { cwd, boundMs: bound.seconds * 1000, killGraceMs: KILL_GRACE_MS, expected: files, signals: context.signals, env: context.env });
  if (exit.kind === "exited") return { exitCode: exit.exitCode, report: null };
  if (exit.kind === "stopped") {
    return { exitCode: exit.exitCode, report: [`test-run: the run was stopped by ${exit.signal};`, ...unfinishedLines(files.length, exit.unfinished)].join("\n") };
  }
  return {
    exitCode: OVERRUN_EXIT,
    report: [`test-run: the run passed its bound of ${bound.seconds} s (${bound.rule}) and was stopped;`, ...unfinishedLines(files.length, exit.unfinished)].join("\n"),
  };
}

/** Whether the vitest arguments name a reporter of their own. */
function namesReporter(args: readonly string[]): boolean {
  return args.some((arg) => arg === "--reporter" || arg.startsWith("--reporter="));
}

/** The test files a run selects, as vitest resolves them, and the bound derived from them. */
interface RunPlan {
  readonly files: readonly SuiteFile[];
  readonly bound: RunBound;
}

/**
 * The workers vitest runs a project's group on, as vitest resolves them for a run: the project's own
 * maxWorkers, else the run's, else one fewer than the host's cores. The run's is the caller's
 * ceiling: vitest itself lets a project's own exceed it, so vitest.config.mts holds each project's
 * under it, and a project read above it is refused rather than budgeted at a count the caller did
 * not allow. vitest's resolved config leaves a maxWorkers no config or argument names unset, its
 * type notwithstanding, so each is read as unknown.
 */
function groupWorkers(projectName: string, project: unknown, run: unknown): number {
  const ceiling = typeof run === "number" && run > 0 ? run : null;
  if (typeof project === "number" && project > 0) {
    if (ceiling !== null && project > ceiling) throw new TestRunError(`project ${projectName}`, `runs on ${project} workers, above the run's ${ceiling}; vitest.config.mts holds a project's own maxWorkers under the run's`);
    return project;
  }
  return ceiling ?? Math.max(os.availableParallelism() - 1, 1);
}

/**
 * What `vitest run <vitestArgs> <targets>` in `root` runs, asked of vitest itself: each test file
 * with its project, the project's sequence group and the workers vitest runs that group on (the
 * project's own maxWorkers, never above the run's, else the run's, a percentage resolved as vitest
 * resolves it), and the bound derived from them on the host `profile` names. `targets` are
 * root-relative test files.
 * @testseam test-run.test.ts and affected-tests.test.ts read the plan of a run without running it
 */
export async function planRun(root: string, targets: readonly string[], vitestArgs: readonly string[], profile: BudgetProfileName): Promise<RunPlan> {
  // Imported where it is used: tsx runs this repo's scripts as CommonJS, and vitest/node is ESM only.
  const { createVitest, parseCLI } = await import("vitest/node");
  const { filter, options } = parseCLI(["vitest", "run", ...vitestArgs, ...targets.map((file) => path.join(root, file))]);
  const vitest = await createVitest("test", { root, ...options, watch: false, run: true, reporters: [] });
  try {
    const specs = await vitest.getRelevantTestSpecifications(filter);
    const files = specs.map((spec): SuiteFile => ({
      path: path.relative(vitest.config.root, spec.moduleId).split(path.sep).join("/"),
      project: spec.project.name,
      group: spec.project.config.sequence.groupOrder,
      workers: groupWorkers(spec.project.name, spec.project.config.maxWorkers, vitest.config.maxWorkers),
    }));
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    if (files.length === 0) throw new TestRunError("selection", `vitest run ${[...vitestArgs, ...targets].join(" ")} selects no test file, so the run has nothing to bound`);
    return { files, bound: runBound(files, profile) };
  } finally {
    await vitest.close();
  }
}

/**
 * How a run is bounded beyond its files: the host whose figures bound it, the time its caller gives
 * it (none when the caller sets no limit of its own), and the file its per-file wall times are
 * appended to (none when the run records none).
 */
interface RunOptions {
  readonly profile: BudgetProfileName;
  readonly withinS?: number;
  readonly durations?: string;
}

/**
 * Runs the test files `targets` (root-relative; none for every file the arguments select) with
 * `vitestArgs`, under the bound derived from what vitest selects for them on the host
 * `options.profile` names; resolves to the run's exit status. A bound that with its SIGKILL grace
 * does not fit in `options.withinS` fails before any test runs.
 */
export async function runTests(root: string, targets: readonly string[], vitestArgs: readonly string[], options: RunOptions): Promise<number> {
  if (!fs.existsSync(VITEST_BIN)) throw new TestRunError("vitest", `${VITEST_BIN} is missing; run npm ci`);
  const plan = await planRun(root, targets, vitestArgs, options.profile);
  const paths = [...new Set(plan.files.map((file) => file.path))];
  console.log(`test-run: ${paths.length} test file(s) selected; bound ${plan.bound.seconds} s (${plan.bound.rule})`);
  const stopsByS = plan.bound.seconds + KILL_GRACE_MS / 1000;
  if (options.withinS !== undefined && stopsByS > options.withinS) {
    throw new TestRunError(
      "bound",
      `the run's bound of ${plan.bound.seconds} s and its ${KILL_GRACE_MS / 1000} s SIGKILL grace exceed the ${options.withinS} s its caller gives it (--within), which would cut the run off naming no unfinished file; no test ran`,
    );
  }
  const reporters = [...(namesReporter(vitestArgs) ? [] : ["--reporter=default"]), `--reporter=${PROGRESS_REPORTER}`];
  const command = { file: process.execPath, args: [VITEST_BIN, "run", ...reporters, ...vitestArgs, ...targets.map((file) => path.join(root, file))] };
  const env: Record<string, string> = options.durations === undefined ? {} : { [DURATIONS_ENV]: path.resolve(root, options.durations) };
  const result = await boundedRun(command, root, plan.bound, paths, { env });
  if (result.report !== null) console.error(result.report);
  return result.exitCode;
}

const USAGE = "usage: test-run.ts --profile=<host> [--within=<seconds>] [--durations=<file>] [-- <vitest run args>]";

/** This script's own options, the arguments before `--`. */
function ownOptions(own: readonly string[]): RunOptions {
  let profile: BudgetProfileName | undefined;
  let withinS: number | undefined;
  let durations: string | undefined;
  for (const arg of own) {
    const equals = arg.indexOf("=");
    const name = equals === -1 ? arg : arg.slice(0, equals);
    const value = equals === -1 ? "" : arg.slice(equals + 1);
    if (name === "--profile" && isBudgetProfileName(value)) profile = value;
    else if (name === "--within" && /^[1-9]\d*$/.test(value)) withinS = Number(value);
    else if (name === "--durations" && value !== "") durations = value;
    else throw new TestRunError("arguments", `unexpected ${arg}; ${USAGE}, <host> one of ${Object.keys(BUDGET_PROFILES).join(", ")}`);
  }
  if (profile === undefined) throw new TestRunError("arguments", `no --profile names the host whose figures bound the run; ${USAGE}`);
  return { profile, ...(withinS === undefined ? {} : { withinS }), ...(durations === undefined ? {} : { durations }) };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const split = argv.indexOf("--");
  const options = ownOptions(split === -1 ? argv : argv.slice(0, split));
  return runTests(process.cwd(), [], split === -1 ? [] : argv.slice(split + 1), options);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(describeErrorChain(error));
      process.exitCode = 1;
    },
  );
}
