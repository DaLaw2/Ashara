import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll } from "vitest";
import type { TestContext } from "vitest";
import { DEFAULT_DATABASE_URL } from "@ashara/db";
import { dropStaleRunDatabases, prepareTemplate } from "./database.js";
import type { FaultKind, SeamKind } from "./faults.js";
import { profileOfSeed } from "./profile.js";
import type { Profile } from "./profile.js";
import { runSeed } from "./run.js";
import type { RunOptions, RunResult } from "./run.js";
import type { Direction } from "./tape.js";

/*
 * What the simulator's test files share: the scratch template, a run of a seed or a directed tape,
 * and the readings of a result. The tiers are split across files so vitest runs them on separate
 * workers; each file is its own module instance, so each holds its own template name.
 */
const MAX_CYCLES = 120;
const SEED_TIMEOUT_MS = 60_000;

const databaseUrl = process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL;
let template = "";

/**
 * Registers the file's hooks: the migrated template is prepared before its first run.
 * @testseam each simulator test file calls it once at its top level
 */
export function useSimulatorDatabase(): void {
  beforeAll(async () => {
    await dropStaleRunDatabases(databaseUrl);
    template = await prepareTemplate(databaseUrl);
  }, 120_000);

  afterAll(async () => {
    await dropStaleRunDatabases(databaseUrl);
  });
}

/**
 * What a run needs of the test that starts it: the test's signal, aborted if it times out, and its end.
 * @testseam the simulator's test files pass their test context as it
 */
export type TestScope = Pick<TestContext, "signal" | "onTestFinished">;

/** The test that started a run ended, so the run, if it still runs, is stopped. */
class TestEnded extends Error {
  constructor() {
    super("the test that started the run ended");
    this.name = "TestEnded";
  }
}

/**
 * The signal a test's run is stopped by: aborted when the test times out or ends, so no run
 * outlives the test that started it.
 * @testseam the simulator's test files that call runSeed themselves stop their runs with it
 */
export function runSignal(test: TestScope): AbortSignal {
  const ended = new AbortController();
  test.onTestFinished(() => ended.abort(new TestEnded()));
  return AbortSignal.any([test.signal, ended.signal]);
}

/** @testseam the fast tier's test files run a seed under its own profile through it */
export function seeded(test: TestScope, seed: number, scenario: Pick<RunOptions, "projects" | "capUsd"> = {}): Promise<RunResult> {
  return runSeed({
    signal: runSignal(test),
    seed,
    profile: profileOfSeed(seed),
    tape: { kind: "seeded", seed },
    databaseUrl,
    template,
    maxCycles: MAX_CYCLES,
    timeoutMs: SEED_TIMEOUT_MS,
    ...scenario,
  });
}

/**
 * A replay of a seed's recorded decisions, under the seed's own profile.
 * @testseam simulator-determinism.test.ts replays a seeded run through it
 */
export function replayed(test: TestScope, seed: number, decisions: RunResult["decisions"]): Promise<RunResult> {
  return runSeed({
    signal: runSignal(test),
    seed,
    profile: profileOfSeed(seed),
    tape: { kind: "replay", decisions },
    databaseUrl,
    template,
    maxCycles: MAX_CYCLES,
    timeoutMs: SEED_TIMEOUT_MS,
  });
}

/** A directed run's shape; its `signal` stops the run before its test ends, as the test's own signal does at the end. */
type Scenario = Pick<RunOptions, "mutation" | "projects" | "capUsd" | "cellOutage" | "corruptSecondProject" | "signal"> & { readonly profile?: Profile };

/**
 * The directed tier: each fault, plant and misbehaviour a test judges
 * is forced by name on a directed tape (tape.ts Direction), every other draw benign, rather than
 * reached by a seed found by scanning. A seed is re-rolled by any change that adds a seam call on
 * its path; a direction is not, and one the run never takes fails the run (run.ts DirectionsNotTaken) instead of letting the
 * test judge a run that never met its behaviour. The forced behaviour flows through the same code
 * as a seeded one: the same seams, stand-ins and interleaver; only the choice is named.
 * @testseam the directed tier's test files run each directed tape through it
 */
export function directed(test: TestScope, directions: readonly Direction[], scenario: Scenario = {}): Promise<RunResult> {
  const { signal, ...shape } = scenario;
  return runSeed({
    seed: 1,
    profile: "typical",
    tape: { kind: "directed", directions },
    databaseUrl,
    template,
    maxCycles: MAX_CYCLES,
    timeoutMs: SEED_TIMEOUT_MS,
    ...shape,
    signal: signal === undefined ? runSignal(test) : AbortSignal.any([runSignal(test), signal]),
  });
}

/**
 * A directed tape under the liveness profile, each persona it forces permanent from the first
 * cycle, with a longer bound than a directed run: a persona's loop runs to its own bound.
 * @testseam the termination test files run each persona and plant through it
 */
export function liveness(test: TestScope, directions: readonly Direction[], scenario: Partial<Pick<RunOptions, "mutation" | "maxCycles">> = {}): Promise<RunResult> {
  return runSeed({ signal: runSignal(test), seed: 1, profile: "liveness", tape: { kind: "directed", directions }, databaseUrl, template, timeoutMs: 90_000, maxCycles: MAX_CYCLES, ...scenario });
}

/** @testseam the termination test files force a role's persona by name through it */
export const persona = (role: string, value: number): Direction => ({ kind: "draw", site: `persona.${role}`, nth: 1, value });

/** @testseam the directed tier's test files name a draw's value through it */
export const draw = (site: string | RegExp, nth: number | "every", value = 1, scope?: string): Direction => ({
  kind: "draw",
  site,
  nth,
  value,
  ...(scope === undefined ? {} : { scope }),
});
/**
 * The plan is two tasks that depend on none of each other, so their implementations run as one batch.
 * @testseam the directed tier's test files force a batch of two with it
 */
export const BATCH_OF_TWO: readonly Direction[] = [draw("universe.extra-tasks", 1), draw("universe.independent-tasks", 1)];
/**
 * The running task hands the turn to the other at every matching seam call where it can (interleave.ts).
 * @testseam the directed tier's test files force an interleaving with it
 */
export const switchAtEvery = (site: RegExp): Direction => draw(site, "every");
/**
 * An implementation attempt's draw, counted over implementation attempts only.
 * @testseam the directed tier's test files force an implementer's behaviour with it
 */
export const implementation = (site: string, nth: number | "every"): Direction => draw(site, nth, 1, "implementation");
/** @testseam the directed tier's test files force a fault on the first call that can carry it */
export const fault = (seam: SeamKind, label: string | RegExp, kind: FaultKind): Direction => ({ kind: "fault", seam, label, nth: 1, fault: kind });

/** @testseam the simulator's test files read a run's violation keys through it */
export function keys(result: RunResult): string[] {
  return result.violations.map((v) => v.key).sort();
}

/** @testseam simulator-plants-halts.test.ts reads a run's failed invariants through it */
export function failed(result: RunResult): string[] {
  return [...new Set(result.violations.map((v) => v.invariant))].sort();
}

/** @testseam the simulator's test files print a run's violations as an assertion's message through it */
export function statements(result: RunResult): string {
  return result.violations.map((v) => `${v.key}: ${v.statement}`).join("\n");
}

/** @testseam the termination test files print a run's violations and its outcome as an assertion's message through it */
export function statementsAndOutcome(result: RunResult): string {
  return [...result.violations.map((v) => `${v.key}: ${v.statement}`), `outcome ${JSON.stringify(result.outcome)}`].join("\n");
}

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");
const execFileAsync = promisify(execFile);

/** @testseam the soak test files read a `scripts/simulate.ts` run through it */
export interface Soak {
  readonly exitCode: number;
  /**
   * stdout without what is not a function of the seeds: each run's `ms`, the stale-database notice,
   * and the migration notices of a template build, which only the run that finds no template prints.
   */
  readonly lines: readonly string[];
}

function canonical(stdout: string): string[] {
  return stdout
    .split("\n")
    .filter((line) => !line.startsWith("dropped ") && !line.trimStart().startsWith("[migrate] "))
    .map((line) => line.replace(/, \d+ ms$/, ""));
}

/** A run that exited non-zero: execFile rejects with its exit code and output. */
function failedSoak(err: unknown): Soak | null {
  if (!(err instanceof Error) || !("code" in err) || typeof err.code !== "number" || !("stdout" in err) || typeof err.stdout !== "string") return null;
  return { exitCode: err.code, lines: canonical(err.stdout) };
}

/**
 * The soak tier as a reader runs it: scripts/simulate.ts in its own process, on the test's database server.
 * @testseam the soak test files run `scripts/simulate.ts --jobs` through it
 */
export async function soak(jobs: number, args: readonly string[]): Promise<Soak> {
  try {
    const { stdout } = await execFileAsync("npx", ["tsx", "scripts/simulate.ts", ...args, "--jobs", String(jobs)], {
      cwd: REPO_ROOT,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { exitCode: 0, lines: canonical(stdout) };
  } catch (err) {
    const failed = failedSoak(err);
    if (failed === null) throw err;
    return failed;
  }
}
