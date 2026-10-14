/**
 * The lifecycle simulator's soak tier (story s-independent-verify-m1 L2, design §4.13).
 *
 *   npx tsx scripts/simulate.ts [--seeds N] [--start S] [--profile P] [--projects 1|2] [--cap USD] [--minimize] [--trace] [--replay FILE]
 *
 * Runs N consecutive seeds, one after another, each on its own scratch database created from a
 * migrated template on the server of SIM_DATABASE_URL (default DATABASE_URL, default local). The
 * shared database is never touched: every database it creates or drops is named `ashara_sim_*`.
 * A failing seed is written as a replay file; `--minimize` reduces it to the decisions it needs
 * first. Exits 1 when any seed fails an invariant it is not listed as failing.
 *
 * `--projects 2` runs two projects on one deployment, sharing its spend cap; `--cap USD` fixes that
 * cap instead of the tape's draw. A seed's result is a function of the seed and the run mode alone:
 * the same in every run and every git checkout (outside one the run refuses to start).
 */

import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_DATABASE_URL } from "@ashara/db";
import {
  PROFILES,
  ReplayFileSchema,
  describeCoverage,
  describeRun,
  diffExpected,
  dropStaleRunDatabases,
  emptyCoverage,
  mergeCoverage,
  minimize,
  prepareTemplate,
  profileOfSeed,
  runSeed,
} from "@ashara/integration";
import type { Decision, Profile, RunMode, RunOptions, RunResult } from "@ashara/integration";
import { describeErrorChain } from "@ashara/shared";

class SimulateUsageError extends Error {
  constructor(detail: string) {
    super(`${detail}\nUsage: npx tsx scripts/simulate.ts [--seeds N] [--start S] [--profile P] [--projects 1|2] [--cap USD] [--minimize] [--trace] [--replay FILE]`);
    this.name = "SimulateUsageError";
  }
}

/** Bounds (design §4.14): no unbounded run. */
const MAX_SEEDS = 500;
const MAX_CYCLES = 120;
const SEED_TIMEOUT_MS = 120_000;
const MINIMIZE_REPLAYS = 40;

function integerArg(flag: string, value: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new SimulateUsageError(`${flag} must be an integer from ${min} to ${max}, got "${value}".`);
  }
  return parsed;
}

function profileArg(value: string): Profile {
  const profile = PROFILES.find((known) => known === value);
  if (profile === undefined) throw new SimulateUsageError(`--profile must be one of ${PROFILES.join(", ")}, got "${value}".`);
  return profile;
}

interface Args {
  readonly seeds: number;
  readonly start: number;
  readonly profile: Profile | null;
  readonly minimize: boolean;
  readonly trace: boolean;
  readonly replay: string | null;
  /** The run mode (RunOptions.projects, RunOptions.capUsd); written into each replay file. */
  readonly projects: 1 | 2;
  readonly capUsd: number | null;
}

function parseArgs(argv: readonly string[]): Args {
  let seeds = 20;
  let start = 1;
  let profile: Profile | null = null;
  let shouldMinimize = false;
  let trace = false;
  let replay: string | null = null;
  let projects: 1 | 2 = 1;
  let capUsd: number | null = null;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--minimize") {
      shouldMinimize = true;
      continue;
    }
    if (flag === "--trace") {
      trace = true;
      continue;
    }
    const value = argv[i + 1];
    i += 1;
    if (value === undefined) throw new SimulateUsageError(`${flag ?? ""} needs a value.`);
    if (flag === "--seeds") seeds = integerArg(flag, value, 1, MAX_SEEDS);
    else if (flag === "--start") start = integerArg(flag, value, 0, Number.MAX_SAFE_INTEGER);
    else if (flag === "--profile") profile = profileArg(value);
    else if (flag === "--replay") replay = value;
    else if (flag === "--projects") projects = integerArg(flag, value, 1, 2) === 2 ? 2 : 1;
    else if (flag === "--cap") capUsd = integerArg(flag, value, 1, 1000);
    else throw new SimulateUsageError(`Unknown argument ${flag ?? ""}.`);
  }
  return { seeds, start, profile, minimize: shouldMinimize, trace, replay, projects, capUsd };
}

/** The minimiser's predicate: the replay fails at least one of the original run's violation keys. */
function sameFailure(a: RunResult, b: RunResult): boolean {
  const keys = new Set(a.violations.map((v) => v.key));
  return b.violations.some((v) => keys.has(v.key));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const databaseUrl = process.env["SIM_DATABASE_URL"] ?? process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL;
  const dropped = await dropStaleRunDatabases(databaseUrl);
  if (dropped.length > 0) console.log(`dropped ${dropped.length} stale run database(s)`);
  const template = await prepareTemplate(databaseUrl);
  const base: Pick<RunOptions, "databaseUrl" | "template" | "maxCycles" | "timeoutMs"> = { databaseUrl, template, maxCycles: MAX_CYCLES, timeoutMs: SEED_TIMEOUT_MS };
  const mode: RunMode = { projects: args.projects, ...(args.capUsd === null ? {} : { capUsd: args.capUsd }) };

  if (args.replay !== null) {
    const file = ReplayFileSchema.parse(JSON.parse(await readFile(args.replay, "utf8")));
    // The file's own mode, recorded when it was written; a file without one is a one-project run.
    const replayed: RunMode = { projects: file.projects ?? 1, ...(file.capUsd === undefined ? {} : { capUsd: file.capUsd }) };
    const result = await runSeed({ ...base, ...replayed, seed: file.seed, profile: file.profile, tape: { kind: "replay", decisions: file.decisions } });
    for (const line of describeRun(result, null)) console.log(line);
    for (const line of [...result.trace, ...(args.trace ? result.log : [])]) console.log(`  | ${line}`);
    process.exitCode = result.violations.length > 0 ? 1 : 0;
    return;
  }

  const coverage = emptyCoverage();
  let unexpected = 0;
  for (let seed = args.start; seed < args.start + args.seeds; seed++) {
    const profile = args.profile ?? profileOfSeed(seed);
    const result = await runSeed({ ...base, ...mode, seed, profile, tape: { kind: "seeded", seed } });
    mergeCoverage(coverage, result.coverage);
    let minimal: readonly Decision[] | null = null;
    if (result.violations.length > 0 && args.minimize) {
      const reduced = await minimize(
        result.decisions,
        async (decisions) => sameFailure(result, await runSeed({ ...base, ...mode, seed, profile, tape: { kind: "replay", decisions } })),
        MINIMIZE_REPLAYS,
      );
      minimal = reduced.decisions;
    }
    for (const line of describeRun(result, minimal)) console.log(line);
    if (args.trace) for (const line of [...result.trace, ...result.log]) console.log(`  | ${line}`);
    const diff = diffExpected(result, mode);
    // A listed key the seed no longer fails is a fix whose entry was not removed: as unexpected as a new failure.
    if (diff.missing.length > 0) console.log(`  listed in expected-failures.ts but not failed: ${diff.missing.join("; ")}`);
    if (diff.unexpected.length > 0 || diff.missing.length > 0) unexpected += 1;
    if (result.violations.length === 0) continue;
    const known = diff.unexpected.length === 0;
    const path = join(tmpdir(), `ashara-sim-${seed}${args.projects === 2 ? "-p2" : ""}.json`);
    await writeFile(path, `${JSON.stringify({ seed, profile, ...mode, decisions: minimal ?? result.decisions }, null, 2)}\n`);
    console.log(`  replay: npx tsx scripts/simulate.ts --replay ${path}${known ? "  (known: listed in expected-failures.ts)" : ""}`);
  }
  console.log("");
  for (const line of describeCoverage(coverage)) console.log(line);
  console.log(`\n${args.seeds} seed(s), ${unexpected} with an unexpected failure`);
  process.exitCode = unexpected > 0 ? 1 : 0;
}

main().catch((err: unknown) => {
  console.error(`simulate: ${describeErrorChain(err)}`);
  process.exitCode = 1;
});
