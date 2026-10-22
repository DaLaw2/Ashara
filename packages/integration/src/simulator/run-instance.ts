import { sql } from "drizzle-orm";
import { z } from "zod";
import { TargetCheckoutClaimedElsewhere } from "@ashara/db";
import type { MasterKey } from "@ashara/security";
import { composeAshara } from "@ashara/server/compose";
import type { AsharaInstance } from "@ashara/server/compose";
import { describeErrorChain } from "@ashara/shared";
import type { LogRecord } from "@ashara/shared";
import type { AdmissionLedger } from "./admissions.js";
import { CheckoutWatch } from "./checkout-watch.js";
import { emptyCoverage } from "./coverage.js";
import type { Coverage } from "./coverage.js";
import type { Database } from "./database.js";
import type { FakePodman } from "./fake-podman.js";
import { SimulatedCrash, faultingGit, faultingModels, faultingPodman, faultingPools } from "./faults.js";
import type { FaultRecord, GitDates, InstanceHandle, QueryPlant, Scheduler, SimClock } from "./faults.js";
import type { GitBroker } from "./git-broker.js";
import type { Interleaver } from "./interleave.js";
import { readSnapshot } from "./invariants.js";
import type { Outcome, Violation } from "./invariants.js";
import { judgingSink } from "./log-correlation.js";
import type { LogCorrelationJudge } from "./log-correlation.js";
import { plantSeamsOf } from "./plants.js";
import type { RunOptions } from "./run.js";
import type { StandIns } from "./scripted-models.js";
import type { ClientReply, ClientRoutes, SimulatedClient } from "./simulated-client.js";

/** Records kept: a run's whole tail, every instance's records together, at a bounded memory cost. */
const LOG_RECORDS = 2_000;
/** Compositions one run may make, restarts included: a boot that fails past it ends the run. */
const MAX_BOOTS = 50;
/** How long a restart waits for a dead instance's database sessions to end. */
const BACKEND_EXIT_POLLS = 100;
const BACKEND_EXIT_POLL_MS = 50;
/**
 * Requests one client action may send, read-backs included, before the run gives up on it. Each
 * failure is a fault the tape injected on the composed instance (a failed query, a crash, a
 * SIGTERM, the instance then restarted), and the fault budget bounds those.
 */
const MAX_CLIENT_REQUESTS = 8;
/**
 * The statuses a client meets when the server's process fails under it, which it answers by
 * asking again: 500 (a fault reached the route), 401 (the session must be renewed), 409 (an answer
 * already on record, read back before it is sent again).
 */
const CLIENT_RETRIED = new Set([401, 409, 500]);

/** A composed instance and the generation that names its database sessions. */
export interface Live {
  readonly ashara: AsharaInstance;
  readonly handle: InstanceHandle;
  readonly generation: number;
}

/**
 * The run's mutable state, one object every step of the run reads and writes: what it traced and
 * judged, its counters, the checkout watch of the process now composed and the instance live now.
 */
export class RunState {
  readonly trace: string[] = [];
  readonly records: LogRecord[] = [];
  readonly violations = new Map<string, Violation>();
  readonly coverage: Coverage = emptyCoverage();
  readonly asharaHalts: string[] = [];
  outcome: Outcome = { kind: "open" };
  cycles = 0;
  dispatches = 0;
  restarts = 0;
  /** The longest run of fault-free cycles with no progress (I8's measure). */
  longestQuiet = 0;
  /**
   * Set while a cycle (full or halted) of the live instance runs: L1 asks every record logged meanwhile for the cycle.
   */
  cycleRunning = false;
  /** The queries the plant changed: a mutation run whose plant changed none tested nothing. */
  bites = 0;
  checkouts: CheckoutWatch;
  live: Live | null = null;
  /** The instance whose runner a cycle stopped: it runs only halted cycles until a restart replaces it. */
  haltedLive: Live | null = null;

  constructor(readonly log: string[]) {
    this.checkouts = this.newCheckouts();
  }

  /** Keeps the first violation of each key. */
  report(violation: Violation): void {
    if (!this.violations.has(violation.key)) this.violations.set(violation.key, violation);
  }

  /** Puts the violation in its key's place, over one reported before it. */
  replace(violation: Violation): void {
    this.violations.set(violation.key, violation);
  }

  /** A watch with nothing staged, for a process that has staged nothing yet. */
  newCheckouts(): CheckoutWatch {
    return new CheckoutWatch((violation) => this.report(violation));
  }
}

/**
 * The run's signal was aborted: it stopped at its next step and cleaned up, with no result to judge.
 * @testseam the simulator's abort test tells an aborted run's rejection by it
 */
export class RunAborted extends Error {
  constructor(
    readonly seed: number,
    readonly cycle: number,
    readonly reason: unknown,
    /** The run's last log lines: what it was doing when it was stopped. */
    readonly log: readonly string[],
  ) {
    super(`seed ${seed}: the run was aborted at cycle ${cycle}: ${describeErrorChain(reason)}`, { cause: reason });
    this.name = "RunAborted";
  }
}

/** Each step of the run begins here: an aborted run goes no further than the step it is in. */
export function stopIfAborted(options: Pick<RunOptions, "seed" | "signal">, state: RunState): void {
  const signal = options.signal;
  if (signal?.aborted === true) throw new RunAborted(options.seed, state.cycles, signal.reason, state.log);
}

/** A second project's violation is keyed and stated as its own. */
export function ofProject(index: number, violation: Violation): Violation {
  if (index === 0) return violation;
  const at = violation.key.indexOf(":");
  return {
    ...violation,
    key: `${violation.key.slice(0, at)}:p${index + 1}${violation.key.slice(at)}`,
    statement: `project ${index + 1}: ${violation.statement}`,
  };
}

/** A boot failed after the run's composition bound was spent; the boot's error is kept as the cause. */
class BootsExhausted extends Error {
  constructor(
    readonly seed: number,
    readonly compositions: number,
    readonly lastError: unknown,
  ) {
    super(
      `seed ${seed}: composition ${compositions} of the simulated process failed to boot, ` +
        `past the bound of ${MAX_BOOTS}: ${describeErrorChain(lastError)}`,
      { cause: lastError },
    );
    this.name = "BootsExhausted";
  }
}

const outlivingSessionSchema = z.object({
  pid: z.number().int(),
  state: z.string().nullable(),
  backendStart: z.string().nullable(),
  query: z.string().nullable(),
});
type OutlivingSession = z.infer<typeof outlivingSessionSchema>;

/** A dead instance's database sessions outlived their termination: the next boot would find its claim held. */
class BackendsOutlivedInstance extends Error {
  constructor(
    readonly applicationName: string,
    readonly sessions: readonly OutlivingSession[],
  ) {
    const each = sessions.map((s) => {
      // eslint-disable-next-line no-restricted-syntax -- policy default: message text only
      const query = JSON.stringify(s.query ?? "");
      return `pid ${s.pid} ${s.state ?? "(no state)"} since ${s.backendStart ?? "?"}, last query ${query}`;
    });
    super(
      `${sessions.length} database session(s) of ${applicationName} were still open ` +
        `${BACKEND_EXIT_POLLS * BACKEND_EXIT_POLL_MS} ms after pg_terminate_backend: ${each.join("; ")}`,
    );
    this.name = "BackendsOutlivedInstance";
  }
}

/** A client route refused a request the client is entitled to make: the route, not a fault, said no. */
class ClientRequestRefused extends Error {
  constructor(
    readonly seed: number,
    readonly action: string,
    readonly status: number,
    readonly detail: string,
  ) {
    super(`seed ${seed}: the client's ${action} was refused with ${status}: ${detail}`);
    this.name = "ClientRequestRefused";
  }
}

/** A client action failed on every request the run allows it. */
class ClientRequestsExhausted extends Error {
  constructor(
    readonly seed: number,
    readonly action: string,
    readonly last: string,
  ) {
    super(`seed ${seed}: the client's ${action} failed on all ${MAX_CLIENT_REQUESTS} requests; the last: ${last}`);
    this.name = "ClientRequestsExhausted";
  }
}

/** What a read-back of the server's records found of an action that may already have landed. */
export type Landed<T> = { readonly found: true; readonly value: T } | { readonly found: false };

/** The instance's connection string: every session it opens, outside its pool too, carries its name. */
function instanceUrl(databaseUrl: string, applicationName: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set("application_name", applicationName);
  return url.toString();
}

function instanceName(of: number): string {
  return `ashara-sim-${process.pid}-${of}`;
}

/**
 * I1, the connection clause, judged when a process ends on its own terms (a drain or the run's
 * end), with no cycle in flight: a connection still checked out is one no code will release. It
 * shrinks the pool for good and holds the pool's end forever, so it is destroyed here and named.
 */
export function leakedConnections(handle: InstanceHandle, step: number): Violation[] {
  const leaked = [...handle.checkouts];
  handle.checkouts.clear();
  return leaked.map(([client, sent]) => {
    client.release(true);
    const queries = sent.length === 0 ? "none" : sent.join("; ");
    return {
      invariant: "I1",
      step,
      statement:
        `${handle.name} ended holding a database connection nothing released ` +
        `(queries sent on it: ${queries}); each such leak shrinks the pool for good`,
      key: `I1:leaked-connection:${sent[0] ?? "none"}`,
    };
  });
}

/**
 * I1, the containment clause: a cycle (or a boot) that threw anything but a simulated crash, with no
 * fault injected while it ran, threw on Ashara's own code over a healthy substrate. The loop then
 * fails that cycle for every project, and the next cycle meets the same code. One that threw under
 * an injected fault is the fail-closed answer to it (Discipline A), retried by the next cycle; null.
 * So is one whose cause chain holds a simulated crash: a process that died before the cycle (a crash
 * between cycles) throws one from every seam call, wrapped by whatever made the call.
 *
 * Blind spot: a throw under an injected fault is never judged, even one the fault did not cause.
 */
export function unfaultedError(
  phase: "cycle" | "boot",
  err: unknown,
  step: number,
  faults: readonly FaultRecord[],
): Violation | null {
  if (crashBeneath(err) || faults.length > 0) return null;
  const name = err instanceof Error ? err.name : typeof err;
  return {
    invariant: "I1",
    step,
    statement:
      `a ${phase} threw ${name} with no fault injected while it ran, ` +
      `so every project's ${phase} failed on it: ${describeErrorChain(err)}`,
    key: `I1:${phase}-error`,
  };
}

/** Whether `err` or an error its cause chain holds is a simulated crash. */
function crashBeneath(err: unknown): boolean {
  const seen = new Set<unknown>();
  for (let at: unknown = err; at instanceof Error && !seen.has(at); at = at.cause) {
    if (at instanceof SimulatedCrash) return true;
    seen.add(at);
  }
  return false;
}

/** What the simulated process is composed of: the run's seams, its fakes and its stand-ins. */
export interface ProcessParts {
  readonly options: Pick<RunOptions, "seed" | "signal" | "cellOutage">;
  readonly state: RunState;
  readonly scheduler: Scheduler;
  readonly clock: SimClock;
  readonly interleaver: Interleaver;
  readonly admissions: AdmissionLedger;
  readonly gitDates: GitDates;
  readonly queryPlant: QueryPlant | null;
  readonly correlation: LogCorrelationJudge;
  readonly gitBroker: GitBroker;
  readonly observer: Database;
  readonly databaseUrl: string;
  readonly masterKey: MasterKey;
  readonly standIns: StandIns;
  readonly podman: FakePodman;
  /** Filled as the server creates each client's project. */
  readonly projectIds: readonly string[];
}

/**
 * The simulated server process over the run: each composition of the real system, its death as the
 * database sees it, its restart on the same workdir, and every client action sent to its routes.
 * The instance live now is the run state's.
 */
export class SimulatedProcess {
  private generation = 0;

  constructor(private readonly parts: ProcessParts) {}

  /** Composes and boots a new instance, restarting one that cannot boot, as a supervisor would. */
  async compose(): Promise<Live> {
    const { options, state, scheduler, standIns, podman, gitBroker, clock, interleaver } = this.parts;
    for (;;) {
      stopIfAborted(options, state);
      this.generation += 1;
      const generation = this.generation;
      const faultsBefore = scheduler.faults().length;
      const handle: InstanceHandle = {
        name: `sim-${generation}`,
        dead: false,
        abort: null,
        sigtermed: false,
        fatal: null,
        checkouts: new Map(),
        pools: [],
      };
      // A new process stages nothing yet: the dead one's staged merge is an orphan its recovery clears.
      state.checkouts = state.newCheckouts();
      const seam = {
        scheduler,
        instance: handle,
        clock,
        terminateBackend: (pid: number) => this.terminateBackend(pid),
        interleaver,
        checkouts: state.checkouts,
        cycle: () => state.cycles,
        admissions: this.parts.admissions,
        cellOutage: options.cellOutage === true,
        gitDates: this.parts.gitDates,
        queried: (args: readonly unknown[]) => {
          for (const mutation of plantSeamsOf(args, state.coverage.plants)) state.coverage.plants.add(mutation);
        },
      };
      try {
        const ashara = await composeAshara({
          masterKey: this.parts.masterKey,
          databaseUrl: instanceUrl(this.parts.databaseUrl, instanceName(generation)),
          createPool: faultingPools(seam, instanceName(generation), this.parts.queryPlant),
          models: faultingModels(seam, standIns.factory),
          processRunner: faultingPodman(seam, podman.runner),
          git: faultingGit(seam, gitBroker.runner),
          clock,
          taskLanes: interleaver.lanes,
          log: judgingSink(
            this.parts.correlation,
            () => ({ step: state.cycles, cycleRunning: state.cycleRunning }),
            state.records,
            LOG_RECORDS,
          ),
        });
        handle.abort = () => ashara.abort();
        // In the composition's boot trace, as the served process boots (server process-lifecycle.ts).
        await ashara.booted(() => ashara.startup());
        state.trace.push(`instance ${handle.name} started`);
        return { ashara, handle, generation };
      } catch (err) {
        await this.bootFailed(handle, generation, faultsBefore, err);
        if (generation > MAX_BOOTS) throw new BootsExhausted(options.seed, generation, err);
      }
    }
  }

  /** A boot that threw: traced, judged, and its sessions ended. */
  private async bootFailed(
    handle: InstanceHandle,
    generation: number,
    faultsBefore: number,
    err: unknown,
  ): Promise<void> {
    const { state, scheduler } = this.parts;
    // A process that cannot boot is restarted, as a supervisor would; the fault budget bounds it.
    const thrown = err instanceof SimulatedCrash ? "crash" : err instanceof Error ? err.name : "error";
    state.trace.push(`instance ${handle.name} failed to boot: ${thrown}`);
    handle.dead = true;
    if (!(err instanceof SimulatedCrash)) state.log.push(`boot of ${handle.name} failed: ${describeErrorChain(err)}`);
    if (!(err instanceof TargetCheckoutClaimedElsewhere)) {
      const unfaulted = unfaultedError("boot", err, state.cycles, scheduler.faults().slice(faultsBefore));
      if (unfaulted !== null) state.report(unfaulted);
    }
    // Every earlier instance's sessions are gone before a boot (killBackends, the drain's
    // check), so a refused claim is one nothing in this run holds: never a retry, a finding.
    if (err instanceof TargetCheckoutClaimedElsewhere) {
      state.replace({
        invariant: "I1",
        step: state.cycles,
        statement: `${handle.name} was refused its target claim with no other instance alive: ${err.message}`,
        key: "I1:claim-refused",
      });
    }
    await this.killBackends(handle, generation);
  }

  private async terminateBackend(pid: number): Promise<void> {
    await this.parts.observer.execute(sql`SELECT pg_terminate_backend(${pid})`);
  }

  private async backendsOf(name: string): Promise<number> {
    const result = await this.parts.observer.execute(
      sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = ${name}`,
    );
    return z.tuple([z.object({ n: z.number().int() })]).parse(result.rows)[0].n;
  }

  private async sessionsOf(name: string): Promise<readonly OutlivingSession[]> {
    const result = await this.parts.observer.execute(
      sql`SELECT pid, state, backend_start::text AS "backendStart", left(query, 200) AS query
          FROM pg_stat_activity WHERE application_name = ${name}`,
    );
    return z.array(outlivingSessionSchema).parse(result.rows);
  }

  /** Polls until the instance has no backend left; the count still left when the bound ran out. */
  private async backendsAfterExit(name: string): Promise<number> {
    for (let polls = 0; ; polls++) {
      const left = await this.backendsOf(name);
      if (left === 0 || polls >= BACKEND_EXIT_POLLS) return left;
      await new Promise((resolve) => setTimeout(resolve, BACKEND_EXIT_POLL_MS));
    }
  }

  /**
   * A process's death, as the database sees it: every backend the instance opened ends, its
   * pool's and the target claim's session alike (the claim connects outside the pool, named by
   * the connection string), and the restart waits until they are gone, so a claim the dead
   * process held is released before the next instance takes it, as a real crash releases it.
   * Its pools end too: an exit closes the process's sockets, so a connection still being opened
   * when the backends are terminated (a query of a failed Promise.all's sibling, which entered
   * before the death) closes as it lands, never idling in a dead pool past the poll's bound.
   */
  private async killBackends(handle: InstanceHandle, of: number): Promise<void> {
    const log = this.parts.state.log;
    for (const pool of handle.pools) {
      if (pool.ending) continue;
      void pool.end().catch((err: unknown) => {
        log.push(`ending a pool of the dead ${handle.name} failed: ${describeErrorChain(err)}`);
      });
    }
    const name = instanceName(of);
    await this.parts.observer.execute(
      sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = ${name}`,
    );
    const left = await this.backendsAfterExit(name);
    if (left > 0) throw new BackendsOutlivedInstance(name, await this.sessionsOf(name));
  }

  /** A restart after a crash or a SIGTERM: the dead process's backends end, its host state stays. */
  private async restart(current: Live, why: string): Promise<void> {
    const { state, observer, podman, projectIds } = this.parts;
    state.restarts += 1;
    state.trace.push(`restart after ${why}`);
    if (current.handle.sigtermed && !current.handle.dead) {
      await this.drain(current);
    } else {
      current.handle.dead = true;
      await this.killBackends(current.handle, current.generation);
    }
    state.live = await this.compose();
    // I7, restart clause: the reconciler leaves nothing InProgress and no cell of the dead process.
    for (const [index, id] of projectIds.entries()) {
      const after = await readSnapshot(observer, id);
      for (const item of after.items.filter((i) => i.status === "InProgress" && i.level === "Task")) {
        state.replace(
          ofProject(index, {
            invariant: "I7",
            step: state.cycles,
            statement: `after the restart, "${item.title}" is InProgress with no live attempt`,
            key: `I7:orphan:${item.title}:${state.restarts}`,
          }),
        );
      }
    }
    if (podman.liveCells().length > 0) {
      state.replace({
        invariant: "I7",
        step: state.cycles,
        statement: `after the restart, ${podman.liveCells().length} cell(s) of the dead process are still running`,
        key: `I7:cells:${state.restarts}`,
      });
    }
  }

  /** A SIGTERMed process drains, as the served process shuts down, before the next one is composed. */
  private async drain(current: Live): Promise<void> {
    const state = this.parts.state;
    // The drain in a trace of its own, as the served process shuts down (server process-lifecycle.ts).
    await current.ashara.logger.scope({ trace: "new" }, async () => {
      try {
        await current.ashara.teardownCells();
      } catch (err) {
        /* eslint-disable-next-line ashara/catch-continue -- best effort: the simulator traces a failed drain; the
           invariants checked right after it judge what the drain left */
        state.trace.push(`drain: teardown failed ${err instanceof Error ? err.name : "error"}`);
      }
      for (const violation of leakedConnections(current.handle, state.cycles)) state.replace(violation);
      await current.ashara.closeDatabase();
    });
    // A drain ends its own sessions, the target claim's included (closeDatabase): one left is
    // a claim the next process would be refused on, named here before it is killed.
    const left = await this.backendsAfterExit(instanceName(current.generation));
    if (left > 0) {
      state.replace({
        invariant: "I1",
        step: state.cycles,
        statement: `${current.handle.name} drained and closed its database yet ${left} of its session(s) stayed open`,
        key: `I1:drain-left-sessions:${state.restarts}`,
      });
      await this.killBackends(current.handle, current.generation);
    }
  }

  /** A process that died or was SIGTERMed is restarted before anything else is asked of it. */
  async recover(current: Live): Promise<void> {
    if (current.handle.fatal !== null) this.parts.state.trace.push(`fatal exit: ${current.handle.fatal.split(":")[0]}`);
    if (current.handle.dead) await this.restart(current, current.handle.fatal === null ? "a crash" : "a fatal exit");
    else if (current.handle.sigtermed) await this.restart(current, "a SIGTERM");
  }

  /**
   * One client action, sent to the live instance's routes. A failure the server's process can
   * cause (a fault the tape injected, the instance then restarted) is answered as a client would:
   * read back whether the action already landed, then send it again. Any other refusal ends the run.
   */
  async clientAct<T>(
    action: string,
    send: (app: ClientRoutes) => Promise<ClientReply<T>>,
    landed: ((app: ClientRoutes) => Promise<ClientReply<Landed<T>>>) | null,
  ): Promise<T> {
    const { options, state } = this.parts;
    let unsure = false;
    let last = "";
    for (let request = 1; request <= MAX_CLIENT_REQUESTS; request++) {
      stopIfAborted(options, state);
      const current = state.live;
      if (current === null) throw new ClientRequestsExhausted(options.seed, action, "no instance is composed");
      if (unsure && landed !== null) {
        const seen = await landed(current.ashara.app);
        if (!seen.ok) {
          last = await this.clientFailed(action, seen, current, request);
          continue;
        }
        if (seen.value.found) return seen.value.value;
        unsure = false;
      }
      const reply = await send(current.ashara.app);
      if (reply.ok) return reply.value;
      unsure = true;
      last = await this.clientFailed(action, reply, current, request);
    }
    throw new ClientRequestsExhausted(options.seed, action, last);
  }

  /** A client request that failed: traced, then retried after a restart, or the run ends on a refusal. */
  private async clientFailed(
    action: string,
    reply: { readonly status: number; readonly detail: string },
    current: Live,
    request: number,
  ): Promise<string> {
    const { options, state } = this.parts;
    const last = `${reply.status} ${reply.detail}`;
    state.trace.push(`client ${action}: request ${request} answered ${reply.status}`);
    if (!CLIENT_RETRIED.has(reply.status))
      throw new ClientRequestRefused(options.seed, action, reply.status, reply.detail);
    await this.recover(current);
    return last;
  }
}

/** Whether the project's messages hold an inbound one `matches` picks out. */
export async function onRecord(
  client: SimulatedClient,
  projectId: string,
  app: ClientRoutes,
  matches: (message: { readonly kind: string; readonly body: string; readonly inReplyTo: string | null }) => boolean,
): Promise<ClientReply<Landed<null>>> {
  const listed = await client.messages(app, projectId);
  if (!listed.ok) return listed;
  const found = listed.value.some((message) => message.direction === "inbound" && matches(message));
  return { ok: true, value: found ? { found: true, value: null } : { found: false } };
}

const PADDING_SENTENCE = " The product is described above.";

/** At least `bytes` bytes of a sentence that adds nothing to the request, so every prompt quoting it grows. */
function paddingOf(bytes: number): string {
  return PADDING_SENTENCE.repeat(Math.ceil(bytes / PADDING_SENTENCE.length));
}

/**
 * A client tenders its project through the routes, read back by name when a request may have landed; `paddingBytes`
 * (RunOptions.requestPaddingBytes) grows the request's text.
 */
export async function tender(
  server: SimulatedProcess,
  simulated: SimulatedClient,
  index: number,
  seed: number,
  behaviours: readonly string[],
  paddingBytes: number,
): Promise<string> {
  const projectName = `sim-${seed}${index === 0 ? "" : `-p${index + 1}`}`;
  const body = `Build a product with ${behaviours.join(", ")}.${paddingOf(paddingBytes)}`;
  return server.clientAct<string>(
    `tender ${index + 1}`,
    (app) => simulated.tender(app, projectName, body),
    async (app) => {
      const listed = await simulated.projects(app);
      if (!listed.ok) return listed;
      const project = listed.value.find((each) => each.name === projectName);
      return { ok: true, value: project === undefined ? { found: false } : { found: true, value: project.id } };
    },
  );
}
