import { afterAll, beforeAll } from "vitest";
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

/** @testseam the fast tier's test files run a seed under its own profile through it */
export function seeded(seed: number, scenario: Pick<RunOptions, "projects" | "capUsd"> = {}): Promise<RunResult> {
  return runSeed({
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
export function replayed(seed: number, decisions: RunResult["decisions"]): Promise<RunResult> {
  return runSeed({
    seed,
    profile: profileOfSeed(seed),
    tape: { kind: "replay", decisions },
    databaseUrl,
    template,
    maxCycles: MAX_CYCLES,
    timeoutMs: SEED_TIMEOUT_MS,
  });
}

type Scenario = Pick<RunOptions, "mutation" | "projects" | "capUsd" | "cellOutage" | "corruptSecondProject"> & { readonly profile?: Profile };

/**
 * The directed tier (t-simulator-directed-plants): each fault, plant and misbehaviour a test judges
 * is forced by name on a directed tape (tape.ts Direction), every other draw benign, rather than
 * reached by a seed found by scanning. A seed is re-rolled by any change that adds a seam call on
 * its path; a direction is not, and one the run never takes fails the run (run.ts DirectionsNotTaken) instead of letting the
 * test judge a run that never met its behaviour. The forced behaviour flows through the same code
 * as a seeded one: the same seams, stand-ins and interleaver; only the choice is named.
 * @testseam the directed tier's test files run each directed tape through it
 */
export function directed(directions: readonly Direction[], scenario: Scenario = {}): Promise<RunResult> {
  return runSeed({
    seed: 1,
    profile: "typical",
    tape: { kind: "directed", directions },
    databaseUrl,
    template,
    maxCycles: MAX_CYCLES,
    timeoutMs: SEED_TIMEOUT_MS,
    ...scenario,
  });
}

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

/** @testseam simulator-plants.test.ts reads a run's failed invariants through it */
export function failed(result: RunResult): string[] {
  return [...new Set(result.violations.map((v) => v.invariant))].sort();
}

/** @testseam the simulator's test files print a run's violations as an assertion's message through it */
export function statements(result: RunResult): string {
  return result.violations.map((v) => `${v.key}: ${v.statement}`).join("\n");
}
