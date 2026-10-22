import { setTimeout as sleep } from "node:timers/promises";
import { describeErrorChain } from "@ashara/shared";
import type { LogRecord } from "@ashara/shared";
import { capturingConsole } from "./console-capture.js";
import type { ConsoleSink } from "./console-capture.js";
import type { Coverage } from "./coverage.js";
import type { Database } from "./database.js";
import type { FaultRecord } from "./faults.js";
import type { Outcome, Violation } from "./invariants.js";
import type { Mutation } from "./plants.js";
import type { Profile } from "./profile.js";
import { ClientCorrection, CycleLoop } from "./run-cycle-loop.js";
import { judgeRunEnd } from "./run-end.js";
import { RunState, SimulatedProcess, tender } from "./run-instance.js";
import { RunResources, buildWorld, drawRun, provision, setProcessWide, tearDown } from "./run-setup.js";
import type { CleanupStepFailed, ProcessWide, RunDraws, RunWorld } from "./run-setup.js";
import type { Decision, TapeMode } from "./tape.js";

/** @testseam integration server/settle-cycles.test.ts holds it equal to the product's first fault backoff */
export { REPORT_RETRY_MS } from "./run-cycle-loop.js";
/** @testseam the simulator's abort test tells an aborted run's rejection by it */
export { RunAborted } from "./run-instance.js";

export interface RunOptions {
  readonly seed: number;
  readonly profile: Profile;
  readonly tape: TapeMode;
  /** The database server the scratch databases live on (never the shared database itself). */
  readonly databaseUrl: string;
  readonly template: string;
  readonly maxCycles: number;
  readonly mutation?: Mutation;
  /**
   * Hard wall clock of the run; past it the run ends as an I1 violation. Infinite: none, the run ends by `maxCycles` or
   * its `signal`.
   */
  readonly timeoutMs: number;
  /**
   * Projects on the one deployment (policy default 1). Two share the deployment's spend cap, so
   * their tasks' admissions race on it across projects; both are judged, the second's
   * violation keys marked `p2`.
   */
  readonly projects?: 1 | 2;
  /** The deployment's spend cap instead of the tape's draw; each project's cap equals it. */
  readonly capUsd?: number;
  /** Every cell start fails for the whole run: the host's container runtime is broken (faults.ts). */
  readonly cellOutage?: boolean;
  /**
   * The second project's rows are corrupted as the run reaches them (corruptRows): the containment
   * scenario, run with `projects: 2`, in which the first project must still progress (I8).
   */
  readonly corruptSecondProject?: boolean;
  /**
   * Run on the run's database once it is made, before anything of the run is written: a test's
   * change to what the database keeps (a log that loses its rows), the verdicts judged on what is left.
   * @testseam the directed tier's evidence tests pass it
   */
  readonly alterDatabase?: (db: Database) => Promise<void>;
  /**
   * Ends the run at its next step once aborted: the run rejects with RunAborted after its cleanup,
   * so nothing of it outlives whatever started it (a test that timed out). Policy default: with none,
   * the run ends only on its own terms or its wall clock.
   */
  readonly signal?: AbortSignal;
  /** The existing directory the run's workdir and key file are made under (scripts/scratch-root.ts resolves it). */
  readonly scratchRoot: string;
}

/** The run's shape apart from its seed: how many projects share the deployment, and its cap. */
export type RunMode = Pick<RunOptions, "projects" | "capUsd">;

export interface RunResult {
  readonly seed: number;
  readonly profile: Profile;
  readonly outcome: Outcome;
  /** Each project of the run that ended halted on Ashara's own fault, as `project <n>: <recorded reason>`. */
  readonly asharaHalts: readonly string[];
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
  /** The last records every composed instance logged through its log port, each tagged by its instance's `boot`. */
  readonly records: readonly LogRecord[];
}

const LOG_LINES = 400;
const UNPRICED_NOISE = ["cost unmeasured", "no routing profile for enabled-provider combo"];

/**
 * A directed run (TapeMode directed) that never took one of its directions: the behaviour it was
 * asked to force never happened, so nothing it judged is about that behaviour.
 */
class DirectionsNotTaken extends Error {
  constructor(
    readonly seed: number,
    readonly untaken: readonly string[],
  ) {
    super(`seed ${seed}: the directed run never took ${untaken.length} of its direction(s): ${untaken.join("; ")}`);
    this.name = "DirectionsNotTaken";
  }
}

/**
 * A run's body ended, but its cleanup did not: a scratch database or a pool may outlive it. Its
 * process-wide state was put back all the same.
 * @testseam the simulator's run-wiring test tells a run whose cleanup threw by it
 */
export class RunCleanupFailed extends Error {
  constructor(
    readonly seed: number,
    readonly failures: readonly CleanupStepFailed[],
    /** The run's last log lines, each cleanup failure among them at warn. */
    readonly log: readonly string[],
  ) {
    super(
      `seed ${seed}: the run's cleanup failed at ${failures.length} step(s): ` +
        failures.map((failure) => failure.message).join("; "),
      { cause: failures[0] },
    );
    this.name = "RunCleanupFailed";
  }
}

/** Production's console output goes into the run's log, not the terminal; the last lines are kept. */
function logSink(log: string[]): ConsoleSink {
  return (level, args) => {
    const line = `${level} ${args.map((a) => (a instanceof Error ? describeErrorChain(a) : String(a))).join(" ")}`;
    // Every stand-in call is unpriced and unrouted by design: those two lines would bury the rest.
    if (UNPRICED_NOISE.some((noise) => line.includes(noise))) return;
    log.push(line.slice(0, 600));
    if (log.length > LOG_LINES) log.splice(0, log.length - LOG_LINES);
  };
}

/**
 * Replaces each id, commit and hex digest by its kind and order of first appearance,
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
 * How long past its bound a run may take to settle: the step in flight when it was aborted or
 * passed its wall clock, then its cleanup. Three times the settle bound simulator-abort.test.ts
 * holds an aborted run to.
 */
const RUN_SETTLE_GRACE_MS = 15_000;
const PRIOR_POLL_MS = 250;

/**
 * A run in this module instance, from its call until it settles. A run that never started (it
 * waits on the one before it) has no bound of its own; one that gave up on a stuck run before it
 * stands for that run, so every later run is refused by name until the stuck run settles.
 */
class PendingRun {
  readonly settled: Promise<void>;
  private release: () => void = () => undefined;
  private done = false;
  private startedAt: number | null = null;
  private abortedAt: number | null = null;
  private inherited: PendingRun | null = null;

  constructor(
    readonly seed: number,
    private readonly timeoutMs: number,
    signal: AbortSignal | undefined,
  ) {
    this.settled = new Promise<void>((resolve) => {
      this.release = resolve;
    });
    if (signal?.aborted === true) this.abortedAt = Date.now();
    else signal?.addEventListener("abort", () => (this.abortedAt = Date.now()), { once: true });
  }

  /** The run before any run of this module instance: settled from the start. */
  static none(): PendingRun {
    const run = new PendingRun(0, 0, undefined);
    run.settle();
    return run;
  }

  get isSettled(): boolean {
    return this.done;
  }

  start(): void {
    this.startedAt = Date.now();
  }

  settle(): void {
    this.done = true;
    this.release();
  }

  inherit(stuck: PendingRun): void {
    this.inherited = stuck;
    void stuck.settled.then(() => this.settle());
  }

  /** When the run must have settled by: its wall clock, or its abort if earlier, plus the grace. */
  deadline(): number {
    if (this.inherited !== null) return this.inherited.deadline();
    if (this.startedAt === null) return Number.POSITIVE_INFINITY;
    const wallClock = this.startedAt + this.timeoutMs;
    const stopped = this.abortedAt === null ? wallClock : Math.min(wallClock, Math.max(this.abortedAt, this.startedAt));
    return stopped + RUN_SETTLE_GRACE_MS;
  }

  describe(): string {
    if (this.inherited !== null) return this.inherited.describe();
    const started =
      this.startedAt === null
        ? "never started"
        : `started ${new Date(this.startedAt).toISOString()} with a ${this.timeoutMs} ms wall clock`;
    const aborted = this.abortedAt === null ? "never aborted" : `aborted ${new Date(this.abortedAt).toISOString()}`;
    return `the run of seed ${this.seed} (${started}, ${aborted})`;
  }
}

/**
 * The run before this one has not settled within its bound: the process-wide state it set may still
 * be in place, so no later run of this module instance starts until it does.
 * @testseam the simulator's run-wiring test tells a refused run's rejection by it
 */
export class PriorRunUnsettled extends Error {
  constructor(
    readonly seed: number,
    readonly stuck: string,
    readonly graceMs: number,
  ) {
    super(
      `seed ${seed}: ${stuck} has not settled ${graceMs} ms past its wall clock or its abort; this run does ` +
        `not start over the state it may still hold`,
    );
    this.name = "PriorRunUnsettled";
  }
}

async function settledWithin(prior: PendingRun, seed: number): Promise<void> {
  while (!prior.isSettled) {
    if (Date.now() > prior.deadline()) throw new PriorRunUnsettled(seed, prior.describe(), RUN_SETTLE_GRACE_MS);
    await Promise.race([prior.settled, sleep(PRIOR_POLL_MS)]);
  }
}

/** The run called last in this module instance; the next one waits on it. */
let lastRun: PendingRun = PendingRun.none();

/**
 * One seed, start to end: the real system composed over a private scratch
 * database, real git, the fake container runtime and the scripted models; the invariants judged
 * after every cycle; crashes and SIGTERMs answered by composing a new instance on the same workdir.
 *
 * A run sets process-wide state (the environment, the id source, production's code plants) and puts
 * it back as it ends, so it starts only once the run before it has settled: a run its caller gave
 * up on, still stopping, never has its state restored over the next one's. One that has not settled
 * within its bound is named in a PriorRunUnsettled, never waited on past it. Its console output is
 * captured by async context, so even a run that outlives its caller writes only into its own log.
 */
export async function runSeed(options: RunOptions): Promise<RunResult> {
  const prior = lastRun;
  const own = new PendingRun(options.seed, options.timeoutMs, options.signal);
  lastRun = own;
  try {
    await settledWithin(prior, options.seed);
  } catch (err) {
    own.inherit(prior);
    throw err;
  }
  try {
    own.start();
    const log: string[] = [];
    return await capturingConsole(logSink(log), () => runIsolated(options, log));
  } finally {
    own.settle();
  }
}

/**
 * One run, in the order its modules hold it: the draws, the watches and the process-wide state
 * (run-setup.ts), the provisioning and the first composition of the simulated process
 * (run-instance.ts), each client's tender, the cycles (run-cycle-loop.ts) and the run's end
 * (run-end.ts); then its cleanup, whatever the body threw.
 */
async function runIsolated(options: RunOptions, log: string[]): Promise<RunResult> {
  const started = Date.now();
  const state = new RunState(log);
  const draws = drawRun(options, state);
  const world = buildWorld(options, draws, state);
  const processWide = await setProcessWide(options, draws, world, state);
  const resources = new RunResources();
  const signal = options.signal;
  // An abort also stops the live instance, so a cycle in flight ends at its next await, not its end.
  const abortInstance = (): void => state.live?.ashara.abort();
  signal?.addEventListener("abort", abortInstance, { once: true });
  try {
    await runBody(options, started, draws, world, state, resources, processWide);
  } catch (err) {
    log.push(`harness error: ${describeErrorChain(err)}`);
    throw err;
  } finally {
    signal?.removeEventListener("abort", abortInstance);
    await tearDown(state, resources, processWide);
  }
  // Reached only by a run whose body ended on its own terms: a body's own error is not replaced by its cleanup's.
  if (resources.cleanupFailures.length > 0) throw new RunCleanupFailed(options.seed, resources.cleanupFailures, log);
  const untaken = draws.tape.untaken();
  if (untaken.length > 0) throw new DirectionsNotTaken(options.seed, untaken);
  const violations = [...state.violations.values()];
  return {
    seed: options.seed,
    profile: options.profile,
    outcome: state.outcome,
    asharaHalts: state.asharaHalts,
    violations,
    // The violations close the trace, so one equality covers what a run did and what it was judged to have done.
    trace: canonical(
      [...state.trace, ...violations.map((violation) => `violation ${violation.key}: ${violation.statement}`)],
      processWide.workdir,
    ),
    decisions: draws.tape.decisions(),
    coverage: state.coverage,
    cycles: state.cycles,
    dispatches: state.dispatches,
    restarts: state.restarts,
    faults: world.scheduler.faults(),
    tickets: world.scheduler.tickets(),
    durationMs: Date.now() - started,
    longestQuiet: state.longestQuiet,
    log,
    records: state.records,
  };
}

/** The run's body: provisioned, composed, each project tendered, its cycles run and its end judged. */
async function runBody(
  options: RunOptions,
  started: number,
  draws: RunDraws,
  world: RunWorld,
  state: RunState,
  resources: RunResources,
  processWide: ProcessWide,
): Promise<void> {
  const correction = new ClientCorrection(draws.correctionDraw, state);
  const provisioned = await provision(options, draws, world, state, resources, (task) =>
    correction.duringAgentTurn(task),
  );
  const { observer, projectIds, client, others, standIns } = provisioned;
  const server = new SimulatedProcess({
    options,
    state,
    scheduler: world.scheduler,
    clock: draws.clock,
    interleaver: world.interleaver,
    admissions: world.admissions,
    gitDates: world.gitDates,
    queryPlant: world.queryPlant,
    correlation: world.correlation,
    gitBroker: resources.gitBroker,
    observer,
    databaseUrl: provisioned.databaseUrl,
    masterKey: provisioned.masterKey,
    standIns,
    podman: provisioned.podman,
    projectIds,
  });
  state.live = await server.compose();
  // Each client tenders its project through the routes; the late change and the stop are the
  // first project's, and its outcome is the run's.
  const projectId = await tender(server, client, 0, options.seed, draws.universe.behaviours);
  projectIds.push(projectId);
  for (const [index, other] of others.entries()) {
    projectIds.push(await tender(server, other, index + 1, options.seed, draws.universe.behaviours));
  }
  correction.arm({ projectId, client, standIns, observer });
  const loop = new CycleLoop({ options, started, draws, world, state, server, provisioned, correction });
  world.interleaver.betweenSettlements(() => loop.betweenSettlements());
  await loop.run();
  await judgeRunEnd({ options, draws, world, state, provisioned, resources, processWide, noProgress: loop.noProgress });
}
