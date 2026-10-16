import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import pg from "pg";
import { z } from "zod";
import { ClientRepository, SecretRepository, TargetCheckoutClaimedElsewhere, createDb } from "@ashara/db";
import { loadBaseCell } from "@ashara/execution-infra";
import { SecretStore, clientAccessCodeSecretName, createKeyFile, loadMasterKey } from "@ashara/security";
import type { MasterKey } from "@ashara/security";
import { composeAshara } from "@ashara/server/compose";
import type { AsharaInstance } from "@ashara/server/compose";
import { describeErrorChain, observeContendedWaits } from "@ashara/shared";
import { AdmissionLedger } from "./admissions.js";
import { CheckoutWatch } from "./checkout-watch.js";
import { createRunDatabase } from "./database.js";
import type { Database, RunDatabase } from "./database.js";
import { FakePodman } from "./fake-podman.js";
import type { FakeCell, PodmanEvent } from "./fake-podman.js";
import { GitDates, Scheduler, SimClock, SimulatedCrash, faultingGit, faultingModels, faultingPodman, faultingPools } from "./faults.js";
import type { FaultRecord, InstanceHandle, QueryPlant } from "./faults.js";
import { GitBroker } from "./git-broker.js";
import { Interleaver } from "./interleave.js";
import type { InterleaveEvent } from "./interleave.js";
import { asharaFaultHaltOf, checkCharges, checkSnapshot, checkTotality, mainFiles, outcomeOf, progressFacts, readCharges, readSnapshot, sourceOf } from "./invariants.js";
import type { Charges, Outcome, Snapshot, Violation } from "./invariants.js";
import { emptyCoverage, observeAcceptanceSweeps, sample, sampleModelPaths } from "./coverage.js";
import type { Coverage } from "./coverage.js";
import { behaviourPath, drawUniverse } from "./product.js";
import { PLANTED, plantSeamsOf, plantsBypassing } from "./plants.js";
import type { Mutation } from "./plants.js";
import { FAULTS, drawRates } from "./profile.js";
import type { Profile } from "./profile.js";
import { ResidueWatch, checkResidue } from "./residue.js";
import { StandIns } from "./scripted-models.js";
import { SimulatedClient } from "./simulated-client.js";
import type { ClientReply, ClientRoutes } from "./simulated-client.js";
import { Tape } from "./tape.js";
import type { Decision, TapeMode } from "./tape.js";

export interface RunOptions {
  readonly seed: number;
  readonly profile: Profile;
  readonly tape: TapeMode;
  /** The database server the scratch databases live on (never the shared database itself). */
  readonly databaseUrl: string;
  readonly template: string;
  readonly maxCycles: number;
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
  /**
   * The second project's rows are corrupted as the run reaches them (corruptRows): the containment
   * scenario, run with `projects: 2`, in which the first project must still progress (I8).
   */
  readonly corruptSecondProject?: boolean;
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
}

/** Design §2.9 I1's bound with today's constants: R repairs, N items, A attempts, K contests. */
const REPAIRS = 2;
const ATTEMPTS = 3;
const CONTESTS = 2;
const DEFAULT_CAP_USD = 25;
/**
 * The adversarial profile's cap. Every stand-in call is unpriced and counts at its worst-case
 * estimate (about $0.35 at a turn's bound), and misbehaving responses are retried, so at the
 * default cap most adversarial seeds halt at the cap before the paths after a misbehaviour are
 * reached.
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
 * (design §4.9). The longest such stretch the baseline measured is 2 cycles
 * (docs/investigations/simulator-baseline-2026-10-14.md §7.7), so the bound is three times that.
 */
const NO_PROGRESS_CYCLES = 6;
/**
 * The cycles an ended run settles on, each an idle interval apart, so what it owes the client is sent
 * on them. Why 3: a report whose post faulted is contained and tried again after a minute
 * (shared/contained-step.ts faultBackoffSeconds), and three idle intervals are the first that pass it.
 */
const SETTLE_CYCLES = 3;
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

/** How long a restart waits for a dead instance's database sessions to end. */
const BACKEND_EXIT_POLLS = 100;
const BACKEND_EXIT_POLL_MS = 50;

/** A composed instance and the generation that names its database sessions. */
interface Live {
  readonly ashara: AsharaInstance;
  readonly handle: InstanceHandle;
  readonly generation: number;
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
    // eslint-disable-next-line no-restricted-syntax -- policy default: message text only
    const each = sessions.map((s) => `pid ${s.pid} ${s.state ?? "(no state)"} since ${s.backendStart ?? "?"}, last query ${JSON.stringify(s.query ?? "")}`);
    super(`${sessions.length} database session(s) of ${applicationName} were still open ${BACKEND_EXIT_POLLS * BACKEND_EXIT_POLL_MS} ms after pg_terminate_backend: ${each.join("; ")}`);
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
  // Required configuration (ADR-074 d82 W9); the fake runtime accepts and ignores the caps they become.
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
function unfaultedError(phase: "cycle" | "boot", err: unknown, step: number, faults: readonly FaultRecord[]): Violation | null {
  if (crashBeneath(err) || faults.length > 0) return null;
  const name = err instanceof Error ? err.name : typeof err;
  return {
    invariant: "I1",
    step,
    statement: `a ${phase} threw ${name} with no fault injected while it ran, so every project's ${phase} failed on it: ${describeErrorChain(err)}`,
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

/** What the containment scenario has corrupted of its project so far. */
interface Corruption {
  taskSpec: boolean;
  blockKind: boolean;
  /** The steps that have held a contained fault of the project (step_faults), each traced once. */
  readonly contained: Set<string>;
}

/** The containment scenario was asked of a run without the second project it corrupts. */
class CorruptionWithoutSecondProject extends Error {
  constructor(readonly seed: number) {
    super(`seed ${seed}: corruptSecondProject needs projects: 2, so one project stays healthy for I8 to judge`);
    this.name = "CorruptionWithoutSecondProject";
  }
}

/**
 * The containment scenario (ADR-080 d10 C9): between cycles the observer corrupts the project's rows
 * as the run reaches them: its first task's task_spec once it has tasks (the gate reads it and
 * halts the project on the row, delivery gate.ts gateProject), then the kind of its open halt
 * episode with no report yet (the block reports' listing reads it, contained to that report), past
 * the kind CHECK of the scratch database, as a row written by another version would read. Every step
 * that comes to hold a contained fault of the project (step_faults) is traced as `contained <step>`.
 *
 * Blind spots: once the gate halts the project no listing of an active project names it, so the
 * corrupted rows never reach the parked exits', the replan's, the acceptance's or the delivered
 * reports' listings, nor intake, roster, first plan or plan reports; the corruptions are a jsonb
 * value that does not parse and an unknown enum value, never a row missing its parent, a duplicated
 * row or a value of the wrong type.
 */
async function corruptRows(db: Database, projectId: string, snapshot: Snapshot, corruption: Corruption, trace: string[]): Promise<void> {
  if (!corruption.taskSpec && snapshot.items.some((item) => item.level === "Task")) {
    await db.execute(sql`
      UPDATE work_items SET task_spec = '"planted: not a task spec"'::jsonb
      WHERE id = (SELECT id FROM work_items WHERE project_id = ${projectId} AND level = 'Task' ORDER BY created_at, id LIMIT 1)`);
    corruption.taskSpec = true;
    trace.push("plant: the second project's first task_spec corrupted");
  }
  const episode = snapshot.episodes.find((each) => !each.ended && each.reportId === null);
  if (!corruption.blockKind && episode !== undefined) {
    await db.execute(sql`ALTER TABLE project_blocks DROP CONSTRAINT IF EXISTS project_blocks_kind_check`);
    await db.execute(sql`UPDATE project_blocks SET kind = 'planted-unknown-kind' WHERE id = ${episode.id}`);
    corruption.blockKind = true;
    trace.push(`plant: the second project's open ${episode.kind} episode given an unknown kind`);
  }
  const steps = z.array(z.object({ step: z.string() })).parse((await db.execute(sql`SELECT DISTINCT step FROM step_faults WHERE project_id = ${projectId} ORDER BY step`)).rows);
  for (const { step } of steps) {
    if (corruption.contained.has(step)) continue;
    corruption.contained.add(step);
    trace.push(`contained ${step}`);
  }
}

/** A cycle's I10 window as it opened: the counters, and how many faults and decisions the run had made by then. */
interface ChargeWindowStart {
  readonly before: Charges;
  readonly faults: number;
  readonly decisions: number;
}

/** A tape decision that makes a stand-in misbehave: its model answers, or its agent works, other than as asked. */
const MISBEHAVIOUR_SITE = /^(model|agent)\./;

async function openChargeWindow(db: Database, projectIds: readonly string[], scheduler: Scheduler, tape: Tape, consulted: Set<string>): Promise<ChargeWindowStart> {
  consulted.clear();
  return { before: await readCharges(db, projectIds), faults: scheduler.faults().length, decisions: tape.decisions().length };
}

/** I10 over one cycle: its counters now against those it opened with (invariants.ts checkCharges). */
async function closeChargeWindow(
  start: ChargeWindowStart,
  step: number,
  db: Database,
  projectIds: readonly string[],
  scheduler: Scheduler,
  tape: Tape,
  consulted: ReadonlySet<string>,
): Promise<Violation[]> {
  return checkCharges({
    step,
    before: start.before,
    after: await readCharges(db, projectIds),
    faults: scheduler.faults().slice(start.faults),
    consulted: new Set(consulted),
    misbehaved: tape.decisions().slice(start.decisions).some((decision) => MISBEHAVIOUR_SITE.test(decision.key)),
  });
}

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
const STOP_BODY = "Please stop the work.";
const CHANGE_BODY = "Use French, please.";

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

/** A query plant matched no query the run sent: the mutation planted nothing, so nothing was tested. */
class PlantInert extends Error {
  constructor(
    readonly seed: number,
    readonly mutation: Mutation,
  ) {
    super(`seed ${seed}: the plant of mutation ${mutation} rewrote no query of the run; production no longer sends what it matches`);
    this.name = "PlantInert";
  }
}

/** What a read-back of the server's records found of an action that may already have landed. */
type Landed<T> = { readonly found: true; readonly value: T } | { readonly found: false };

function firstQuestion(messages: ReadonlyArray<{ readonly id: string; readonly direction: string; readonly kind: string }>): string | null {
  return messages.find((message) => message.direction === "outbound" && message.kind === "question")?.id ?? null;
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
  // eslint-disable-next-line no-restricted-syntax -- policy default: standing text; a project with no category and one with a category are still distinct standings
  return `${snapshot.project.status}(${snapshot.project.blockedCategory ?? ""})#${snapshot.episodes.length}`;
}

/**
 * One seed, start to end (design §4.8-§4.11): the real system composed over a private scratch
 * database, real git, the fake container runtime and the scripted models; the invariants judged
 * after every cycle; crashes and SIGTERMs answered by composing a new instance on the same workdir.
 */
export async function runSeed(options: RunOptions): Promise<RunResult> {
  const started = Date.now();
  const tape = new Tape(options.tape);
  const rates = drawRates(options.profile, tape);
  const clock = new SimClock();
  const universe = drawUniverse(tape);
  const capUsd =
    options.capUsd ?? (tape.chance("finance.low-budget", rates.lowBudget) ? LOW_CAP_USD : options.profile === "adversarial" ? ADVERSARIAL_CAP_USD : DEFAULT_CAP_USD);
  const projectCount = options.projects ?? 1;
  if (options.corruptSecondProject === true && projectCount < 2) throw new CorruptionWithoutSecondProject(options.seed);
  const corruption: Corruption | null = options.corruptSecondProject === true ? { taskSpec: false, blockKind: false, contained: new Set() } : null;
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
  const asharaHalts: string[] = [];
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
        for (const mutation of plantsBypassing(event.wait)) coverage.plants.add(mutation);
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
  // The queries the plant changed: a mutation run whose plant changed none tested nothing.
  let bites = 0;
  const plantedQueries = planted?.queries ?? null;
  const queryPlant: QueryPlant | null =
    plantedQueries === null
      ? null
      : (args) => {
          const sent = plantedQueries(args);
          if (sent !== null) bites += 1;
          return sent;
        };
  // eslint-disable-next-line no-restricted-syntax -- policy default: a run with no plant bypasses no seam
  const interleaver = new Interleaver(tape, new Set(planted?.bypassed ?? []), onInterleave);
  const scheduler = new Scheduler(tape, FAULTS[options.profile], interleaver);
  const admissions = new AdmissionLedger();
  const residue = new ResidueWatch();
  const gitDates = new GitDates();
  let longestQuiet = 0;
  /** The tasks a stand-in answered for in the cycle running now (I10's window). */
  const consulted = new Set<string>();

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
  /** The instance whose runner a cycle stopped: it runs only halted cycles until a restart replaces it. */
  let haltedLive: Live | null = null;
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

    // The operator registers each project's client and its access code, as scripts/client.ts add
    // does; everything the client says after that goes through the server's client routes.
    const register = async (suffix: string): Promise<SimulatedClient> => {
      const code = `sim-access-code-${options.seed}${suffix}-0123456789`;
      const row = await new ClientRepository(observing).create(`sim-client-${options.seed}${suffix}`);
      await secrets.put(clientAccessCodeSecretName(row.id), code);
      return new SimulatedClient(row.name, code);
    };
    const client = await register("");
    const others: SimulatedClient[] = [];
    for (let index = 1; index < projectCount; index++) others.push(await register(`-p${index + 1}`));
    // Filled as the server creates each client's project; the stand-ins answer for these only.
    const projectIds: string[] = [];

    const standIns = new StandIns({
      tape,
      rates,
      universe,
      observer: observing,
      projectIds,
      onModelCall: (call) => {
        trace.push(`model ${call.site} ${call.action}`);
        const task = interleaver.currentTask();
        if (task !== null) consulted.add(task);
      },
      laneTask: () => interleaver.currentTask(),
    });
    const baseCell = await loadBaseCell();
    /** Every cell started over the run, live or removed: I3 judges the role each one ran as. */
    const startedCells: FakeCell[] = [];
    const observe = (event: PodmanEvent): void => {
      switch (event.kind) {
        case "cell-started":
          startedCells.push(event.cell);
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
    const sessionsOf = async (name: string): Promise<readonly OutlivingSession[]> => {
      const result = await observing.execute(
        sql`SELECT pid, state, backend_start::text AS "backendStart", left(query, 200) AS query FROM pg_stat_activity WHERE application_name = ${name}`,
      );
      return z.array(outlivingSessionSchema).parse(result.rows);
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
     * Its pools end too: an exit closes the process's sockets, so a connection still being opened
     * when the backends are terminated (a query of a failed Promise.all's sibling, which entered
     * before the death) closes as it lands, never idling in a dead pool past the poll's bound.
     */
    const killBackends = async (handle: InstanceHandle, of: number): Promise<void> => {
      for (const pool of handle.pools) {
        if (pool.ending) continue;
        void pool.end().catch((err: unknown) => {
          log.push(`ending a pool of the dead ${handle.name} failed: ${describeErrorChain(err)}`);
        });
      }
      const name = instanceName(of);
      await observing.execute(sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = ${name}`);
      const left = await backendsAfterExit(name);
      if (left > 0) throw new BackendsOutlivedInstance(name, await sessionsOf(name));
    };

    let generation = 0;
    const compose = async (): Promise<Live> => {
      for (;;) {
        generation += 1;
        const faultsBefore = scheduler.faults().length;
        const handle: InstanceHandle = { name: `sim-${generation}`, dead: false, abort: null, sigtermed: false, fatal: null, checkouts: new Map(), pools: [] };
        // A new process stages nothing yet: the dead one's staged merge is an orphan its recovery clears.
        checkouts = new CheckoutWatch(report);
        const seam = {
          scheduler,
          instance: handle,
          clock,
          terminateBackend,
          interleaver,
          checkouts,
          cycle: () => cycles,
          admissions,
          cellOutage: options.cellOutage === true,
          gitDates,
          queried: (args: readonly unknown[]) => {
            for (const mutation of plantSeamsOf(args, coverage.plants)) coverage.plants.add(mutation);
          },
        };
        try {
          const ashara = await composeAshara({
            masterKey,
            databaseUrl: instanceUrl(db.url, instanceName(generation)),
            createPool: faultingPools(seam, instanceName(generation), queryPlant),
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
          if (!(err instanceof TargetCheckoutClaimedElsewhere)) {
            const unfaulted = unfaultedError("boot", err, cycles, scheduler.faults().slice(faultsBefore));
            if (unfaulted !== null) report(unfaulted);
          }
          // Every earlier instance's sessions are gone before a boot (killBackends, the drain's
          // check), so a refused claim is one nothing in this run holds: never a retry, a finding.
          if (err instanceof TargetCheckoutClaimedElsewhere) {
            const violation: Violation = { invariant: "I1", step: cycles, statement: `${handle.name} was refused its target claim with no other instance alive: ${err.message}`, key: "I1:claim-refused" };
            violations.set(violation.key, violation);
          }
          await killBackends(handle, generation);
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
          await killBackends(current.handle, current.generation);
        }
      } else {
        current.handle.dead = true;
        await killBackends(current.handle, current.generation);
      }
      instance = await compose();
      // I7, restart clause: the reconciler leaves nothing InProgress and no cell of the dead process.
      for (const [index, id] of projectIds.entries()) {
        const after = await readSnapshot(observing, id);
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

    /** A process that died or was SIGTERMed is restarted before anything else is asked of it. */
    const recover = async (current: Live): Promise<void> => {
      if (current.handle.fatal !== null) trace.push(`fatal exit: ${current.handle.fatal.split(":")[0]}`);
      if (current.handle.dead) await restart(current, current.handle.fatal === null ? "a crash" : "a fatal exit");
      else if (current.handle.sigtermed) await restart(current, "a SIGTERM");
    };

    /**
     * One client action, sent to the live instance's routes. A failure the server's process can
     * cause (a fault the tape injected, the instance then restarted) is answered as a client would:
     * read back whether the action already landed, then send it again. Any other refusal ends the run.
     */
    const clientAct = async <T>(
      action: string,
      send: (app: ClientRoutes) => Promise<ClientReply<T>>,
      landed: ((app: ClientRoutes) => Promise<ClientReply<Landed<T>>>) | null,
    ): Promise<T> => {
      let unsure = false;
      let last = "";
      const failed = async (reply: { readonly status: number; readonly detail: string }, current: Live, request: number): Promise<void> => {
        last = `${reply.status} ${reply.detail}`;
        trace.push(`client ${action}: request ${request} answered ${reply.status}`);
        if (!CLIENT_RETRIED.has(reply.status)) throw new ClientRequestRefused(options.seed, action, reply.status, reply.detail);
        await recover(current);
      };
      for (let request = 1; request <= MAX_CLIENT_REQUESTS; request++) {
        const current = instance;
        if (current === null) throw new ClientRequestsExhausted(options.seed, action, "no instance is composed");
        if (unsure && landed !== null) {
          const seen = await landed(current.ashara.app);
          if (!seen.ok) {
            await failed(seen, current, request);
            continue;
          }
          if (seen.value.found) return seen.value.value;
          unsure = false;
        }
        const reply = await send(current.ashara.app);
        if (reply.ok) return reply.value;
        unsure = true;
        await failed(reply, current, request);
      }
      throw new ClientRequestsExhausted(options.seed, action, last);
    };

    instance = await compose();
    // Each client tenders its project through the routes; the late change and the stop are the
    // first project's, and its outcome is the run's.
    const tender = async (simulated: SimulatedClient, index: number): Promise<string> => {
      const projectName = `sim-${options.seed}${index === 0 ? "" : `-p${index + 1}`}`;
      return clientAct<string>(
        `tender ${index + 1}`,
        (app) => simulated.tender(app, projectName, `Build a product with ${universe.behaviours.join(", ")}.`),
        async (app) => {
          const listed = await simulated.projects(app);
          if (!listed.ok) return listed;
          const project = listed.value.find((each) => each.name === projectName);
          return { ok: true, value: project === undefined ? { found: false } : { found: true, value: project.id } };
        },
      );
    };
    const projectId = await tender(client, 0);
    projectIds.push(projectId);
    for (const [index, other] of others.entries()) projectIds.push(await tender(other, index + 1));
    const snapshotsOf = async (): Promise<[Snapshot, ...Snapshot[]]> => {
      const first = await readSnapshot(observing, projectId);
      const rest: Snapshot[] = [];
      for (const id of projectIds.slice(1)) rest.push(await readSnapshot(observing, id));
      return [first, ...rest];
    };
    /** Whether the first project's messages hold an inbound one `matches` picks out. */
    const onRecord = async (app: ClientRoutes, matches: (message: { readonly kind: string; readonly body: string; readonly inReplyTo: string | null }) => boolean): Promise<ClientReply<Landed<null>>> => {
      const listed = await client.messages(app, projectId);
      if (!listed.ok) return listed;
      return { ok: true, value: listed.value.some((message) => message.direction === "inbound" && matches(message)) ? { found: true, value: null } : { found: false } };
    };

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
        await clientAct<null>(
          "stop",
          (app) => client.post(app, projectId, { kind: "stop", body: STOP_BODY }),
          (app) => onRecord(app, (message) => message.kind === "stop" && message.body === STOP_BODY),
        );
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
      const window = await openChargeWindow(observing, projectIds, scheduler, tape, consulted);
      for (let r = 0; r < repeats && !crashed; r++) {
        const faultsBefore = scheduler.faults().length;
        try {
          const faultsBefore = scheduler.faults().length;
          // The runner's own path (orchestrator runner.ts run): once a cycle stops the loop, the
          // process runs only halted cycles until it restarts, and its onHalt removes every cell.
          if (haltedLive === current) {
            await current.ashara.cycles.runHaltedCycle();
            residue.cycleRan(scheduler.faults().length === faultsBefore && !current.handle.dead && !current.handle.sigtermed);
            trace.push(`cycle ${cycles}: halted`);
            crashed = current.handle.dead || current.handle.sigtermed;
            continue;
          }
          const result = await current.ashara.cycles.runCycle();
          residue.cycleRan(scheduler.faults().length === faultsBefore && !current.handle.dead && !current.handle.sigtermed);
          dispatches += result.tasksProcessed;
          processed += result.tasksProcessed;
          for (const task of result.results) statuses.push(task.status);
          trace.push(`cycle ${cycles}: ${result.tasksProcessed} task(s) [${result.results.map((t) => t.status).join(",")}]${result.stop === null ? "" : ` stop: ${result.stop.reason.split(":")[0]}`}`);
          if (result.stop !== null && !current.handle.dead) {
            outcome = { kind: "halted", cause: "spend_cap", detail: result.stop.reason };
            haltedLive = current;
            await current.ashara.teardownCells();
          }
        } catch (err) {
          trace.push(`cycle ${cycles}: error ${err instanceof SimulatedCrash ? "SimulatedCrash" : err instanceof Error ? err.name : "unknown"}`);
          if (!(err instanceof SimulatedCrash) && !current.handle.dead) log.push(`cycle error: ${describeErrorChain(err)}`);
          const unfaulted = unfaultedError("cycle", err, cycles, scheduler.faults().slice(faultsBefore));
          if (unfaulted !== null) report(unfaulted);
        }
        crashed = current.handle.dead || current.handle.sigtermed;
      }
      // The runner's own wait between cycles (orchestrator runner.ts defaults), on the simulated clock.
      clock.jump(processed > 0 ? POLL_INTERVAL_MS : IDLE_INTERVAL_MS);
      await recover(current);
      for (const violation of await closeChargeWindow(window, cycles, observing, projectIds, scheduler, tape, consulted)) report(violation);

      const snapshots = await snapshotsOf();
      const [snapshot] = snapshots;
      const corrupted = projectIds[1];
      const second = snapshots[1];
      if (corruption !== null && corrupted !== undefined && second !== undefined) await corruptRows(observing, corrupted, second, corruption, trace);
      for (const [index, each] of snapshots.entries()) {
        for (const violation of checkSnapshot(cycles, each, { spendCapUsd: capUsd, cells: startedCells, final: false })) report(ofProject(index, violation));
        sample(coverage, each, scheduler.faults(), executionEvidence(each, statuses));
        residue.observe(each);
      }
      const overCommitted = await admissions.judge(observing, capUsd, cycles);
      if (overCommitted !== null) report(overCommitted);
      trace.push(
        snapshots
          .map((each) => `state ${each.items.filter((i) => i.level === "Task").map((i) => `${i.title.slice(0, 40)}=${i.status}`).join("; ")} | project=${each.project.status}`)
          .join(" || "),
      );

      if (lateChange && !changed && snapshot.items.some((i) => i.origin === "decomposition" && i.status === "Completed")) {
        const question = await clientAct<string | null>(
          "reading its messages",
          async (app) => {
            const listed = await client.messages(app, projectId);
            return listed.ok ? { ok: true, value: firstQuestion(listed.value) } : listed;
          },
          null,
        );
        if (question !== null) {
          await clientAct<null>(
            "answer",
            (app) => client.post(app, projectId, { kind: "answer", body: CHANGE_BODY, inReplyTo: question }),
            (app) => onRecord(app, (message) => message.kind === "answer" && message.inReplyTo === question),
          );
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

    if (options.mutation !== undefined && queryPlant !== null && bites === 0) throw new PlantInert(options.seed, options.mutation);
    const finals = await snapshotsOf();
    await sampleModelPaths(coverage, observing, projectIds);
    const [final] = finals;
    for (const [index, each] of finals.entries()) {
      const halt = asharaFaultHaltOf(each);
      if (halt !== null) asharaHalts.push(`project ${index + 1}: ${halt}`);
    }
    // The report clause needs the settle cycles a halt's report is posted on: a run cut off for no
    // progress had none, and may end on a halt begun in its last cycle (I8 judges that run).
    for (const [index, each] of finals.entries()) {
      for (const violation of checkSnapshot(cycles, each, { spendCapUsd: capUsd, cells: startedCells, final: !noProgress })) report(ofProject(index, violation));
    }
    const overCommitted = await admissions.judge(observing, capUsd, cycles);
    if (overCommitted !== null) report(overCommitted);
    for (const [index, each] of finals.entries()) {
      for (const violation of await checkResidue(cycles, each, residue.judgeable, { git: gitBroker.runner, workdirBase: workdir, cells: podman.liveCells() })) report(ofProject(index, violation));
    }
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
        .map((item) => {
          const source = sourceOf(item.blockedReason);
          return `"${item.title}" ${item.status}${source === null ? "" : ` (${source})`}`;
        });
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
  const untaken = tape.untaken();
  if (untaken.length > 0) throw new DirectionsNotTaken(options.seed, untaken);
  return {
    seed: options.seed,
    profile: options.profile,
    outcome,
    asharaHalts,
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
