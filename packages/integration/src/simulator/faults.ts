import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import pg from "pg";
import { z } from "zod";
import type { PoolFactory } from "@ashara/db";
import type { GitRunner, ProcessRunner } from "@ashara/execution-infra";
import type { LanguageModelFactory } from "@ashara/llm-gateway";
import type { Clock } from "@ashara/shared";
import type { AdmissionLedger } from "./admissions.js";
import type { CheckoutWatch } from "./checkout-watch.js";
import type { Interleaver } from "./interleave.js";
import type { FaultRates } from "./profile.js";
import type { Tape } from "./tape.js";

/** The seams of design §4.3 a fault can be injected at. */
export const SEAM_KINDS = ["db", "git", "podman", "model"] as const;
export type SeamKind = (typeof SEAM_KINDS)[number];

/**
 * The fault catalogue of design §4.9, as injected here. F11 (two admissions racing the spend cap)
 * is no fault kind: it is the batch of two itself, interleaved at seam calls (interleave.ts).
 */
const FAULT_KINDS = [
  "crash-before",
  "crash-after",
  "sigterm",
  "db-unreachable",
  "db-query-failed",
  "db-transaction-killed",
  "cell-start-failed",
  "cell-exec-failed",
  "cell-teardown-failed",
  "substrate-down",
  "image-build-failed",
  "git-failed",
  "provider-error",
  "clock-jump",
] as const;
export type FaultKind = (typeof FAULT_KINDS)[number];

/**
 * Which faults each seam can carry: the catalogue the coverage report counts against. A call is
 * offered only the faults that take effect on it (see `Scheduler.enter`), so a recorded fault is
 * one that happened; a forced fault that cannot take effect on its call becomes a crash.
 */
export const APPLICABLE_FAULTS: Readonly<Record<SeamKind, readonly FaultKind[]>> = {
  db: ["crash-before", "crash-after", "sigterm", "db-unreachable", "db-query-failed", "db-transaction-killed"],
  git: ["crash-before", "crash-after", "sigterm", "git-failed"],
  podman: ["crash-before", "crash-after", "sigterm", "cell-start-failed", "cell-exec-failed", "cell-teardown-failed", "substrate-down", "image-build-failed"],
  model: ["crash-before", "sigterm", "provider-error", "clock-jump"],
};

/** A composed process stopped dead at a seam call: every later seam call of it throws this at once. */
export class SimulatedCrash extends Error {
  constructor(
    readonly instance: string,
    readonly ticket: number,
    readonly seam: string,
  ) {
    super(`simulated crash of ${instance} at seam call ${ticket} (${seam})`);
    this.name = "SimulatedCrash";
  }
}

/** One composed process as the scheduler knows it. */
export interface InstanceHandle {
  readonly name: string;
  dead: boolean;
  /** The production shutdown path of the instance (its abort signal); set once composed. */
  abort: (() => void) | null;
  sigtermed: boolean;
  /**
   * Why the process exited on its own: production's uncaughtException handler (server index.ts)
   * makes an error no listener takes a fatal exit, and the simulator models that as a crash.
   */
  fatal: string | null;
  /**
   * The connections it has checked out and not released, each with the first queries sent on it.
   * One left here when the process ends holds its pool's end forever: production code leaked it.
   */
  readonly checkouts: Map<pg.PoolClient, string[]>;
  /** The database pools it opened: its death closes every connection of them, as a process's exit does (run.ts). */
  readonly pools: pg.Pool[];
}

export interface FaultRecord {
  readonly ticket: number;
  readonly instance: string;
  readonly seam: SeamKind;
  readonly label: string;
  readonly fault: FaultKind;
}

/** A seam call's fate, decided before it runs. */
type Fate = { readonly kind: "run"; readonly fault: FaultKind | null; readonly crashAfter: boolean };

/** The faults that end or stop the process itself, whatever the call: each seam carries them. */
const PROCESS_FAULTS: ReadonlySet<FaultKind> = new Set(["crash-before", "crash-after", "sigterm"]);

/** A call-specific fault the seam's catalogue does not hold: a wrapper and the catalogue disagree. */
class FaultNotInCatalogue extends Error {
  constructor(
    readonly seam: SeamKind,
    readonly label: string,
    readonly fault: FaultKind,
  ) {
    super(`seam ${seam} call "${label}" offers fault ${fault}, which APPLICABLE_FAULTS.${seam} does not list`);
    this.name = "FaultNotInCatalogue";
  }
}

/**
 * The faults one call can carry: the seam's process faults (a SIGTERM only while it can still stop
 * a composed, unstopped process) and the call-specific faults its wrapper applies.
 */
function offeredFaults(instance: InstanceHandle, seam: SeamKind, label: string, effective: readonly FaultKind[]): FaultKind[] {
  const catalogue = APPLICABLE_FAULTS[seam];
  for (const fault of effective) {
    if (!catalogue.includes(fault) || PROCESS_FAULTS.has(fault)) throw new FaultNotInCatalogue(seam, label, fault);
  }
  return catalogue.filter((fault) => {
    if (fault === "sigterm") return !instance.sigtermed && instance.abort !== null;
    return PROCESS_FAULTS.has(fault) || effective.includes(fault);
  });
}

/**
 * Every seam call takes a ticket here (design §4.10), after its task's turn (Interleaver.turn):
 * tickets are taken one task at a time, in the order the seed's interleaving gives. A ticket may
 * carry one fault from the seed's tape while the fault budget lasts; a crash marks the instance dead.
 */
export class Scheduler {
  private ticket = 0;
  private budgetLeft: number;
  private readonly records: FaultRecord[] = [];
  /** Forced faults by ticket (the S-min enumeration): every other ticket runs clean. */
  private readonly forced: ReadonlyMap<number, FaultKind>;

  constructor(
    private readonly tape: Tape,
    private readonly rates: FaultRates,
    private readonly interleaver: Interleaver,
    forced: ReadonlyMap<number, FaultKind> = new Map(),
  ) {
    this.budgetLeft = rates.budget;
    this.forced = forced;
  }

  faults(): readonly FaultRecord[] {
    return [...this.records];
  }

  tickets(): number {
    return this.ticket;
  }

  /**
   * `effective` names the faults of the seam's own catalogue that this call's wrapper applies
   * (a podman `info` takes `substrate-down`, a `run` does not): the draw is made among those and
   * the process faults that take effect now, so no fault is recorded that changed nothing.
   */
  async enter(instance: InstanceHandle, seam: SeamKind, label: string, effective: readonly FaultKind[]): Promise<Fate> {
    await this.interleaver.turn(`${seam}:${label}`);
    if (instance.dead) throw new SimulatedCrash(instance.name, this.ticket, `${seam} ${label} (after death)`);
    this.ticket += 1;
    const ticket = this.ticket;
    const choices = offeredFaults(instance, seam, label, effective);
    let fault: FaultKind | null = this.forced.get(ticket) ?? null;
    if (fault !== null && !choices.includes(fault)) fault = "crash-before";
    // Keyed by the call's label, not the seam alone: a call production adds shifts the
    // occurrences of its own label only, not every later fault of the seam.
    const site = `fault.${seam}:${label}`;
    if (fault === null && this.budgetLeft > 0 && this.tape.chance(site, this.rates.perSeamCall)) {
      fault = choices[this.tape.pick(`${site}.kind`, choices.length)] ?? "crash-before";
    }
    if (fault === null) return { kind: "run", fault: null, crashAfter: false };
    this.budgetLeft -= 1;
    this.records.push({ ticket, instance: instance.name, seam, label, fault });
    if (fault === "crash-before") {
      instance.dead = true;
      throw new SimulatedCrash(instance.name, ticket, `${seam} ${label}`);
    }
    if (fault === "sigterm" && !instance.sigtermed) {
      instance.sigtermed = true;
      instance.abort?.();
    }
    return { kind: "run", fault, crashAfter: fault === "crash-after" };
  }

  /**
   * After the call ran, before its caller sees the result: the other task may run first, as it
   * may in production between a query's snapshot and the moment its rows reach the caller (a spend
   * sum read before another task's admission wrote its pending row).
   */
  async returned(seam: SeamKind, label: string): Promise<void> {
    await this.interleaver.turn(`${seam}:${label}:returned`);
  }

  /** After the call returned: a crash-after point dies now, its effect on the world kept. */
  leave(instance: InstanceHandle, fate: Fate, seam: SeamKind, label: string): void {
    if (fate.crashAfter) {
      instance.dead = true;
      throw new SimulatedCrash(instance.name, this.ticket, `${seam} ${label} (after it ran)`);
    }
  }
}

/** The simulator's clock: starts at a fixed instant and moves 50 ms per reading; a fault can jump it. */
export class SimClock implements Clock {
  private current = Date.UTC(2026, 9, 14, 9, 0, 0);

  now(): number {
    this.current += 50;
    return this.current;
  }

  /** The last instant read, without moving: every reading after it is later. */
  peek(): number {
    return this.current;
  }

  jump(ms: number): void {
    this.current += ms;
  }
}

/**
 * The date stamped on every host git call of one run: a commit's id hashes its author and committer
 * dates, so with the wall clock's a seed's commits differed from run to run. One second later per
 * call, from a fixed instant, and never read from the SimClock, whose readings production's own
 * clock reads would then shift. Kept across a run's restarts, as a host's clock is.
 */
export class GitDates {
  private calls = 0;

  next(): string {
    this.calls += 1;
    return `${Date.UTC(2026, 9, 14, 9, 0, 0) / 1000 + this.calls} +0000`;
  }
}

const queryText = z.union([z.string(), z.object({ text: z.string() })]);

function labelOfQuery(args: readonly unknown[]): string {
  const parsed = queryText.safeParse(args[0]);
  if (!parsed.success) return "query";
  const text = typeof parsed.data === "string" ? parsed.data : parsed.data.text;
  return text.replace(/\s+/g, " ").trim().slice(0, 60);
}

function pgError(code: string, message: string): pg.DatabaseError {
  const error = new pg.DatabaseError(message, message.length, "error");
  error.code = code;
  return error;
}

interface SeamContext {
  readonly scheduler: Scheduler;
  readonly instance: InstanceHandle;
  readonly clock: SimClock;
  /** Terminates one backend from the observer's own connection (F3). */
  readonly terminateBackend: (pid: number) => Promise<void>;
  readonly interleaver: Interleaver;
  /** Judges each host git call of a batch's tasks before it runs (I7, merge-queue clause). */
  readonly checkouts: CheckoutWatch;
  /** The run's current cycle, for a violation's step. */
  readonly cycle: () => number;
  /** Sees each llm_calls row written (I5, the admission clause). */
  readonly admissions: AdmissionLedger;
  /**
   * The scenario's standing outage of the cell runtime: every `podman run` fails to start its
   * cell. Not a fault of the tape's budget: the host stays broken for the whole run.
   */
  readonly cellOutage: boolean;
  readonly gitDates: GitDates;
}

/** A deliberate defect planted in the queries one instance sends (the L3 mutation check). */
export type QueryPlant = (args: readonly unknown[]) => unknown[];

const sentText = z.union([z.string(), z.object({ text: z.string() }).loose()]);

/** Records every merge under a commit that does not exist: I7 must name it. drizzle sends (query, params). */
export const skipMergeRecord: QueryPlant = (args) => {
  const parsed = sentText.safeParse(args[0]);
  const params = args[1];
  if (!parsed.success || !Array.isArray(params)) return [...args];
  const text = typeof parsed.data === "string" ? parsed.data : parsed.data.text;
  if (!/set "merge_commit" = \$1/.test(text)) return [...args];
  return [args[0], ["0".repeat(40), ...params.slice(1)], ...args.slice(2)];
};

/**
 * The task's infrastructure-fault count stops at 4, the fault that halts its project (execution.ts:
 * a budget of 3 uncharged requeues, the 4th halts, the 5th gives the task up): every fault after
 * the halt counts nothing toward giving the task up, so a standing outage halts and resumes the
 * project forever. The count is written `infrastructure_faults + 1` (WorkItemRepository).
 */
export const pinInfrastructureFaults: QueryPlant = (args) => {
  const parsed = sentText.safeParse(args[0]);
  if (!parsed.success) return [...args];
  const text = typeof parsed.data === "string" ? parsed.data : parsed.data.text;
  const pinned = text.replace(/((?:"work_items"\.)?"infrastructure_faults") \+ 1/, "least($1 + 1, 4)");
  if (pinned === text) return [...args];
  return [typeof parsed.data === "string" ? pinned : { ...parsed.data, text: pinned }, ...args.slice(1)];
};

const clientPid = z.object({ processID: z.number().int() });
/** How long a killed connection's client may take to see its end: past it, the harness is wrong. */
const TERMINATION_SEEN_MS = 10_000;

/** A backend the fault terminated never ended its client's connection: the fault did not take effect. */
class TerminationUnseen extends Error {
  constructor(
    readonly instance: string,
    readonly pid: number,
  ) {
    super(`${instance}: backend ${pid} was terminated, yet its client saw no end of the connection within ${TERMINATION_SEEN_MS} ms`);
    this.name = "TerminationUnseen";
  }
}
/** The most query labels kept per checked-out connection: enough to name what left it checked out. */
const CHECKOUT_LABELS = 8;

/**
 * The pool factory of one instance (S5): `application_name` names the instance so a crash can
 * terminate exactly its backends, and every query and connect takes a ticket.
 */
export function faultingPools(context: SeamContext, applicationName: string, plant: QueryPlant | null = null): PoolFactory {
  return (config) => {
    const pool = new pg.Pool({ ...config, application_name: applicationName, max: 4 });
    context.instance.pools.push(pool);
    const query = async (given: readonly unknown[], send: (args: unknown[]) => Promise<unknown>, kill: (() => Promise<void>) | null): Promise<unknown> => {
      const args = plant === null ? [...given] : plant(given);
      const run = (): Promise<unknown> => send(args);
      const label = labelOfQuery(args);
      // Killing the transaction needs a checked-out connection's backend: a pool query has none.
      const effective: FaultKind[] = kill === null ? ["db-query-failed"] : ["db-query-failed", "db-transaction-killed"];
      const fate = await context.scheduler.enter(context.instance, "db", label, effective);
      if (fate.fault === "db-query-failed") throw pgError("40001", "could not serialize access due to concurrent update (simulated)");
      if (fate.fault === "db-transaction-killed" && kill !== null) await kill();
      const value = await run();
      context.admissions.written(label, args);
      context.scheduler.leave(context.instance, fate, "db", label);
      await context.scheduler.returned("db", label);
      return value;
    };
    return new Proxy(pool, {
      get(target, property, receiver) {
        if (property === "query") {
          return (...args: unknown[]) => query(args, (sent) => Reflect.apply(target.query, target, sent), null);
        }
        if (property === "connect") {
          return async () => {
            const fate = await context.scheduler.enter(context.instance, "db", "connect", ["db-unreachable"]);
            if (fate.fault === "db-unreachable") {
              throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432 (simulated)"), { code: "ECONNREFUSED" });
            }
            const client = await target.connect();
            const handBack = context.interleaver.connectionHeld();
            try {
              context.scheduler.leave(context.instance, fate, "db", "connect");
            } catch (err) {
              handBack();
              // The process died holding a connection nothing will release: the connection dies with
              // it. Left checked out, it would hold the pool's end (the run's teardown) forever.
              client.release(true);
              throw err;
            }
            // pg-pool removes its own error listener while a client is checked out (pg-pool
            // index.js _acquireClient): an error between queries then has no listener in production.
            const onError = (err: Error): void => {
              context.instance.dead = true;
              context.instance.fatal ??= `uncaught pg error on a checked-out connection: ${err.message}`;
            };
            client.on("error", onError);
            const sent: string[] = [];
            context.instance.checkouts.set(client, sent);
            const pid = clientPid.safeParse(client);
            /**
             * Kills the connection's backend between two queries of its transaction, and returns only
             * once the client has seen the connection end: its error then reached `onError` with no
             * query in flight (the uncaught error that is production's fatal exit). The query after
             * it would otherwise race the termination's arrival, and whether the process exited this
             * cycle or a later one would depend on the machine's load, not the seed.
             */
            const kill = pid.success
              ? async (): Promise<void> => {
                  const ended = new Promise<void>((resolve) => client.once("end", () => resolve()));
                  await context.terminateBackend(pid.data.processID);
                  let timer: NodeJS.Timeout | undefined;
                  const unseen = new Promise<never>((_, reject) => {
                    timer = setTimeout(() => reject(new TerminationUnseen(context.instance.name, pid.data.processID)), TERMINATION_SEEN_MS);
                  });
                  try {
                    await Promise.race([ended, unseen]);
                  } finally {
                    clearTimeout(timer);
                  }
                }
              : null;
            return new Proxy(client, {
              get(inner, innerProperty, innerReceiver) {
                if (innerProperty === "release") {
                  return (...args: unknown[]) => {
                    handBack();
                    inner.removeListener("error", onError);
                    context.instance.checkouts.delete(inner);
                    return Reflect.apply(inner.release, inner, args);
                  };
                }
                if (innerProperty === "query") {
                  return (...args: unknown[]) => {
                    if (sent.length < CHECKOUT_LABELS) sent.push(labelOfQuery(args));
                    return query(args, (given) => Reflect.apply(inner.query, inner, given), kill);
                  };
                }
                const value: unknown = Reflect.get(inner, innerProperty, innerReceiver);
                return typeof value === "function" ? value.bind(inner) : value;
              },
            });
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
}

/** The git runner of one instance (S4): git stays real; a fault rejects like execFile on exit 128. */
export function faultingGit(context: SeamContext, inner: GitRunner): GitRunner {
  const guarded = async <T>(args: readonly string[], cwd: string, run: () => Promise<T>): Promise<T> => {
    // The subcommand alone: the next argument may be a commit, whose id varies from run to run, and
    // the label keys the fault draw (Scheduler.enter), which must be the same for one seed every run.
    const label = args.find((arg) => !arg.startsWith("-") && !arg.includes("=")) ?? "git";
    const fate = await context.scheduler.enter(context.instance, "git", label, ["git-failed"]);
    if (fate.fault === "git-failed") {
      throw Object.assign(new Error(`Command failed: git ${label}\nfatal: Unable to create 'index.lock': File exists. (simulated)`), {
        code: 128,
        stderr: "fatal: Unable to create 'index.lock': File exists. (simulated)\n",
      });
    }
    context.checkouts.observe(context.interleaver.currentTask(), args, cwd, context.cycle());
    const value = await run();
    context.scheduler.leave(context.instance, fate, "git", label);
    await context.scheduler.returned("git", label);
    return value;
  };
  const dated = (invocation: Parameters<GitRunner["text"]>[0]): Parameters<GitRunner["text"]>[0] => {
    const date = context.gitDates.next();
    return { ...invocation, env: { ...(invocation.env ?? process.env), GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } };
  };
  return {
    text: (invocation) => guarded(invocation.args, invocation.cwd, () => inner.text(dated(invocation))),
    bytes: (invocation) => guarded(invocation.args, invocation.cwd, () => inner.bytes(dated(invocation))),
  };
}

/** The one podman fault each subcommand answers with; a subcommand not named here takes only process faults. */
const PODMAN_FAULT_OF: Readonly<Partial<Record<string, FaultKind>>> = {
  info: "substrate-down",
  run: "cell-start-failed",
  exec: "cell-exec-failed",
  rm: "cell-teardown-failed",
  build: "image-build-failed",
};

/** The container runtime of one instance (S3): each subcommand's own fault answers like podman would. */
export function faultingPodman(context: SeamContext, inner: ProcessRunner): ProcessRunner {
  return async (request) => {
    const subcommand = request.args[0] ?? "";
    const label = subcommand === "image" ? `image ${request.args[1] ?? ""}` : subcommand;
    const specific = PODMAN_FAULT_OF[subcommand];
    const fate = await context.scheduler.enter(context.instance, "podman", label, specific === undefined ? [] : [specific]);
    const failed = (exitCode: number, stderr: string): Awaited<ReturnType<ProcessRunner>> => ({
      exitCode, signal: null, stdout: "", stdoutCut: null, stderr, stderrCut: null, killedByHost: false, stdinError: null,
      statusReport: request.statusChannel === true ? "" : null,
    });
    if (fate.fault === "substrate-down") return failed(125, "Error: unable to connect to Podman socket (simulated)");
    if (fate.fault === "cell-start-failed") return failed(126, "Error: crun: cannot start the container (simulated)");
    if (fate.fault === "cell-exec-failed") return failed(125, "Error: exec session exited unexpectedly (simulated)");
    if (fate.fault === "cell-teardown-failed") return failed(125, "Error: container is busy (simulated)");
    if (fate.fault === "image-build-failed") return failed(1, "Error: building at STEP \"RUN\": exit status 1 (simulated)");
    if (context.cellOutage && subcommand === "run") return failed(126, "Error: crun: cannot start the container (simulated outage)");
    const value = await inner(request);
    context.scheduler.leave(context.instance, fate, "podman", label);
    await context.scheduler.returned("podman", label);
    return value;
  };
}

/** The model transport of one instance (S2): a provider error throws before the stand-in answers. */
export function faultingModels(context: SeamContext, inner: LanguageModelFactory): LanguageModelFactory {
  return (provider, model) => {
    const resolved = inner(provider, model);
    if (typeof resolved === "string" || resolved.specificationVersion !== "v4") return resolved;
    return {
      ...resolved,
      doGenerate: async (options: LanguageModelV4CallOptions) => {
        const fate = await context.scheduler.enter(context.instance, "model", model.id, ["provider-error", "clock-jump"]);
        if (fate.fault === "provider-error") throw Object.assign(new Error("socket hang up (simulated)"), { code: "ECONNRESET" });
        if (fate.fault === "clock-jump") context.clock.jump(20 * 60 * 1000);
        const value = await resolved.doGenerate(options);
        context.scheduler.leave(context.instance, fate, "model", model.id);
        await context.scheduler.returned("model", model.id);
        return value;
      },
    };
  };
}
