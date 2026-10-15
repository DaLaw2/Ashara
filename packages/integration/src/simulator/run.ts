import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { sql } from "drizzle-orm";
import pg from "pg";
import { z } from "zod";
import { ClientMessageRepository, ClientRepository, SecretRepository, createDb, createProjectWithTender } from "@ashara/db";
import { loadBaseCell } from "@ashara/execution-infra";
import { SecretStore, createKeyFile, loadMasterKey } from "@ashara/security";
import type { MasterKey } from "@ashara/security";
import { composeAshara } from "@ashara/server/compose";
import type { AsharaInstance } from "@ashara/server/compose";
import { describeErrorChain, observeContendedWaits } from "@ashara/shared";
import type { ContendedWaitKind } from "@ashara/shared";
import { AdmissionLedger, pendingUncounted } from "./admissions.js";
import { CheckoutWatch } from "./checkout-watch.js";
import { createRunDatabase } from "./database.js";
import type { Database, RunDatabase } from "./database.js";
import { FakePodman } from "./fake-podman.js";
import type { PodmanEvent } from "./fake-podman.js";
import { GitDates, Scheduler, SimClock, SimulatedCrash, faultingGit, faultingModels, faultingPodman, faultingPools, pinInfrastructureFaults, skipMergeRecord } from "./faults.js";
import type { FaultKind, FaultRecord, InstanceHandle, QueryPlant } from "./faults.js";
import { GitBroker } from "./git-broker.js";
import { Interleaver } from "./interleave.js";
import type { InterleaveEvent } from "./interleave.js";
import { checkSnapshot, checkTotality, mainFiles, outcomeOf, progressFacts, readSnapshot, sourceOf } from "./invariants.js";
import type { Outcome, Snapshot, Violation } from "./invariants.js";
import { emptyCoverage, observeAcceptanceSweeps, sample, sampleModelPaths } from "./coverage.js";
import type { Coverage } from "./coverage.js";
import { behaviourPath, drawUniverse } from "./product.js";
import { FAULTS, drawRates } from "./profile.js";
import {
  briefMisstatesStanding,
  deliveredReportMisstatesStanding,
  deliveredReportMisstatesUnchecked,
  deliveredReportOmitsGoal,
  deliveredReportOmitsUncovered,
  deliveredReportUnrecorded,
  haltReportFixedCause,
  questionMisstatesAssumption,
  stopReportOmitsMerge,
} from "./report-plants.js";
import type { Profile } from "./profile.js";
import { StandIns } from "./scripted-models.js";
import { Tape } from "./tape.js";
import type { Decision, TapeMode } from "./tape.js";

/**
 * A plant at a seam (L3 acceptance): the run must catch it, so a green invariant is not a blind one.
 * - skip-merge-record: every merge recorded under a commit main does not hold (I7, records clause);
 * - no-checkout-lock: a task waiting for the target checkout goes on at once (I7, merge-queue clause);
 * - no-admission-queue: a spend-cap admission goes on without waiting for the ones ahead of it (I5,
 *   admission clause). Planted on a run of two projects, where only the deployment's check stands
 *   between them (baseline §7.6). Since migration 053 an admission's own estimate is a row written
 *   after the project's check, an await later; whether one project now catches it too: unverified;
 * - pending-uncounted: a spend-cap admission's read leaves out the pending rows of calls admitted
 *   and not yet recorded, so it counts the recorded spend alone (I5, admission clause);
 * - infrastructure-fault-pinned: a task's infrastructure faults stop counting at the halt (I8);
 * - halt-report-fixed-cause: a halt's report states a fixed cause, not the recorded one (I4);
 * - stop-report-omits-merge: the stop report leaves out a merge on record (I4);
 * - delivered-report-omits-goal, delivered-report-misstates-unchecked: the delivered report leaves
 *   out a goal's close, or states the wrong tasks as not checked by a stored check (I4);
 * - delivered-report-omits-uncovered: the delivered report leaves out an asked-for item no
 *   acceptance line of a swept check task cites (I4, W11c D3);
 * - delivered-report-unrecorded: the delivered report is posted but not recorded on its sweep, so
 *   it is posted again (I4, exactly once);
 * - brief-misstates-standing: a brief's text calls an assumption asked about Stated by the client
 *   (I9, W12a D1's class);
 * - delivered-report-misstates-standing: the delivered report says an assumption the client was
 *   asked about was reported to them (I9, smoke2 D1's class);
 * - question-misstates-assumption: a question says work proceeds on an assumption its vision does
 *   not record (I9).
 */
const MUTATIONS = [
  "skip-merge-record",
  "no-checkout-lock",
  "no-admission-queue",
  "pending-uncounted",
  "infrastructure-fault-pinned",
  "halt-report-fixed-cause",
  "stop-report-omits-merge",
  "delivered-report-omits-goal",
  "delivered-report-misstates-unchecked",
  "delivered-report-omits-uncovered",
  "delivered-report-unrecorded",
  "brief-misstates-standing",
  "delivered-report-misstates-standing",
  "question-misstates-assumption",
] as const;
/** @testseam simulator.test.ts plants each to prove I5, I7 and I8 are not blind */
export type Mutation = (typeof MUTATIONS)[number];

interface Plant {
  readonly bypassed: readonly ContendedWaitKind[];
  readonly queries: QueryPlant | null;
  /** Patches production code for the run; returns what undoes it. */
  readonly code: (() => () => void) | null;
}

/** The contended wait each mutation skips, the queries it rewrites, and the code it patches. */
const PLANTED: Readonly<Record<Mutation, Plant>> = {
  "skip-merge-record": { bypassed: [], queries: skipMergeRecord, code: null },
  "no-checkout-lock": { bypassed: ["target-checkout"], queries: null, code: null },
  "no-admission-queue": { bypassed: ["spend-admission"], queries: null, code: null },
  "pending-uncounted": { bypassed: [], queries: pendingUncounted, code: null },
  "infrastructure-fault-pinned": { bypassed: [], queries: pinInfrastructureFaults, code: null },
  "halt-report-fixed-cause": { bypassed: [], queries: haltReportFixedCause, code: null },
  "stop-report-omits-merge": { bypassed: [], queries: stopReportOmitsMerge, code: null },
  "delivered-report-omits-goal": { bypassed: [], queries: deliveredReportOmitsGoal, code: null },
  "delivered-report-misstates-unchecked": { bypassed: [], queries: deliveredReportMisstatesUnchecked, code: null },
  "delivered-report-omits-uncovered": { bypassed: [], queries: deliveredReportOmitsUncovered, code: null },
  "delivered-report-unrecorded": { bypassed: [], queries: deliveredReportUnrecorded, code: null },
  "brief-misstates-standing": { bypassed: [], queries: briefMisstatesStanding, code: null },
  "delivered-report-misstates-standing": { bypassed: [], queries: deliveredReportMisstatesStanding, code: null },
  "question-misstates-assumption": { bypassed: [], queries: questionMisstatesAssumption, code: null },
};

export interface RunOptions {
  readonly seed: number;
  readonly profile: Profile;
  readonly tape: TapeMode;
  /** The database server the scratch databases live on (never the shared database itself). */
  readonly databaseUrl: string;
  readonly template: string;
  readonly maxCycles: number;
  /** Faults forced at seam tickets, every other ticket clean: the S-min enumeration. */
  readonly forcedFaults?: ReadonlyMap<number, FaultKind>;
  readonly mutation?: Mutation;
  /** Hard wall clock of the run; past it the run ends as an I1 violation (design §4.14). */
  readonly timeoutMs: number;
  /**
   * Projects on the one deployment (policy default 1). Two share the deployment's spend cap, so
   * their tasks' admissions race on it (F11 across projects); both are judged, the second's
   * violation keys marked `p2`.
   */
  readonly projects?: 1 | 2;
  /** The deployment's spend cap instead of the tape's draw; each project's cap equals it. */
  readonly capUsd?: number;
  /** Every cell start fails for the whole run: the host's container runtime is broken (faults.ts). */
  readonly cellOutage?: boolean;
}

/** The run's shape apart from its seed: how many projects share the deployment, and its cap. */
export type RunMode = Pick<RunOptions, "projects" | "capUsd">;

export interface RunResult {
  readonly seed: number;
  readonly profile: Profile;
  readonly outcome: Outcome;
  readonly violations: readonly Violation[];
  /** Canonical: ids and commits replaced by their order of first appearance, no time in it; the violations last. */
  readonly trace: readonly string[];
  readonly decisions: readonly Decision[];
  readonly coverage: Coverage;
  readonly cycles: number;
  readonly dispatches: number;
  readonly restarts: number;
  readonly faults: readonly FaultRecord[];
  readonly tickets: number;
  readonly durationMs: number;
  /** The longest run of fault-free cycles with no progress (I8's measure), the run's end included. */
  readonly longestQuiet: number;
  /** The last lines production logged: what a reader of a failure looks at first. */
  readonly log: readonly string[];
}

/** Design §2.9 I1's bound with today's constants: R repairs, N items, A attempts, K contests. */
const REPAIRS = 2;
const ATTEMPTS = 3;
const CONTESTS = 2;
const DEFAULT_CAP_USD = 25;
/**
 * The adversarial profile's cap. Every stand-in call is unpriced and counts at its worst-case
 * estimate (about $0.35 at a turn's bound), and misbehaving responses are retried: at $25, 17 of
 * adversarial seeds 1-30 halted at the cap (observed 2026-10-15), seed 9 with its conflict retry
 * refused, so the paths after a misbehaviour went unreached. At $100, 7 of seeds 1-40 do.
 */
const ADVERSARIAL_CAP_USD = 100;
const LOW_CAP_USD = 0.02;
/**
 * I8's bound: fault-free cycles in a row with no progress (invariants.ts progressFacts) after which
 * the run is judged to make none. Why 6: a task's own work progresses on every charged attempt and
 * every status it first reaches, and what may pass between two such facts without a fault is the
 * loop's own bookkeeping: a parked exit taken on the next cycle's sweep, a replan waiting one cycle
 * for its project's tasks to settle, a halt's report and the probe's resumption, each one cycle. A
 * cycle that carried an injected fault or a restart does not count: the fault budget bounds those
 * (design §4.9). Observed (baseline §7.7): the longest such stretch in seeds 1-80 was 2 cycles, so
 * the bound is three times what any seed that progressed needed.
 */
const NO_PROGRESS_CYCLES = 6;
const SETTLE_CYCLES = 2;
const POLL_INTERVAL_MS = 10_000;
const IDLE_INTERVAL_MS = 30_000;
const LOG_LINES = 400;
const UNPRICED_NOISE = ["cost unmeasured", "no routing profile for enabled-provider combo"];
/** Compositions one run may make, restarts included: a boot that fails past it ends the run. */
const MAX_BOOTS = 50;

/** A boot failed after the run's composition bound was spent; the boot's error is kept as the cause. */
class BootsExhausted extends Error {
  constructor(
    readonly seed: number,
    readonly compositions: number,
    readonly lastError: unknown,
  ) {
    super(`seed ${seed}: composition ${compositions} of the simulated process failed to boot, past the bound of ${MAX_BOOTS}: ${describeErrorChain(lastError)}`, { cause: lastError });
    this.name = "BootsExhausted";
  }
}

/** How long a restart waits for a dead instance's database sessions to end. */
const BACKEND_EXIT_POLLS = 100;
const BACKEND_EXIT_POLL_MS = 50;

/** A composed instance and the generation that names its database sessions. */
interface Live {
  readonly ashara: AsharaInstance;
  readonly handle: InstanceHandle;
  readonly generation: number;
}

/** A dead instance's database sessions outlived their termination: the next boot would find its claim held. */
class BackendsOutlivedInstance extends Error {
  constructor(
    readonly applicationName: string,
    readonly left: number,
  ) {
    super(`${left} database session(s) of ${applicationName} were still open ${BACKEND_EXIT_POLLS * BACKEND_EXIT_POLL_MS} ms after pg_terminate_backend`);
    this.name = "BackendsOutlivedInstance";
  }
}

/** The instance's connection string: every session it opens, outside its pool too, carries its name. */
function instanceUrl(databaseUrl: string, applicationName: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set("application_name", applicationName);
  return url.toString();
}

/** Ids are drawn from the seed while a run lasts, so two runs of one seed order equal-time rows alike. */
function seededIds(seed: number): () => void {
  const require = createRequire(import.meta.url);
  const cryptoModule: object = require("node:crypto");
  const original: unknown = Reflect.get(cryptoModule, "randomUUID");
  const webOriginal: unknown = Reflect.get(globalThis.crypto, "randomUUID");
  let state = (seed ^ 0x5bd1e995) >>> 0;
  const next = (): number => {
    state = (Math.imul(state ^ (state >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
    return state;
  };
  const uuid = (): string => {
    const hex = Array.from({ length: 32 }, () => (next() & 0xf).toString(16));
    hex[12] = "4";
    hex[16] = ((next() & 0x3) | 0x8).toString(16);
    const s = hex.join("");
    return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
  };
  Reflect.set(cryptoModule, "randomUUID", uuid);
  Reflect.defineProperty(globalThis.crypto, "randomUUID", { value: uuid, configurable: true, writable: true });
  syncBuiltinESMExports();
  return () => {
    Reflect.set(cryptoModule, "randomUUID", original);
    if (typeof webOriginal === "function") Reflect.deleteProperty(globalThis.crypto, "randomUUID");
    syncBuiltinESMExports();
  };
}

/** Production's console output goes into the run's log, not the terminal; the last lines are kept. */
function capturedConsole(log: string[]): () => void {
  const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  const keep = (level: string) => (...args: unknown[]): void => {
    const line = `${level} ${args.map((a) => (a instanceof Error ? describeErrorChain(a) : String(a))).join(" ")}`;
    // Every stand-in call is unpriced and unrouted by design: those two lines would bury the rest.
    if (UNPRICED_NOISE.some((noise) => line.includes(noise))) return;
    log.push(line.slice(0, 600));
    if (log.length > LOG_LINES) log.splice(0, log.length - LOG_LINES);
  };
  console.log = keep("log");
  console.info = keep("info");
  console.warn = keep("warn");
  console.error = keep("error");
  return () => {
    console.log = saved.log;
    console.warn = saved.warn;
    console.error = saved.error;
    console.info = saved.info;
  };
}

const SIM_ENV = [
  "WORKDIR_BASE",
  "ASHARA_BUDGET_LIMIT_USD",
  "ASHARA_BUDGET_TOTAL",
  "ASHARA_PROJECT_BUDGET_LIMIT_USD",
  // Unset for the run: the batch size is production's default (server config.ts), a batch of two.
  "MAX_BATCH_SIZE",
  "ASHARA_CELL_MEMORY",
  "ASHARA_CELL_CPUS",
  "ASHARA_CELL_PIDS_LIMIT",
] as const;

function simulatedEnvironment(workdir: string, capUsd: number): () => void {
  const saved = new Map(SIM_ENV.map((key) => [key, process.env[key]]));
  process.env["WORKDIR_BASE"] = workdir;
  process.env["ASHARA_BUDGET_LIMIT_USD"] = String(capUsd);
  delete process.env["ASHARA_BUDGET_TOTAL"];
  delete process.env["ASHARA_PROJECT_BUDGET_LIMIT_USD"];
  delete process.env["MAX_BATCH_SIZE"];
  // Required configuration since W9; the fake runtime accepts and ignores the caps they become.
  process.env["ASHARA_CELL_MEMORY"] = "4g";
  process.env["ASHARA_CELL_CPUS"] = "4";
  process.env["ASHARA_CELL_PIDS_LIMIT"] = "1024";
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/**
 * The simulator runs outside an Ashara git checkout. Production then refuses every target workspace
 * (development workspace.ts resolves its own repository root with git and fails closed without one),
 * so a seed would end in a different outcome than in a checkout: not a result, a wrong place to run.
 */
class SimulatorOutsideCheckout extends Error {
  constructor(
    readonly moduleDir: string,
    readonly detail: string,
  ) {
    super(
      `the simulator must run inside an Ashara git checkout (production resolves its repository root with git from its own ` +
        `source and refuses every target workspace without one); git rev-parse --show-toplevel failed from ${moduleDir}: ${detail}`,
    );
    this.name = "SimulatorOutsideCheckout";
  }
}

async function assertGitCheckout(): Promise<void> {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  try {
    await promisify(execFile)("git", ["rev-parse", "--show-toplevel"], { cwd: moduleDir });
  } catch (err) {
    throw new SimulatorOutsideCheckout(moduleDir, describeErrorChain(err));
  }
}

/**
 * Replaces each id, commit and hex digest by its kind and order of first appearance (design §4.3),
 * and the run's own working directory, drawn by mkdtemp, by a fixed name.
 */
function canonical(lines: readonly string[], workdir: string): string[] {
  const seen = new Map<string, string>();
  const name = (kind: string, raw: string): string => {
    const known = seen.get(raw);
    if (known !== undefined) return known;
    const fresh = `<${kind}#${[...seen.values()].filter((v) => v.startsWith(`<${kind}#`)).length + 1}>`;
    seen.set(raw, fresh);
    return fresh;
  };
  return lines.map((line) =>
    line
      .replaceAll(workdir, "<workdir>")
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (m) => name("id", m))
      .replace(/\b[0-9a-f]{64}\b/g, (m) => name("hash", m))
      .replace(/\b[0-9a-f]{40}\b/g, (m) => name("commit", m)),
  );
}

/**
 * I1, the connection clause, judged when a process ends on its own terms (a drain or the run's
 * end), with no cycle in flight: a connection still checked out is one no code will release. It
 * shrinks the pool for good and holds the pool's end forever, so it is destroyed here and named.
 */
function leakedConnections(handle: InstanceHandle, step: number): Violation[] {
  const leaked = [...handle.checkouts];
  handle.checkouts.clear();
  return leaked.map(([client, sent]) => {
    client.release(true);
    const queries = sent.length === 0 ? "none" : sent.join("; ");
    return {
      invariant: "I1",
      step,
      statement: `${handle.name} ended holding a database connection nothing released (queries sent on it: ${queries}); each such leak shrinks the pool for good`,
      key: `I1:leaked-connection:${sent[0] ?? "none"}`,
    };
  });
}

const questionRow = z.array(z.object({ id: z.string() }));

async function firstQuestion(observer: Database, projectId: string): Promise<string | null> {
  const result = await observer.execute(sql`
    SELECT id FROM client_messages WHERE project_id = ${projectId} AND kind = 'question' ORDER BY created_at, position LIMIT 1`);
  return questionRow.parse(result.rows)[0]?.id ?? null;
}

/** What a snapshot shows of the execution statuses the cycle's routing produced (none is logged by status). */
function executionEvidence(snapshot: Snapshot, statuses: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const status of statuses) if (status === "refused" || status === "interrupted" || status === "failed" || status === "blocked") seen.add(status);
  for (const event of snapshot.events) if (event.eventType === "work_item.completed") seen.add("completed");
  for (const item of snapshot.items) {
    const source = sourceOf(item.blockedReason);
    if (source === "environment_unavailable") seen.add("environment_blocked");
    if (source === "environment_undefined") seen.add("environment_undefined");
    if (source === "checks_stale" || source === "checks_rewrite_bound") seen.add("checks_stale");
    if (source === "check_disputed") seen.add("disputed");
    if (source === "suite_review_unresolved") seen.add("suite_review_problems");
    if (source === "environment_change_needed") seen.add("environment_change_requested");
    if (source === "owner_unresolved") seen.add("owner_unresolved");
  }
  for (const event of snapshot.events) {
    if (event.eventType === "work_item.awaiting_environment") seen.add("environment_change_requested");
    if (event.eventType === "work_item.awaiting_checks") seen.add("disputed");
  }
  return [...seen];
}

/** A second project's violation is keyed and stated as its own. */
function ofProject(index: number, violation: Violation): Violation {
  if (index === 0) return violation;
  const at = violation.key.indexOf(":");
  return { ...violation, key: `${violation.key.slice(0, at)}:p${index + 1}${violation.key.slice(at)}`, statement: `project ${index + 1}: ${violation.statement}` };
}

/** Where a project's end stands: a halt that ends and begins again is not one end. */
function standing(snapshot: Snapshot): string {
  return `${snapshot.project.status}(${snapshot.project.blockedCategory ?? ""})#${snapshot.episodes.length}`;
}

/**
 * One seed, start to end (design §4.8-§4.11): the real system composed over a private scratch
 * database, real git, the fake container runtime and the scripted models; the invariants judged
 * after every cycle; crashes and SIGTERMs answered by composing a new instance on the same workdir.
 */
export async function runSeed(options: RunOptions): Promise<RunResult> {
  await assertGitCheckout();
  const started = Date.now();
  const tape = new Tape(options.tape);
  const rates = drawRates(options.profile, tape);
  const clock = new SimClock();
  const universe = drawUniverse(tape);
  const capUsd =
    options.capUsd ?? (tape.chance("finance.low-budget", rates.lowBudget) ? LOW_CAP_USD : options.profile === "adversarial" ? ADVERSARIAL_CAP_USD : DEFAULT_CAP_USD);
  const projectCount = options.projects ?? 1;
  const lateChange = tape.chance("client.late-change", rates.lateChange);
  const stopAt = tape.chance("client.stop", rates.clientStop) ? 2 + tape.pick("client.stop-cycle", 30) : null;
  const trace: string[] = [`universe ${universe.tasks.map((t) => `${t.ref}=${t.behaviours.join("+")}`).join(" ")}${universe.independent ? " independent" : ""} cap=${capUsd}${projectCount > 1 ? ` projects=${projectCount}` : ""}`];
  const log: string[] = [];
  const violations = new Map<string, Violation>();
  const coverage = emptyCoverage();
  const report = (violation: Violation): void => {
    if (!violations.has(violation.key)) violations.set(violation.key, violation);
  };
  let outcome: Outcome = { kind: "open" };
  let cycles = 0;
  let dispatches = 0;
  let restarts = 0;

  let checkouts = new CheckoutWatch(report);
  const onInterleave = (event: InterleaveEvent): void => {
    switch (event.kind) {
      case "batch":
        coverage.concurrency.add("batch-of-two");
        break;
      case "switch":
        coverage.concurrency.add("turn-handed-on");
        trace.push(`turn ${event.from}->${event.to} at ${event.at}`);
        break;
      case "contended":
        coverage.concurrency.add(`contended:${event.wait}`);
        trace.push(`task ${event.lane} waits on another task (${event.wait})`);
        break;
      case "bypassed":
        trace.push(`mutation: ${event.wait} wait skipped`);
        break;
      case "lane-ended":
        checkouts.taskEnded(event.taskId);
        break;
      case "stall":
        report({ invariant: "I1", step: cycles, statement: `the batch stalled (an in-process wait between its tasks the simulator does not model, or a deadlock): ${event.detail}`, key: "I1:interleave-stall" });
        break;
    }
  };
  const planted = options.mutation === undefined ? null : PLANTED[options.mutation];
  const interleaver = new Interleaver(tape, new Set(planted?.bypassed ?? []), onInterleave);
  const scheduler = new Scheduler(tape, FAULTS[options.profile], interleaver, options.forcedFaults);
  const admissions = new AdmissionLedger();
  const gitDates = new GitDates();
  let longestQuiet = 0;

  const workdir = await realpath(await mkdtemp(join(tmpdir(), "ashara-sim-")));
  const restoreIds = seededIds(options.seed);
  const restoreConsole = capturedConsole(log);
  const restoreEnv = simulatedEnvironment(workdir, capUsd);
  const restoreWaits = observeContendedWaits(interleaver.contended);
  const restoreCode = planted?.code?.() ?? null;
  const restoreSweeps = observeAcceptanceSweeps((sweep) => {
    coverage.sweeps.add(sweep);
    trace.push(`acceptance sweep ${sweep}`);
  });
  let database: RunDatabase | null = null;
  let observer: Database | null = null;
  let instance: Live | null = null;
  const gitBroker = new GitBroker();
  try {
    database = await createRunDatabase(options.databaseUrl, options.template, options.seed);
    const db = database;
    const observing = createDb(db.url, (config) => new pg.Pool({ ...config, application_name: "ashara-sim-observer", max: 2 }));
    observer = observing;
    const keyDir = await mkdtemp(join(tmpdir(), "ashara-sim-key-"));
    const keyFile = join(keyDir, "master.key");
    createKeyFile(keyFile);
    const masterKey: MasterKey = loadMasterKey(keyFile);
    await rm(keyDir, { recursive: true, force: true });
    const secrets = new SecretStore(new SecretRepository(observing), masterKey);
    await secrets.put("server/api_token", "simulator-api-token");
    await secrets.put("provider/openai/api_key", "simulator-provider-key");

    const createProject = async (suffix: string) => {
      const client = await new ClientRepository(observing).create(`sim-client-${options.seed}${suffix}`);
      const tender = await createProjectWithTender(observing, client.id, `sim-${options.seed}${suffix}`, `Build a product with ${universe.behaviours.join(", ")}.`);
      return tender.project.id;
    };
    // The client's late change and stop are the first project's; its outcome is the run's.
    const projectId = await createProject("");
    const projectIds = [projectId];
    for (let index = 1; index < projectCount; index++) projectIds.push(await createProject(`-p${index + 1}`));
    const snapshotsOf = async (): Promise<[Snapshot, ...Snapshot[]]> => {
      const first = await readSnapshot(observing, projectId);
      const rest: Snapshot[] = [];
      for (const id of projectIds.slice(1)) rest.push(await readSnapshot(observing, id));
      return [first, ...rest];
    };

    const standIns = new StandIns({
      tape,
      rates,
      universe,
      observer: observing,
      projectIds,
      onModelCall: (call) => trace.push(`model ${call.site} ${call.action}`),
      laneTask: () => interleaver.currentTask(),
    });
    const baseCell = await loadBaseCell();
    const observe = (event: PodmanEvent): void => {
      switch (event.kind) {
        case "cell-started":
          trace.push(`cell ${event.cell.labels["ashara.task"] ?? "?"} role=${event.cell.labels["ashara.role"] ?? "?"} tokens=${event.cell.tokens.join("+")}`);
          break;
        case "image-built":
          trace.push(`image ${event.id} tokens=${event.tokens.join("+")} context=${event.contextFiles.join(",")}`);
          break;
        case "command":
          trace.push(`exec ${event.command.split(" ").slice(0, 3).join(" ")} -> ${event.hung ? "hung" : event.exitCode}`);
          break;
        case "cell-removed":
          break;
      }
    };
    const podman = new FakePodman({ baseImage: baseCell.image, tape, observe });
    const terminateBackend = async (pid: number): Promise<void> => {
      await observing.execute(sql`SELECT pg_terminate_backend(${pid})`);
    };

    const instanceName = (of: number): string => `ashara-sim-${process.pid}-${of}`;
    const backendsOf = async (name: string): Promise<number> => {
      const result = await observing.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = ${name}`);
      return z.tuple([z.object({ n: z.number().int() })]).parse(result.rows)[0].n;
    };
    /** Polls until the instance has no backend left; the count still left when the bound ran out. */
    const backendsAfterExit = async (name: string): Promise<number> => {
      for (let polls = 0; ; polls++) {
        const left = await backendsOf(name);
        if (left === 0 || polls >= BACKEND_EXIT_POLLS) return left;
        await new Promise((resolve) => setTimeout(resolve, BACKEND_EXIT_POLL_MS));
      }
    };
    /**
     * A process's death, as the database sees it: every backend the instance opened ends, its
     * pool's and the target claim's session alike (the claim connects outside the pool, named by
     * the connection string), and the restart waits until they are gone, so a claim the dead
     * process held is released before the next instance takes it, as a real crash releases it.
     */
    const killBackends = async (of: number): Promise<void> => {
      const name = instanceName(of);
      await observing.execute(sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = ${name}`);
      const left = await backendsAfterExit(name);
      if (left > 0) throw new BackendsOutlivedInstance(name, left);
    };

    let generation = 0;
    const compose = async (): Promise<Live> => {
      for (;;) {
        generation += 1;
        const handle: InstanceHandle = { name: `sim-${generation}`, dead: false, abort: null, sigtermed: false, fatal: null, checkouts: new Map() };
        // A new process stages nothing yet: the dead one's staged merge is an orphan its recovery clears.
        checkouts = new CheckoutWatch(report);
        const seam = { scheduler, instance: handle, clock, terminateBackend, interleaver, checkouts, cycle: () => cycles, admissions, cellOutage: options.cellOutage === true, gitDates };
        try {
          const ashara = await composeAshara({
            masterKey,
            databaseUrl: instanceUrl(db.url, instanceName(generation)),
            createPool: faultingPools(seam, instanceName(generation), planted?.queries ?? null),
            models: faultingModels(seam, standIns.factory),
            processRunner: faultingPodman(seam, podman.runner),
            git: faultingGit(seam, gitBroker.runner),
            clock,
            taskLanes: interleaver.lanes,
          });
          handle.abort = () => ashara.abort();
          await ashara.startup();
          trace.push(`instance ${handle.name} started`);
          return { ashara, handle, generation };
        } catch (err) {
          // A process that cannot boot is restarted, as a supervisor would; the fault budget bounds it.
          trace.push(`instance ${handle.name} failed to boot: ${err instanceof SimulatedCrash ? "crash" : (err instanceof Error ? err.name : "error")}`);
          handle.dead = true;
          if (!(err instanceof SimulatedCrash)) log.push(`boot of ${handle.name} failed: ${describeErrorChain(err)}`);
          // Every earlier instance's sessions are gone before a boot (killBackends, the drain's
          // check), so a refused claim is one nothing in this run holds: never a retry, a finding.
          if (err instanceof Error && err.name === "TargetCheckoutClaimedElsewhere") {
            const violation: Violation = { invariant: "I1", step: cycles, statement: `${handle.name} was refused its target claim with no other instance alive: ${err.message}`, key: "I1:claim-refused" };
            violations.set(violation.key, violation);
          }
          await killBackends(generation);
          if (generation > MAX_BOOTS) throw new BootsExhausted(options.seed, generation, err);
        }
      }
    };

    /** A restart after a crash or a SIGTERM: the dead process's backends end, its host state stays. */
    const restart = async (current: Live, why: string): Promise<void> => {
      restarts += 1;
      trace.push(`restart after ${why}`);
      if (current.handle.sigtermed && !current.handle.dead) {
        try {
          await current.ashara.teardownCells();
        } catch (err) {
          trace.push(`drain: teardown failed ${err instanceof Error ? err.name : "error"}`);
        }
        for (const violation of leakedConnections(current.handle, cycles)) violations.set(violation.key, violation);
        await current.ashara.closeDatabase();
        // A drain ends its own sessions, the target claim's included (closeDatabase): one left is
        // a claim the next process would be refused on, named here before it is killed.
        const left = await backendsAfterExit(instanceName(current.generation));
        if (left > 0) {
          const violation: Violation = { invariant: "I1", step: cycles, statement: `${current.handle.name} drained and closed its database yet ${left} of its session(s) stayed open`, key: `I1:drain-left-sessions:${restarts}` };
          violations.set(violation.key, violation);
          await killBackends(current.generation);
        }
      } else {
        current.handle.dead = true;
        await killBackends(current.generation);
      }
      instance = await compose();
      // I7, restart clause: the reconciler leaves nothing InProgress and no cell of the dead process.
      for (const [index, after] of (await snapshotsOf()).entries()) {
        for (const item of after.items.filter((i) => i.status === "InProgress" && i.level === "Task")) {
          const violation = ofProject(index, { invariant: "I7", step: cycles, statement: `after the restart, "${item.title}" is InProgress with no live attempt`, key: `I7:orphan:${item.title}:${restarts}` });
          violations.set(violation.key, violation);
        }
      }
      if (podman.liveCells().length > 0) {
        const violation: Violation = { invariant: "I7", step: cycles, statement: `after the restart, ${podman.liveCells().length} cell(s) of the dead process are still running`, key: `I7:cells:${restarts}` };
        violations.set(violation.key, violation);
      }
    };

    instance = await compose();
    const reached = new Set<string>();
    let quiet = 0;
    let faultsSeen = 0;
    let restartsSeen = 0;
    let noProgress = false;
    let changed = false;
    let settleLeft: number | null = null;
    let settledOn = "";
    while (cycles < options.maxCycles) {
      if (Date.now() - started > options.timeoutMs) {
        const violation: Violation = { invariant: "I1", step: cycles, statement: `the seed ran past its ${options.timeoutMs} ms wall clock`, key: "I1:timeout" };
        violations.set(violation.key, violation);
        break;
      }
      cycles += 1;
      if (stopAt !== null && cycles === stopAt) {
        await new ClientMessageRepository(observing).insertInbound({ projectId, kind: "stop", body: "Please stop the work.", inReplyTo: null });
        trace.push(`client stop at cycle ${cycles}`);
      }
      const current: Live = instance;
      // F12: a lost wake skips a cycle; a duplicated one runs two back to back.
      if (tape.chance("wake.lost", FAULTS[options.profile].perSeamCall * 10)) {
        trace.push(`cycle ${cycles}: wake lost`);
        continue;
      }
      const repeats = tape.chance("wake.duplicated", FAULTS[options.profile].perSeamCall * 10) ? 2 : 1;
      const statuses: string[] = [];
      let processed = 0;
      let crashed = false;
      for (let r = 0; r < repeats && !crashed; r++) {
        try {
          const result = await current.ashara.cycles.runCycle();
          dispatches += result.tasksProcessed;
          processed += result.tasksProcessed;
          for (const task of result.results) statuses.push(task.status);
          trace.push(`cycle ${cycles}: ${result.tasksProcessed} task(s) [${result.results.map((t) => t.status).join(",")}]${result.stop === null ? "" : ` stop: ${result.stop.reason.split(":")[0] ?? ""}`}`);
          if (result.stop !== null && !current.handle.dead) outcome = { kind: "halted", cause: "spend_cap", detail: result.stop.reason };
        } catch (err) {
          trace.push(`cycle ${cycles}: error ${err instanceof SimulatedCrash ? "SimulatedCrash" : err instanceof Error ? err.name : "unknown"}`);
          if (!(err instanceof SimulatedCrash) && !current.handle.dead) log.push(`cycle error: ${describeErrorChain(err)}`);
        }
        crashed = current.handle.dead || current.handle.sigtermed;
      }
      // The runner's own wait between cycles (orchestrator runner.ts defaults), on the simulated clock.
      clock.jump(processed > 0 ? POLL_INTERVAL_MS : IDLE_INTERVAL_MS);
      if (current.handle.fatal !== null) trace.push(`fatal exit: ${current.handle.fatal.split(":")[0] ?? ""}`);
      if (current.handle.dead) await restart(current, current.handle.fatal === null ? "a crash" : "a fatal exit");
      else if (current.handle.sigtermed) await restart(current, "a SIGTERM");

      const snapshots = await snapshotsOf();
      const [snapshot] = snapshots;
      for (const [index, each] of snapshots.entries()) {
        for (const violation of checkSnapshot(cycles, each, { spendCapUsd: capUsd, cells: podman.liveCells(), final: false })) report(ofProject(index, violation));
        sample(coverage, each, scheduler.faults(), executionEvidence(each, statuses));
      }
      const overCommitted = await admissions.judge(observing, capUsd, cycles);
      if (overCommitted !== null) report(overCommitted);
      trace.push(
        snapshots
          .map((each) => `state ${each.items.filter((i) => i.level === "Task").map((i) => `${i.title.slice(0, 40)}=${i.status}`).join("; ")} | project=${each.project.status}`)
          .join(" || "),
      );

      if (lateChange && !changed && snapshot.items.some((i) => i.origin === "decomposition" && i.status === "Completed")) {
        const question = await firstQuestion(observing, projectId);
        if (question !== null) {
          await new ClientMessageRepository(observing).insertInbound({ projectId, kind: "answer", body: "Use French, please.", inReplyTo: question });
          changed = true;
          trace.push(`client answer changes an assumption at cycle ${cycles}`);
        }
      }

      // I8's measure: a fact of any project reached for the first time. A cycle that carried an
      // injected fault, a duplicated wake or a restart neither progresses nor counts against it.
      let fresh = 0;
      for (const [index, each] of snapshots.entries()) {
        for (const fact of progressFacts(each)) {
          if (reached.has(`${index}:${fact}`)) continue;
          reached.add(`${index}:${fact}`);
          fresh += 1;
        }
      }
      const faulted = scheduler.faults().length > faultsSeen || restarts > restartsSeen || repeats > 1;
      faultsSeen = scheduler.faults().length;
      restartsSeen = restarts;
      if (fresh > 0) quiet = 0;
      else if (!faulted) quiet += 1;
      longestQuiet = Math.max(longestQuiet, quiet);
      if (quiet >= NO_PROGRESS_CYCLES) {
        noProgress = true;
        break;
      }

      // An ended project runs a few more cycles: what it owes the client (a report) is sent on them.
      // A late client change can reopen an accepted project, and a halt can end and begin again (a
      // new episode): then it is not settling. Every project of the run ends before the run does.
      const spendHalt = outcome.kind === "halted" && outcome.cause === "spend_cap";
      const ends = snapshots.map(outcomeOf);
      const stand = snapshots.map(standing).join(" ");
      if (settleLeft !== null && !spendHalt && (ends.some((end) => end.kind === "open") || stand !== settledOn)) settleLeft = null;
      if (settleLeft !== null) {
        settleLeft -= 1;
        if (settleLeft <= 0) break;
        continue;
      }
      if (!spendHalt) outcome = outcomeOf(snapshot);
      if (spendHalt || ends.every((end) => end.kind !== "open")) {
        settleLeft = SETTLE_CYCLES;
        settledOn = stand;
      }
    }

    const finals = await snapshotsOf();
    await sampleModelPaths(coverage, observing, projectIds);
    const [final] = finals;
    // The report clause needs the settle cycles a halt's report is posted on: a run cut off for no
    // progress had none, and may end on a halt begun in its last cycle (I8 judges that run).
    for (const [index, each] of finals.entries()) {
      for (const violation of checkSnapshot(cycles, each, { spendCapUsd: capUsd, cells: podman.liveCells(), final: !noProgress })) report(ofProject(index, violation));
    }
    const overCommitted = await admissions.judge(observing, capUsd, cycles);
    if (overCommitted !== null) report(overCommitted);
    const spendHalted = outcome.kind === "halted" && outcome.cause === "spend_cap";
    // A run that made no progress did not end, whatever its last snapshot shows (a halt it resumes).
    if (noProgress) outcome = { kind: "open" };
    else if (outcome.kind !== "open" && !spendHalted) outcome = outcomeOf(final);
    // I6, the product clause: an accepted project's main holds every behaviour the client asked for.
    for (const [index, each] of finals.entries()) {
      const end = index === 0 ? outcome : outcomeOf(each);
      if (end.kind !== "accepted" || each.project.workspacePath === null) continue;
      const files = new Set(await mainFiles(each.project.workspacePath));
      const missing = universe.behaviours.filter((b) => !files.has(behaviourPath(b)));
      if (missing.length > 0) {
        report(ofProject(index, { invariant: "I6", step: cycles, statement: `the project was accepted with behaviour(s) ${missing.join(", ")} absent from main`, key: "I6:accepted-missing" }));
      }
    }
    const tasks = finals.reduce((sum, each) => sum + each.items.filter((item) => item.level === "Task").length, 0);
    const bound = (REPAIRS + 1) * Math.max(tasks, 1) * ATTEMPTS * (1 + CONTESTS * ATTEMPTS);
    const open = finals.filter((each, index) => noProgress || (index === 0 ? outcome.kind === "open" : !spendHalted && outcomeOf(each).kind === "open"));
    if (open.length > 0) {
      const stuck = open
        .flatMap((each) => each.items)
        .filter((item) => item.level === "Task" && item.status !== "Completed" && item.status !== "Abandoned")
        .map((item) => `"${item.title}" ${item.status}${sourceOf(item.blockedReason) === null ? "" : ` (${sourceOf(item.blockedReason) ?? ""})`}`);
      const statement = noProgress
        ? `the project made no progress for ${NO_PROGRESS_CYCLES} fault-free cycles and is neither accepted, halted nor stopped: ${stuck.join(", ")}`
        : `the project did not end within ${options.maxCycles} cycles: ${stuck.join(", ")}`;
      violations.set("I1:open", { invariant: "I1", step: cycles, statement, key: "I1:open" });
      if (noProgress) {
        for (const [index, each] of finals.entries()) for (const violation of checkTotality(cycles, each, NO_PROGRESS_CYCLES)) violations.set(ofProject(index, violation).key, ofProject(index, violation));
      }
    }
    if (dispatches > bound) {
      violations.set("I1:bound", { invariant: "I1", step: cycles, statement: `${dispatches} dispatches exceed the bound ${bound}`, key: "I1:bound" });
    }
    trace.push(`outcome ${outcome.kind}${outcome.kind === "halted" ? ` ${outcome.cause}` : ""}`);
  } catch (err) {
    log.push(`harness error: ${describeErrorChain(err)}`);
    throw err;
  } finally {
    const live: Live | null = instance;
    if (live !== null) {
      live.handle.dead = true;
      live.ashara.abort();
      for (const violation of leakedConnections(live.handle, cycles)) violations.set(violation.key, violation);
      await live.ashara.closeDatabase().catch((err: unknown) => log.push(`close: ${describeErrorChain(err)}`));
    }
    if (observer !== null) await observer.$client.end();
    if (database !== null) await database.drop();
    gitBroker.close();
    restoreCode?.();
    restoreSweeps();
    restoreWaits();
    restoreEnv();
    restoreConsole();
    restoreIds();
    await rm(workdir, { recursive: true, force: true });
  }
  return {
    seed: options.seed,
    profile: options.profile,
    outcome,
    violations: [...violations.values()],
    // The violations close the trace, so one equality covers what a run did and what it was judged to have done.
    trace: canonical([...trace, ...[...violations.values()].map((violation) => `violation ${violation.key}: ${violation.statement}`)], workdir),
    decisions: tape.decisions(),
    coverage,
    cycles,
    dispatches,
    restarts,
    faults: scheduler.faults(),
    tickets: scheduler.tickets(),
    durationMs: Date.now() - started,
    longestQuiet,
    log,
  };
}
