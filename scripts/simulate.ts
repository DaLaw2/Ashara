/**
 * The lifecycle simulator's soak tier (story s-independent-verify-m1 L2, design §4.13).
 *
 *   npx tsx scripts/simulate.ts [--seeds N] [--start S] [--jobs J] [--profile P] [--projects 1|2] [--cap USD] [--minimize] [--trace] [--replay FILE]
 *
 * Runs N consecutive seeds, each on its own scratch database created from a migrated template on
 * the server of SIM_DATABASE_URL (default DATABASE_URL, default local). The shared database is
 * never touched: every database it creates or drops is named `ashara_sim_*`. A failing seed is
 * written as a replay file; `--minimize` reduces it to the decisions it needs first. Exits 1 when
 * any seed fails an invariant it is not listed as failing, or never reports.
 *
 * `--jobs J` runs the seeds on J worker processes, each this script with `--worker`, one seed at a
 * time per worker (default: the host's cores, at most DEFAULT_JOBS; `--jobs 1` runs every seed in
 * this process). The output is the same as one after another: each seed's lines are printed in
 * seed order, only its `ms` differing. A worker that dies, or does not report within its seed's
 * bound, is that seed's failure, never a seed left out.
 *
 * `--projects 2` runs two projects on one deployment, sharing its spend cap; `--cap USD` fixes that
 * cap instead of the tape's draw. A seed's result is a function of the seed and the run mode alone:
 * the same in every run, every process and every git checkout (outside one the run refuses to start).
 */

import { fork } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_DATABASE_URL } from "@ashara/db";
import {
  PROFILES,
  ReplayFileSchema,
  SeedRequestSchema,
  WorkerReplySchema,
  describeCoverage,
  describeRun,
  diffExpected,
  dropRunDatabasesOf,
  dropStaleRunDatabases,
  emptyCoverage,
  mergeCoverage,
  minimize,
  prepareTemplate,
  profileOfSeed,
  runSeed,
} from "@ashara/integration";
import type { Decision, Profile, RunMode, RunOptions, RunResult, SeedReport } from "@ashara/integration";
import { describeErrorChain } from "@ashara/shared";

const USAGE = "Usage: npx tsx scripts/simulate.ts [--seeds N] [--start S] [--jobs J] [--profile P] [--projects 1|2] [--cap USD] [--minimize] [--trace] [--replay FILE]";

class SimulateUsageError extends Error {
  constructor(detail: string) {
    super(`${detail}\n${USAGE}`);
    this.name = "SimulateUsageError";
  }
}

/** The `--jobs` protocol between this script and its workers broke: a defect in this script, never skipped. */
class WorkerProtocolError extends Error {
  constructor(
    readonly side: "parent" | "worker",
    readonly detail: string,
  ) {
    super(`simulate ${side}: ${detail}`);
    this.name = "WorkerProtocolError";
  }
}

/** Bounds (design §4.14): no unbounded run. */
const MAX_SEEDS = 500;
const MAX_CYCLES = 120;
const SEED_TIMEOUT_MS = 120_000;
const MINIMIZE_REPLAYS = 40;
/**
 * Workers by default. Each seed holds several database sessions at once: its instance's pool (max
 * 4, faults.ts faultingPools), its observer's (max 2, run.ts), its target claim and admin
 * connections, and a dead instance's while they end. docker/postgres.yml sets max_connections to 400 so
 * MAX_JOBS workers fit beside other clients.
 */
const DEFAULT_JOBS = 16;
const MAX_JOBS = 20;
/** A worker that has not said it is listening by then never will. */
const WORKER_READY_MS = 60_000;
/** Past a seed's own wall clock (and its minimiser's replays): its database's creation and drop. */
const REPORT_GRACE_MS = 60_000;
const OUTPUT_TAIL_CHARS = 4_000;

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
  readonly jobs: number;
  readonly profile: Profile | null;
  readonly minimize: boolean;
  readonly trace: boolean;
  readonly replay: string | null;
  /** The run mode (RunOptions.projects, RunOptions.capUsd); written into each replay file. */
  readonly projects: 1 | 2;
  readonly capUsd: number | null;
  /** This process is a worker of a `--jobs` run: it runs the seeds its parent sends over IPC. */
  readonly worker: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  let seeds = 20;
  let start = 1;
  let jobs = Math.min(DEFAULT_JOBS, availableParallelism());
  let profile: Profile | null = null;
  let shouldMinimize = false;
  let trace = false;
  let replay: string | null = null;
  let projects: 1 | 2 = 1;
  let capUsd: number | null = null;
  let worker = false;
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
    if (flag === "--worker") {
      worker = true;
      continue;
    }
    const value = argv[i + 1];
    i += 1;
    if (value === undefined) throw new SimulateUsageError(`${flag ?? ""} needs a value.`);
    if (flag === "--seeds") seeds = integerArg(flag, value, 1, MAX_SEEDS);
    else if (flag === "--start") start = integerArg(flag, value, 0, Number.MAX_SAFE_INTEGER);
    else if (flag === "--jobs") jobs = integerArg(flag, value, 1, MAX_JOBS);
    else if (flag === "--profile") profile = profileArg(value);
    else if (flag === "--replay") replay = value;
    else if (flag === "--projects") projects = integerArg(flag, value, 1, 2) === 2 ? 2 : 1;
    else if (flag === "--cap") capUsd = integerArg(flag, value, 1, 1000);
    else throw new SimulateUsageError(`Unknown argument ${flag ?? ""}.`);
  }
  return { seeds, start, jobs, profile, minimize: shouldMinimize, trace, replay, projects, capUsd, worker };
}

/** The minimiser's predicate: the replay fails at least one of the original run's violation keys. */
function sameFailure(a: RunResult, b: RunResult): boolean {
  const keys = new Set(a.violations.map((v) => v.key));
  return b.violations.some((v) => keys.has(v.key));
}

type Base = Pick<RunOptions, "databaseUrl" | "template" | "maxCycles" | "timeoutMs">;

/** One seed of the soak, judged, minimised and written as a replay file when it fails. */
async function soakSeed(seed: number, args: Args, base: Base, mode: RunMode): Promise<SeedReport> {
  const profile = args.profile ?? profileOfSeed(seed);
  const lines: string[] = [];
  const result = await runSeed({ ...base, ...mode, seed, profile, tape: { kind: "seeded", seed } });
  let minimal: readonly Decision[] | null = null;
  if (result.violations.length > 0 && args.minimize) {
    const reduced = await minimize(
      result.decisions,
      async (decisions) => sameFailure(result, await runSeed({ ...base, ...mode, seed, profile, tape: { kind: "replay", decisions } })),
      MINIMIZE_REPLAYS,
    );
    minimal = reduced.decisions;
  }
  lines.push(...describeRun(result, minimal));
  if (args.trace) for (const line of [...result.trace, ...result.log]) lines.push(`  | ${line}`);
  const diff = diffExpected(result, mode);
  // A listed key the seed no longer fails is a fix whose entry was not removed: as unexpected as a new failure.
  if (diff.missing.length > 0) lines.push(`  listed in expected-failures.ts but not failed: ${diff.missing.join("; ")}`);
  const unexpected = diff.unexpected.length > 0 || diff.missing.length > 0;
  if (result.violations.length > 0) {
    const known = diff.unexpected.length === 0;
    const path = join(tmpdir(), `ashara-sim-${seed}${args.projects === 2 ? "-p2" : ""}.json`);
    await writeFile(path, `${JSON.stringify({ seed, profile, ...mode, decisions: minimal ?? result.decisions }, null, 2)}\n`);
    lines.push(`  replay: npx tsx scripts/simulate.ts --replay ${path}${known ? "  (known: listed in expected-failures.ts)" : ""}`);
  }
  return { seed, lines, coverage: result.coverage, unexpected };
}

/** A seed with no verdict: its run threw, or its worker never reported. A failure, never a seed left out. */
function unreported(seed: number, detail: string): SeedReport {
  return { seed, lines: [`seed ${seed}: no verdict: ${detail}`], coverage: emptyCoverage(), unexpected: true };
}

async function reportSeed(seed: number, args: Args, base: Base, mode: RunMode): Promise<SeedReport> {
  try {
    return await soakSeed(seed, args, base, mode);
  } catch (err) {
    return unreported(seed, `the run threw: ${describeErrorChain(err)}`);
  }
}

/** The worker side of `--jobs`: one seed at a time, as the parent sends them, until it disconnects. */
function serveSeeds(args: Args, base: Base, mode: RunMode): void {
  const send = process.send?.bind(process);
  if (send === undefined) throw new SimulateUsageError("--worker is internal to --jobs: it needs the IPC channel of a parent simulate.ts.");
  let busy = false;
  process.on("message", (raw: unknown) => {
    const request = SeedRequestSchema.safeParse(raw);
    if (!request.success || busy) {
      // The parent sends a seed only after the last one's report: anything else is a defect here.
      throw new WorkerProtocolError("worker", `unexpected message ${JSON.stringify(raw)} (busy: ${busy})`);
    }
    busy = true;
    void reportSeed(request.data.seed, args, base, mode).then((report) => {
      busy = false;
      send({ kind: "report", report });
    });
  });
  // The parent disconnects when it has no seed left, or when it died: a seed in flight then has no one to report to.
  process.on("disconnect", () => process.exit(busy ? 1 : 0));
  send({ kind: "ready" });
}

/** The last characters a worker wrote, for the report of a worker that died. */
class OutputTail {
  private text = "";
  add(chunk: unknown): void {
    this.text = `${this.text}${String(chunk)}`.slice(-OUTPUT_TAIL_CHARS);
  }
  toString(): string {
    return this.text.trim() === "" ? "(no output)" : this.text.trim();
  }
}

/** How the parent runs its workers. */
interface Workers {
  readonly jobs: number;
  /** This run's own arguments; each worker parses them as its parent did. */
  readonly argv: readonly string[];
  /** A seed's wall clock bound, its minimiser's replays and REPORT_GRACE_MS: past it, the worker is killed. */
  readonly reportBoundMs: number;
  readonly databaseUrl: string;
}

/**
 * One worker's life: seeds from `queue` until it is empty or the worker dies. Resolves when the
 * worker has exited; every seed it took has been delivered, its report or its failure. The first
 * seed is taken before the worker starts, so a worker that cannot start fails a seed: a host where
 * no worker starts ends the run, every seed failed, instead of starting workers forever.
 */
function serveWorker(workers: Workers, queue: number[], deliver: (report: SeedReport) => void): Promise<void> {
  return new Promise((resolve) => {
    const first = queue.shift();
    if (first === undefined) {
      resolve();
      return;
    }
    const child: ChildProcess = fork(fileURLToPath(import.meta.url), [...workers.argv, "--worker"], {
      serialization: "advanced",
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const tail = new OutputTail();
    child.stdout?.on("data", (chunk: unknown) => tail.add(chunk));
    child.stderr?.on("data", (chunk: unknown) => {
      tail.add(chunk);
      process.stderr.write(String(chunk));
    });
    let inFlight: number | null = first;
    let listening = false;
    let why: string | null = null;
    let timer: NodeJS.Timeout | null = null;
    let finished = false;
    const watch = (ms: number, what: string): void => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        why = `${what} within ${ms} ms; killed`;
        child.kill("SIGKILL");
      }, ms);
    };
    const finish = (detail: string): void => {
      if (finished) return;
      finished = true;
      if (timer !== null) clearTimeout(timer);
      const lost = inFlight;
      inFlight = null;
      if (lost === null) {
        resolve();
        return;
      }
      deliver(unreported(lost, `worker ${child.pid ?? "?"} ${why ?? detail}; its last output: ${tail.toString()}`));
      // The dead worker's run database outlives it; the next soak's stale sweep is the fallback.
      const pid = child.pid;
      if (pid === undefined) {
        resolve();
        return;
      }
      dropRunDatabasesOf(workers.databaseUrl, pid)
        .catch((err: unknown) => console.error(`simulate: the run database of dead worker ${pid} was not dropped (the next soak drops it after an hour): ${describeErrorChain(err)}`))
        .finally(resolve);
    };
    const send = (seed: number): void => {
      watch(workers.reportBoundMs, `did not report seed ${seed}`);
      child.send({ kind: "seed", seed });
    };
    watch(WORKER_READY_MS, "did not start listening");
    child.on("message", (raw: unknown) => {
      const reply = WorkerReplySchema.safeParse(raw);
      const expected = reply.success && (reply.data.kind === "ready" ? !listening : listening && reply.data.report.seed === inFlight);
      if (!reply.success || !expected) {
        why = `sent ${reply.success ? `an out-of-turn ${reply.data.kind}` : `a malformed message (${reply.error.message})`}; killed`;
        child.kill("SIGKILL");
        return;
      }
      if (reply.data.kind === "ready") {
        listening = true;
        send(first);
        return;
      }
      deliver(reply.data.report);
      inFlight = queue.shift() ?? null;
      if (inFlight !== null) {
        send(inFlight);
        return;
      }
      if (timer !== null) clearTimeout(timer);
      child.disconnect();
    });
    child.on("error", (err) => {
      finish(`failed: ${describeErrorChain(err)}`);
      child.kill("SIGKILL");
    });
    child.on("exit", (code, signal) => finish(`exited (code ${code ?? "none"}, signal ${signal ?? "none"}) before reporting`));
  });
}

/**
 * The seeds over `jobs` workers, each report handed to `emit` in seed order. A dead worker is
 * replaced while seeds are left, so a crash costs its own seed only.
 */
async function soakInWorkers(seeds: readonly number[], workers: Workers, emit: (report: SeedReport) => void): Promise<void> {
  const queue = [...seeds];
  const waiting = new Map<number, SeedReport>();
  let next = 0;
  const deliver = (report: SeedReport): void => {
    waiting.set(report.seed, report);
    for (let ready = waiting.get(seeds[next] ?? -1); ready !== undefined; ready = waiting.get(seeds[next] ?? -1)) {
      waiting.delete(ready.seed);
      next += 1;
      emit(ready);
    }
  };
  const lane = async (): Promise<void> => {
    while (queue.length > 0) await serveWorker(workers, queue, deliver);
  };
  await Promise.all(Array.from({ length: Math.min(workers.jobs, seeds.length) }, lane));
  if (next !== seeds.length) {
    throw new WorkerProtocolError("parent", `${seeds.length - next} seed(s) from seed ${seeds[next] ?? "?"} on never reported, and no worker is left to run them`);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const databaseUrl = process.env["SIM_DATABASE_URL"] ?? process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL;
  if (!args.worker) {
    const dropped = await dropStaleRunDatabases(databaseUrl);
    if (dropped.length > 0) console.log(`dropped ${dropped.length} stale run database(s)`);
  }
  const template = await prepareTemplate(databaseUrl);
  const base: Base = { databaseUrl, template, maxCycles: MAX_CYCLES, timeoutMs: SEED_TIMEOUT_MS };
  const mode: RunMode = { projects: args.projects, ...(args.capUsd === null ? {} : { capUsd: args.capUsd }) };

  if (args.worker) {
    serveSeeds(args, base, mode);
    return;
  }

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

  const seeds = Array.from({ length: args.seeds }, (_, index) => args.start + index);
  const coverage = emptyCoverage();
  let unexpected = 0;
  const emit = (report: SeedReport): void => {
    for (const line of report.lines) console.log(line);
    mergeCoverage(coverage, report.coverage);
    if (report.unexpected) unexpected += 1;
  };
  if (args.jobs === 1) {
    for (const seed of seeds) emit(await reportSeed(seed, args, base, mode));
  } else {
    const reportBoundMs = SEED_TIMEOUT_MS * (1 + (args.minimize ? MINIMIZE_REPLAYS : 0)) + REPORT_GRACE_MS;
    await soakInWorkers(seeds, { jobs: args.jobs, argv, reportBoundMs, databaseUrl }, emit);
  }
  console.log("");
  for (const line of describeCoverage(coverage)) console.log(line);
  console.log(`\n${args.seeds} seed(s), ${unexpected} with an unexpected failure`);
  process.exitCode = unexpected > 0 ? 1 : 0;
}

main().catch((err: unknown) => {
  console.error(`simulate: ${describeErrorChain(err)}`);
  process.exitCode = 1;
  // A worker that cannot serve lets go of its parent, which reports the seed it was given as failed.
  if (process.connected) process.disconnect?.();
});
