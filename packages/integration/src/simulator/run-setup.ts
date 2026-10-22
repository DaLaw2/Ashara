import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import pg from "pg";
import { ClientRepository, createDb } from "@ashara/db";
import { loadBaseCell } from "@ashara/execution-infra";
import { SecretRepository, SecretStore } from "@ashara/security";
import { clientAccessCodeSecretName, createKeyFile, loadMasterKey } from "@ashara/security";
import type { MasterKey } from "@ashara/security";
import { describeErrorChain, observeContendedWaits } from "@ashara/shared";
import { AdmissionLedger } from "./admissions.js";
import { drawCorrection } from "./correction-draws.js";
import type { CorrectionDraw } from "./correction-draws.js";
import { observeAcceptanceSweeps } from "./coverage.js";
import { createRunDatabase } from "./database.js";
import type { Database, RunDatabase } from "./database.js";
import { FakePodman } from "./fake-podman.js";
import type { FakeCell, PodmanEvent } from "./fake-podman.js";
import { GitDates, Scheduler, SimClock } from "./faults.js";
import type { QueryPlant } from "./faults.js";
import { GitBroker } from "./git-broker.js";
import { Interleaver } from "./interleave.js";
import type { InterleaveEvent } from "./interleave.js";
import { SilenceWatch } from "./invariants.js";
import { LogCorrelationJudge } from "./log-correlation.js";
import { refusedModelSchemas } from "./model-schemas.js";
import { drawUniverse } from "./product.js";
import type { Universe } from "./product.js";
import { Personas } from "./personas.js";
import { PLANTED, plantsBypassing } from "./plants.js";
import { FAULTS, drawRates } from "./profile.js";
import { ResidueWatch } from "./residue.js";
import type { Corruption } from "./run-cycle-loop.js";
import { leakedConnections, stopIfAborted } from "./run-instance.js";
import type { RunState } from "./run-instance.js";
import type { RunOptions } from "./run.js";
import { StandIns } from "./scripted-models.js";
import { SimulatedClient } from "./simulated-client.js";
import { Tape } from "./tape.js";
import { PortCount, TerminationWatch } from "./termination.js";
import { WORK_BOUNDS } from "./work-bounds.js";

const DEFAULT_CAP_USD = 25;
/**
 * The adversarial profile's cap. Every stand-in call is unpriced and counts at its worst-case
 * estimate (about $0.35 at a turn's bound), and misbehaving responses are retried, so at the
 * default cap most adversarial seeds halt at the cap before the paths after a misbehaviour are
 * reached.
 */
const ADVERSARIAL_CAP_USD = 100;
/**
 * The liveness profile's cap: out of reach, so what ends a project is a typed state and never the
 * dollars (termination.ts W4). Two projects each drawing the bounds table's whole budget at a
 * dollar a request, a ceiling no stand-in call's worst-case estimate reaches, spend no more.
 */
const LIVENESS_CAP_USD = 2 * WORK_BOUNDS.requestsPerProject.value;
const LOW_CAP_USD = 0.02;
/**
 * The cap of a run whose correction arrives once its project is halted: out of reach of the work up
 * to the halt it waits for, which at the default cap two projects' work spends before it in most runs.
 */
const HALTED_ARRIVAL_CAP_USD = 100;

const SIM_ENV = [
  "WORKDIR_BASE",
  "ASHARA_BUDGET_LIMIT_USD",
  "ASHARA_BUDGET_TOTAL",
  "ASHARA_PROJECT_BUDGET_LIMIT_USD",
  // Unset for the run: the work budgets are production's policy defaults.
  "ASHARA_TASK_WORK_BUDGET_REQUESTS",
  "ASHARA_PROJECT_WORK_BUDGET_REQUESTS",
  "ASHARA_WORK_RESERVE_PERCENT",
  // Unset for the run: the lane count is production's default (server config.ts), two lanes.
  "ASHARA_TASK_LANES",
  "MAX_BATCH_SIZE",
  "ASHARA_CELL_MEMORY",
  "ASHARA_CELL_CPUS",
  "ASHARA_CELL_PIDS_LIMIT",
] as const;

/** The containment scenario was asked of a run without the second project it corrupts. */
class CorruptionWithoutSecondProject extends Error {
  constructor(readonly seed: number) {
    super(`seed ${seed}: corruptSecondProject needs projects: 2, so one project stays healthy for I8 to judge`);
    this.name = "CorruptionWithoutSecondProject";
  }
}

/** One step of a run's cleanup threw; the step is named, its error kept as the cause. */
export class CleanupStepFailed extends Error {
  constructor(
    readonly step: string,
    readonly failure: unknown,
  ) {
    super(`${step} failed: ${describeErrorChain(failure)}`, { cause: failure });
    this.name = "CleanupStepFailed";
  }
}

/** What the seed's tape draws for the whole run, in the order it draws them. */
export interface RunDraws {
  readonly tape: Tape;
  readonly rates: ReturnType<typeof drawRates>;
  readonly clock: SimClock;
  readonly universe: Universe;
  readonly personas: Personas;
  readonly capUsd: number;
  readonly projectCount: 1 | 2;
  /** What the containment scenario has corrupted so far; null when the run has none. */
  readonly corruption: Corruption | null;
  readonly lateChange: boolean;
  readonly correctionDraw: CorrectionDraw | null;
  readonly heldReturns: boolean;
  /** The cycle the client asks the work to stop at, or null when it never does. */
  readonly stopAt: number | null;
}

/** The run's draws, its first trace lines the universe and the personas drawn. */
export function drawRun(options: RunOptions, state: RunState): RunDraws {
  const tape = new Tape(options.tape);
  const correctionDraw = drawCorrection(tape);
  const drawn = drawRates(options.profile, tape);
  // A correction is read under a halt only while Ashara may still call a model, which a spend-cap halt
  // forbids. At a halted arrival every implementation meets a decision only the client can make, so the
  // project halts waiting on the client, who sends the correction instead of an answer and never stops
  // the work; no attempt runs out of turns, and the cap is out of the work's reach, so no spend-cap halt
  // comes first.
  const halting = correctionDraw?.arrival === "halted";
  const rates = halting ? { ...drawn, blockedOnClient: 1, timeout: 0, clientStop: 0 } : drawn;
  const clock = new SimClock();
  const universe = drawUniverse(tape);
  const personas = Personas.draw(options.profile, tape, () => state.cycles);
  const profileCap =
    options.profile === "adversarial"
      ? ADVERSARIAL_CAP_USD
      : options.profile === "liveness"
        ? LIVENESS_CAP_USD
        : DEFAULT_CAP_USD;
  const capUsd =
    options.capUsd ??
    (halting
      ? Math.max(profileCap, HALTED_ARRIVAL_CAP_USD)
      : tape.chance("finance.low-budget", rates.lowBudget)
        ? LOW_CAP_USD
        : profileCap);
  const projectCount = options.projects ?? 1;
  if (options.corruptSecondProject === true && projectCount < 2) throw new CorruptionWithoutSecondProject(options.seed);
  const corruption: Corruption | null =
    options.corruptSecondProject === true ? { taskSpec: false, blockKind: false, contained: new Set() } : null;
  const lateChange = tape.chance("client.late-change", rates.lateChange);
  const heldReturns = correctionDraw !== null && tape.chance("correction.held-returns", rates.lateChange);
  const stopAt = tape.chance("client.stop", rates.clientStop) ? 2 + tape.pick("client.stop-cycle", 30) : null;
  const tasks = universe.tasks.map((t) => `${t.ref}=${t.behaviours.join("+")}`).join(" ");
  const independent = universe.independent ? " independent" : "";
  const shape = `${independent}${universe.unverifiable ? " unverifiable" : ""} cap=${capUsd}`;
  state.trace.push(
    `universe ${tasks}${shape}${projectCount > 1 ? ` projects=${projectCount}` : ""}`,
    personas.describe(),
  );
  return {
    tape,
    rates,
    clock,
    universe,
    personas,
    capUsd,
    projectCount,
    corruption,
    lateChange,
    correctionDraw,
    heldReturns,
    stopAt,
  };
}

/** The run's watches and seams, each made once, outside production. */
export interface RunWorld {
  /** L1, judging every record every instance logs as it is written, whatever the run's records keep. */
  readonly correlation: LogCorrelationJudge;
  readonly planted: (typeof PLANTED)[keyof typeof PLANTED] | null;
  readonly queryPlant: QueryPlant | null;
  readonly interleaver: Interleaver;
  readonly scheduler: Scheduler;
  /** W1's measure, taken at the model port, outside production; W2's and W3's records, cycle by cycle. */
  readonly port: PortCount;
  readonly termination: TerminationWatch;
  readonly admissions: AdmissionLedger;
  readonly residue: ResidueWatch;
  readonly silence: SilenceWatch;
  readonly gitDates: GitDates;
  /** The tasks a stand-in answered for in the cycle running now (I10's window). */
  readonly consulted: Set<string>;
}

/** What one interleaving event adds to the run's coverage, trace and verdicts. */
function observeInterleave(state: RunState, event: InterleaveEvent): void {
  switch (event.kind) {
    case "batch":
      state.coverage.concurrency.add("batch-of-two");
      break;
    case "switch":
      state.coverage.concurrency.add("turn-handed-on");
      state.trace.push(`turn ${event.from}->${event.to} at ${event.at}`);
      break;
    case "contended":
      state.coverage.concurrency.add(`contended:${event.wait}`);
      for (const mutation of plantsBypassing(event.wait)) state.coverage.plants.add(mutation);
      state.trace.push(`task ${event.lane} waits on another task (${event.wait})`);
      break;
    case "bypassed":
      state.trace.push(`mutation: ${event.wait} wait skipped`);
      break;
    case "lane-ended":
      state.checkouts.taskEnded(event.taskId);
      break;
    case "stall":
      state.report({
        invariant: "I1",
        step: state.cycles,
        statement:
          "the batch stalled (an in-process wait between its tasks the simulator does not model, " +
          `or a deadlock): ${event.detail}`,
        key: "I1:interleave-stall",
      });
      break;
  }
}

export function buildWorld(options: RunOptions, draws: RunDraws, state: RunState): RunWorld {
  const correlation = new LogCorrelationJudge();
  const planted = options.mutation === undefined ? null : PLANTED[options.mutation];
  const plantedQueries = planted?.queries ?? null;
  const queryPlant: QueryPlant | null =
    plantedQueries === null
      ? null
      : (args) => {
          const sent = plantedQueries(args);
          if (sent !== null) state.bites += 1;
          return sent;
        };
  const interleaver = new Interleaver(
    draws.tape,
    // eslint-disable-next-line no-restricted-syntax -- policy default: a run with no plant bypasses no seam
    new Set(planted?.bypassed ?? []),
    (event) => observeInterleave(state, event),
  );
  const scheduler = new Scheduler(draws.tape, FAULTS[options.profile], interleaver);
  return {
    correlation,
    planted,
    queryPlant,
    interleaver,
    scheduler,
    port: new PortCount(),
    termination: new TerminationWatch(),
    admissions: new AdmissionLedger(),
    residue: new ResidueWatch(),
    silence: new SilenceWatch(),
    gitDates: new GitDates(),
    consulted: new Set<string>(),
  };
}

/** Ids are drawn from the seed while a run lasts, so two runs of one seed order equal-time rows alike. */
function seededIds(seed: number): () => void {
  const require = createRequire(import.meta.url);
  const cryptoModule: object = require("node:crypto");
  const original: unknown = Reflect.get(cryptoModule, "randomUUID");
  const webOriginal: unknown = Reflect.get(globalThis.crypto, "randomUUID");
  const source = { state: (seed ^ 0x5bd1e995) >>> 0 };
  const next = (): number => {
    source.state = (Math.imul(source.state ^ (source.state >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
    return source.state;
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

function simulatedEnvironment(workdir: string, capUsd: number): () => void {
  const saved = new Map(SIM_ENV.map((key) => [key, process.env[key]]));
  process.env["WORKDIR_BASE"] = workdir;
  process.env["ASHARA_BUDGET_LIMIT_USD"] = String(capUsd);
  delete process.env["ASHARA_BUDGET_TOTAL"];
  delete process.env["ASHARA_PROJECT_BUDGET_LIMIT_USD"];
  delete process.env["ASHARA_TASK_WORK_BUDGET_REQUESTS"];
  delete process.env["ASHARA_PROJECT_WORK_BUDGET_REQUESTS"];
  delete process.env["ASHARA_WORK_RESERVE_PERCENT"];
  delete process.env["ASHARA_TASK_LANES"];
  delete process.env["MAX_BATCH_SIZE"];
  // Required configuration; the fake runtime accepts and ignores the caps they become. Small, so the
  // boot's check that the lanes' cells fit the host the fake runtime reports passes.
  process.env["ASHARA_CELL_MEMORY"] = "256m";
  process.env["ASHARA_CELL_CPUS"] = "0.25";
  process.env["ASHARA_CELL_PIDS_LIMIT"] = "1024";
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/** The process-wide state a run sets (the environment, the id source, production's code plants) and its undoing. */
export interface ProcessWide {
  /** The run's own working directory, drawn by mkdtemp. */
  readonly workdir: string;
  /** Puts every process-wide setting back, the last one set first. */
  readonly restore: () => void;
}

export async function setProcessWide(
  options: RunOptions,
  draws: RunDraws,
  world: RunWorld,
  state: RunState,
): Promise<ProcessWide> {
  const workdir = await realpath(await mkdtemp(join(options.scratchRoot, "ashara-sim-")));
  const restoreIds = seededIds(options.seed);
  const restoreEnv = simulatedEnvironment(workdir, draws.capUsd);
  const restoreWaits = observeContendedWaits(world.interleaver.contended);
  const restoreCode = world.planted?.code?.() ?? null;
  const restoreSweeps = observeAcceptanceSweeps((sweep) => {
    state.coverage.sweeps.add(sweep);
    state.trace.push(`acceptance sweep ${sweep}`);
  });
  return {
    workdir,
    restore: () => {
      restoreCode?.();
      restoreSweeps();
      restoreWaits();
      restoreEnv();
      restoreIds();
    },
  };
}

/** What a run holds outside its process that its cleanup ends: each set as it is made. */
export class RunResources {
  database: RunDatabase | null = null;
  observer: Database | null = null;
  readonly gitBroker = new GitBroker();
  readonly cleanupFailures: CleanupStepFailed[] = [];
}

/** What the run provisions before its first composition: the database, its key, its clients and its fakes. */
export interface Provisioned {
  readonly observer: Database;
  readonly databaseUrl: string;
  readonly masterKey: MasterKey;
  /** The first project's client; its late change and its stop are the run's. */
  readonly client: SimulatedClient;
  readonly others: readonly SimulatedClient[];
  readonly standIns: StandIns;
  /** Every cell started over the run, live or removed: I3 judges the role each one ran as. */
  readonly startedCells: readonly FakeCell[];
  readonly podman: FakePodman;
  /** Filled as the server creates each client's project; the stand-ins answer for these only. */
  readonly projectIds: string[];
}

/** What one fake-runtime event adds to the run's trace and to the cells started. */
function observePodman(state: RunState, startedCells: FakeCell[], event: PodmanEvent): void {
  switch (event.kind) {
    case "cell-started": {
      startedCells.push(event.cell);
      const { labels } = event.cell;
      state.trace.push(
        `cell ${labels["ashara.task"] ?? "?"} role=${labels["ashara.role"] ?? "?"} ` +
          `tokens=${event.cell.tokens.join("+")}`,
      );
      break;
    }
    case "image-built":
      state.trace.push(`image ${event.id} tokens=${event.tokens.join("+")} context=${event.contextFiles.join(",")}`);
      break;
    case "command":
      state.trace.push(
        `exec ${event.command.split(" ").slice(0, 3).join(" ")} -> ${event.hung ? "hung" : event.exitCode}`,
      );
      break;
    case "cell-removed":
      break;
  }
}

/**
 * The run's scratch database and its observer, the master key and the server's secrets, each
 * project's client registered as the operator registers one, the stand-in models and the fake
 * container runtime.
 */
export async function provision(
  options: RunOptions,
  draws: RunDraws,
  world: RunWorld,
  state: RunState,
  resources: RunResources,
  onAgentTurn: (task: { readonly id: string; readonly projectId: string }) => Promise<void>,
): Promise<Provisioned> {
  stopIfAborted(options, state);
  const database = await createRunDatabase(options.databaseUrl, options.template, options.seed);
  resources.database = database;
  const observer = createDb(
    database.url,
    (config) => new pg.Pool({ ...config, application_name: "ashara-sim-observer", max: 2 }),
  );
  resources.observer = observer;
  if (options.alterDatabase !== undefined) await options.alterDatabase(observer);
  const keyDir = await mkdtemp(join(options.scratchRoot, "ashara-sim-key-"));
  const keyFile = join(keyDir, "master.key");
  createKeyFile(keyFile);
  const masterKey: MasterKey = loadMasterKey(keyFile);
  await rm(keyDir, { recursive: true, force: true });
  const secrets = new SecretStore(new SecretRepository(observer), masterKey);
  await secrets.put("server/api_token", "simulator-api-token");
  await secrets.put("provider/openai/api_key", "simulator-provider-key");

  // The operator registers each project's client and its access code, as scripts/client.ts add
  // does; everything the client says after that goes through the server's client routes.
  const register = async (suffix: string): Promise<SimulatedClient> => {
    const code = `sim-access-code-${options.seed}${suffix}-0123456789`;
    const row = await new ClientRepository(observer).create(`sim-client-${options.seed}${suffix}`);
    await secrets.put(clientAccessCodeSecretName(row.id), code);
    return new SimulatedClient(row.name, code);
  };
  const client = await register("");
  const others: SimulatedClient[] = [];
  for (let index = 1; index < draws.projectCount; index++) others.push(await register(`-p${index + 1}`));
  const projectIds: string[] = [];
  const { interleaver, consulted, port } = world;
  const standIns = new StandIns({
    tape: draws.tape,
    rates: draws.rates,
    universe: draws.universe,
    personas: draws.personas,
    observer,
    projectIds,
    onModelCall: (call) => {
      state.trace.push(`model ${call.site} ${call.action}`);
      const task = interleaver.currentTask();
      if (task !== null) consulted.add(task);
    },
    onRequest: () => port.record(interleaver.currentTask()),
    laneTask: () => interleaver.currentTask(),
    onAgentTurn,
    onSchemaRefused: (refused) => {
      state.trace.push(`model ${refused.model} refused the ${refused.what} schema`);
      state.report({
        invariant: "I1",
        step: state.cycles,
        statement:
          `a request to ${refused.model} carried a ${refused.what} schema provider type ` +
          `${refused.providerType} refuses: ${refused.detail}`,
        key: `I1:schema-refused:${refused.providerType}:${refused.what}`,
      });
    },
  });
  for (const violation of await refusedModelSchemas(state.cycles)) state.report(violation);
  const baseCell = await loadBaseCell();
  const startedCells: FakeCell[] = [];
  const podman = new FakePodman({
    baseImage: baseCell.image,
    tape: draws.tape,
    observe: (event) => observePodman(state, startedCells, event),
  });
  return { observer, databaseUrl: database.url, masterKey, client, others, standIns, startedCells, podman, projectIds };
}

/** Runs one cleanup step and adds its throw, logged at warn with its chain, to `failures`; the next step still runs. */
async function cleanUp(failures: CleanupStepFailed[], step: string, work: () => unknown): Promise<void> {
  const failed = await cleanupFailure(step, work);
  if (failed === null) return;
  failures.push(failed);
  console.warn(`[simulator] run cleanup: ${describeErrorChain(failed)}`);
}

async function cleanupFailure(step: string, work: () => unknown): Promise<CleanupStepFailed | null> {
  try {
    await work();
    return null;
  } catch (err) {
    return new CleanupStepFailed(step, err);
  }
}

/**
 * The run's cleanup: the live instance ends, then the observer's pool, the run database and the git
 * broker. Process-wide state is put back whatever the cleanup throws, and each step runs whatever
 * the one before it threw; each failed step is in the resources' cleanup failures.
 */
export async function tearDown(state: RunState, resources: RunResources, processWide: ProcessWide): Promise<void> {
  const failures = resources.cleanupFailures;
  try {
    const live = state.live;
    if (live !== null) {
      live.handle.dead = true;
      live.ashara.abort();
      for (const violation of leakedConnections(live.handle, state.cycles)) state.replace(violation);
      await live.ashara.closeDatabase().catch((err: unknown) => state.log.push(`close: ${describeErrorChain(err)}`));
    }
    const pool = resources.observer;
    if (pool !== null) await cleanUp(failures, "the observer's pool end", () => pool.$client.end());
    const scratch = resources.database;
    if (scratch !== null) await cleanUp(failures, "the run database's drop", () => scratch.drop());
    await cleanUp(failures, "the git broker's close", () => resources.gitBroker.close());
  } finally {
    processWide.restore();
  }
  await cleanUp(failures, "the workdir's removal", () => rm(processWide.workdir, { recursive: true, force: true }));
}
