import { sql } from "drizzle-orm";
import { z } from "zod";
import { describeErrorChain } from "@ashara/shared";
import type { CorrectionDraw } from "./correction-draws.js";
import { sample } from "./coverage.js";
import type { Database } from "./database.js";
import { SimulatedCrash } from "./faults.js";
import type { Scheduler } from "./faults.js";
import {
  blockedReasonOf,
  checkCharges,
  checkSnapshot,
  outcomeOf,
  owedReports,
  progressFacts,
  readCharges,
  readSnapshot,
  sourceOf,
} from "./invariants.js";
import type { Charges, SilenceCycle, Snapshot, Violation } from "./invariants.js";
import { FAULTS } from "./profile.js";
import { lateReceipts, unansweredMessages } from "./receipts.js";
import { ofProject, onRecord, stopIfAborted, unfaultedError } from "./run-instance.js";
import type { Live, RunState, SimulatedProcess } from "./run-instance.js";
import type { Provisioned, RunDraws, RunWorld } from "./run-setup.js";
import type { RunOptions } from "./run.js";
import type { StandIns } from "./scripted-models.js";
import type { SimulatedClient } from "./simulated-client.js";
import type { Tape } from "./tape.js";

/**
 * I8's bound: fault-free cycles in a row with no progress (invariants.ts progressFacts) after which
 * the run is judged to make none. Why 6: a task's own work progresses on every charged attempt and
 * every status it first reaches, and what may pass between two such facts without a fault is the
 * loop's own bookkeeping: a parked exit taken on the next cycle's sweep, a replan waiting one cycle
 * for its project's tasks to settle, a halt's report and the probe's resumption, each one cycle. A
 * cycle that carried an injected fault or a restart does not count: the fault budget bounds those.
 * The longest such stretch the baseline measured is 2 cycles, so the bound is three times that.
 */
export const NO_PROGRESS_CYCLES = 6;
const POLL_INTERVAL_MS = 10_000;
const IDLE_INTERVAL_MS = 30_000;
/**
 * @testseam The wait before a report whose post faulted is tried again: the product's first fault
 * backoff (shared FIRST_FAULT_BACKOFF_SECONDS). The simulator may not import it, so
 * integration server/settle-cycles.test.ts holds the two equal.
 */
export const REPORT_RETRY_MS = 60_000;
/**
 * The cycles an ended run settles on, each an idle interval apart, so what it owes the client is sent
 * on them: as many idle intervals as the first that pass a faulted report's retry wait.
 */
const SETTLE_CYCLES = Math.floor(REPORT_RETRY_MS / IDLE_INTERVAL_MS) + 1;
const STOP_BODY = "Please stop the work.";
const CHANGE_BODY = "Use French, please.";
/** The client's correction (ClientCorrection); its stored revision is read back at the run's end (sampleCorrection). */
export const CORRECTION_BODY = "Never colour the output.";
/** The client of a declined contract confirming it as written, which leaves it declined. */
const CONFIRM_AS_WRITTEN_BODY = "I confirm the contract as written.";
/** The client of a declined contract restating its guarantees, which releases the work. */
const RESTATE_BODY = "You can see every guarantee in what the product outputs.";
/** A tape decision that makes a stand-in misbehave: its model answers, or its agent works, other than as asked. */
const MISBEHAVIOUR_SITE = /^(model|agent)\./;

/** What the containment scenario has corrupted of its project so far. */
export interface Corruption {
  taskSpec: boolean;
  blockKind: boolean;
  /** The steps that have held a contained fault of the project (step_faults), each traced once. */
  readonly contained: Set<string>;
}

/**
 * The containment scenario: between cycles the observer corrupts the project's rows
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
async function corruptRows(
  db: Database,
  projectId: string,
  snapshot: Snapshot,
  corruption: Corruption,
  trace: string[],
): Promise<void> {
  if (!corruption.taskSpec && snapshot.items.some((item) => item.level === "Task")) {
    // Never while that task runs: a lane may be in flight when the world acts between settlements,
    // and the plant is the gate's to meet, not the attempt's.
    const written = await db.execute(sql`
      UPDATE work_items SET task_spec = '"planted: not a task spec"'::jsonb
      WHERE id = (SELECT id FROM work_items WHERE project_id = ${projectId} AND level = 'Task'
                  ORDER BY created_at, id LIMIT 1)
        AND status <> 'InProgress'
      RETURNING id`);
    if (written.rows.length > 0) {
      corruption.taskSpec = true;
      trace.push("plant: the second project's first task_spec corrupted");
    }
  }
  // The open episode the silence clause owes a halt report (owedReports), so the one corrupted is
  // one I2 then names untold.
  const owed = new Set(owedReports(snapshot).map((each) => each.subject));
  const episode = snapshot.episodes.find((each) => !each.ended && owed.has(`halt:${each.id}`));
  if (!corruption.blockKind && episode !== undefined) {
    await db.execute(sql`ALTER TABLE project_blocks DROP CONSTRAINT IF EXISTS project_blocks_kind_check`);
    await db.execute(sql`UPDATE project_blocks SET kind = 'planted-unknown-kind' WHERE id = ${episode.id}`);
    corruption.blockKind = true;
    trace.push(`plant: the second project's open ${episode.kind} episode given an unknown kind`);
  }
  const faulted = await db.execute(
    sql`SELECT DISTINCT step FROM step_faults WHERE project_id = ${projectId} ORDER BY step`,
  );
  const steps = z.array(z.object({ step: z.string() })).parse(faulted.rows);
  for (const { step } of steps) {
    if (corruption.contained.has(step)) continue;
    corruption.contained.add(step);
    trace.push(`contained ${step}`);
  }
}

/**
 * A task a client's correction holds comes back to Pending while the correction still awaits its
 * revision, as one does through a path the hold did not see (a crash-orphaned attempt requeued or
 * read off main, a failed attempt retried): the first held task, written back to Pending as such a
 * path writes it. Returns whether one was; none is while no awaited correction holds a task.
 */
async function returnHeldTask(db: Database, projectId: string, snapshot: Snapshot, trace: string[]): Promise<boolean> {
  const held = snapshot.items.find(
    (item) =>
      item.level === "Task" &&
      item.status === "Blocked" &&
      blockedReasonOf(item.blockedReason)?.source === "correction_pending",
  );
  if (held === undefined) return false;
  const written = await db.execute(sql`
    UPDATE work_items SET status = 'Pending', blocked_reason = NULL, updated_at = now()
    WHERE id = ${held.id} AND status = 'Blocked'
      AND EXISTS (SELECT 1 FROM correction_holds ch WHERE ch.project_id = ${projectId} AND ch.plan_revision_id IS NULL)
    RETURNING id`);
  if (written.rows.length === 0) return false;
  trace.push(`held task "${held.title}" back at Pending before its correction's revision`);
  return true;
}

/**
 * Whether the client's correction arrives after this cycle (correction-draws.ts): a goal task has
 * merged; the first plan is on record and no suite review has been answered; the project is halted.
 * The in-progress arrival is posted during an agent turn instead (ClientCorrection duringAgentTurn).
 */
function correctionArrives(arrival: CorrectionDraw["arrival"], snapshot: Snapshot, reviewsAnswered: number): boolean {
  switch (arrival) {
    case "after-merge":
      return snapshot.items.some((item) => item.origin === "decomposition" && item.status === "Completed");
    case "before-review":
      return reviewsAnswered === 0 && snapshot.items.some((item) => item.level === "Task");
    case "halted":
      return snapshot.project.status === "blocked";
    case "in-progress":
      return false;
  }
}

/** A cycle's I10 window as it opened: the counters, and how many faults and decisions the run had made by then. */
interface ChargeWindowStart {
  readonly before: Charges;
  readonly faults: number;
  readonly decisions: number;
}

/**
 * Where a cycle's I10 counters are read from: the database, the run's fault schedule, its decision
 * tape and the sites it consulted.
 */
interface ChargeSources {
  readonly db: Database;
  readonly projectIds: readonly string[];
  readonly scheduler: Scheduler;
  readonly tape: Tape;
  readonly consulted: Set<string>;
}

async function openChargeWindow(sources: ChargeSources): Promise<ChargeWindowStart> {
  const { db, projectIds, scheduler, tape, consulted } = sources;
  consulted.clear();
  return {
    before: await readCharges(db, projectIds),
    faults: scheduler.faults().length,
    decisions: tape.decisions().length,
  };
}

/** I10 over one cycle: its counters now against those it opened with (invariants.ts checkCharges). */
async function closeChargeWindow(
  start: ChargeWindowStart,
  step: number,
  { db, projectIds, scheduler, tape, consulted }: ChargeSources,
): Promise<Violation[]> {
  return checkCharges({
    step,
    before: start.before,
    after: await readCharges(db, projectIds),
    faults: scheduler.faults().slice(start.faults),
    consulted: new Set(consulted),
    misbehaved: tape
      .decisions()
      .slice(start.decisions)
      .some((decision) => MISBEHAVIOUR_SITE.test(decision.key)),
  });
}

function firstQuestion(
  messages: ReadonlyArray<{ readonly id: string; readonly direction: string; readonly kind: string }>,
): string | null {
  return messages.find((message) => message.direction === "outbound" && message.kind === "question")?.id ?? null;
}

/** What a snapshot shows of the execution statuses the cycle's routing produced (none is logged by status). */
function executionEvidence(snapshot: Snapshot, statuses: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const status of statuses) {
    if (status === "refused" || status === "interrupted" || status === "failed" || status === "blocked")
      seen.add(status);
  }
  for (const transition of snapshot.transitions) if (transition.to === "Completed") seen.add("completed");
  for (const item of snapshot.items) {
    const source = sourceOf(item.blockedReason);
    if (source === "environment_unavailable") seen.add("environment_blocked");
    if (source === "environment_undefined") seen.add("environment_undefined");
    if (source === "checks_stale" || source === "checks_rewrite_bound") seen.add("checks_stale");
    if (source === "check_disputed") seen.add("disputed");
    if (source === "suite_review_unresolved") seen.add("suite_review_problems");
    if (source === "environment_change_needed") seen.add("environment_change_requested");
    if (source === "owner_unresolved") seen.add("owner_unresolved");
    if (source === "context_window_exceeded") seen.add("context_exceeded");
    if (source === "no_wider_model") seen.add("no_wider_model");
    if (source === "awaiting_work") seen.add("prerequisite_needed");
    if (source === "awaiting_client" || source === "client_answered") seen.add("client_decision_needed");
  }
  // A task waits on an environment change only once its environment task is opened, and on
  // rewritten checks only once a check task is reopened: each leaves that durable record.
  for (const item of snapshot.items) {
    if (item.workKind === "environment" && item.origin === "environment-change")
      seen.add("environment_change_requested");
  }
  const checkTasks = new Set(snapshot.items.filter((item) => item.workKind === "check").map((item) => item.id));
  for (const transition of snapshot.transitions) {
    if (checkTasks.has(transition.workItemId) && transition.from === "Completed" && transition.to === "Pending") {
      seen.add("disputed");
    }
  }
  return [...seen];
}

/** Where a project's end stands: a halt that ends and begins again is not one end. */
function standing(snapshot: Snapshot): string {
  /* eslint-disable-next-line no-restricted-syntax -- policy default: standing text; a project with no category and
     one with a category are still distinct standings */
  return `${snapshot.project.status}(${snapshot.project.blockedCategory ?? ""})#${snapshot.episodes.length}`;
}

/** Every project's snapshot, the first project's first. */
export async function snapshotsOf(
  observer: Database,
  projectIds: readonly string[],
): Promise<[Snapshot, ...Snapshot[]]> {
  const [projectId, ...rest] = projectIds;
  if (projectId === undefined) throw new NoProjectTendered();
  const first = await readSnapshot(observer, projectId);
  const others: Snapshot[] = [];
  for (const id of rest) others.push(await readSnapshot(observer, id));
  return [first, ...others];
}

/** A snapshot was asked for before any project was tendered: the run has nothing to judge. */
class NoProjectTendered extends Error {
  constructor() {
    super("a snapshot was asked for before the first project was tendered");
    this.name = "NoProjectTendered";
  }
}

/** The cycle loop asked for the live instance before the first one was composed. */
class NoInstanceComposed extends Error {
  constructor(readonly cycle: number) {
    super(`cycle ${cycle} began with no instance composed`);
    this.name = "NoInstanceComposed";
  }
}

const isCorrection = (message: { readonly kind: string; readonly body: string }): boolean =>
  message.kind === "change" && message.body === CORRECTION_BODY;

/** Whether a listed message is the client's change sent with `body`. */
const isChange = (message: { readonly kind: string; readonly body: string }, body: string): boolean =>
  message.kind === "change" && message.body === body;

/** Who a correction is posted to and by, set once the first project is tendered. */
interface CorrectionTarget {
  readonly projectId: string;
  readonly client: SimulatedClient;
  readonly standIns: StandIns;
  readonly observer: Database;
}

/**
 * The client's correction of the first project: whether it was posted, whether a post that failed
 * mid-cycle may have landed, the in-progress arrival, posted before an agent turn of a task citing a
 * contract key of the first project, once, while that task is InProgress, and every other arrival
 * reached at a settlement of the cycle's lanes. A request that fails is tried again at a later
 * turn, settlement or cycle; the instance it failed on is restarted by the loop after its cycle,
 * never from inside it. Before the first project is tendered nothing is posted.
 */
export class ClientCorrection {
  corrected = false;
  /** A correction post mid-cycle that may have landed: read back before it is sent again. */
  unsure = false;
  private target: CorrectionTarget | null = null;

  constructor(
    private readonly draw: CorrectionDraw | null,
    private readonly state: RunState,
  ) {}

  arm(target: CorrectionTarget): void {
    this.target = target;
  }

  async duringAgentTurn(task: { readonly id: string; readonly projectId: string }): Promise<void> {
    const { draw, target } = this;
    if (target === null) return;
    if (draw?.arrival !== "in-progress" || this.corrected || task.projectId !== target.projectId) return;
    if (!this.liveNow()) return;
    const cites = await target.observer.execute(
      sql`SELECT CASE WHEN jsonb_typeof(task_spec->'sources') = 'array'
                      THEN jsonb_array_length(task_spec->'sources') > 0 ELSE false END AS cites
          FROM work_items WHERE id = ${task.id}`,
    );
    const [row] = z.array(z.object({ cites: z.boolean() })).parse(cites.rows);
    if (row?.cites !== true) return;
    await this.postMidCycle(draw, target, task.id, "during an agent turn", "while its task is InProgress");
  }

  /**
   * The correction whose arrival a settlement of the cycle's lanes reached, posted before the freed
   * lane refills, as a client's message arrives while the loop works; the arrivals and their order
   * are those posted between cycles (CycleLoop clientActs).
   */
  async afterSettlement(snapshot: Snapshot, reviewsAnswered: number): Promise<void> {
    const { draw, target } = this;
    if (target === null || draw === null || this.corrected) return;
    if (!correctionArrives(draw.arrival, snapshot, reviewsAnswered)) return;
    if (!this.liveNow()) return;
    await this.postMidCycle(draw, target, null, "between two settlements", "between two settlements");
  }

  /** Whether the live instance can take a request now; a dead or SIGTERMed one is restarted after its cycle. */
  private liveNow(): boolean {
    const current = this.state.live;
    return current !== null && !current.handle.dead && !current.handle.sigtermed;
  }

  /**
   * One try at the correction from inside a cycle: a post that may have landed is read back first,
   * and one that fails is left unsure, to be read back at a later turn, settlement or cycle.
   */
  private async postMidCycle(
    draw: CorrectionDraw,
    target: CorrectionTarget,
    taskId: string | null,
    during: string,
    at: string,
  ): Promise<void> {
    const { state } = this;
    const current = state.live;
    if (current === null) return;
    try {
      if (this.unsure) {
        const seen = await onRecord(target.client, target.projectId, current.ashara.app, isCorrection);
        if (!seen.ok) return;
        this.unsure = false;
        if (seen.value.found) {
          this.corrected = true;
          state.trace.push(`client correction asking ${draw.kind} found on record at cycle ${state.cycles}, ${at}`);
          return;
        }
      }
      target.standIns.askCorrection(draw.kind, taskId);
      const reply = await target.client.post(current.ashara.app, target.projectId, {
        kind: "change",
        body: CORRECTION_BODY,
      });
      if (!reply.ok) {
        this.unsure = true;
        state.trace.push(`client change ${during}: answered ${reply.status}`);
        return;
      }
      this.corrected = true;
      state.trace.push(`client correction asking ${draw.kind} posted at cycle ${state.cycles}, ${at}`);
    } catch (err) {
      /* eslint-disable-next-line ashara/catch-continue -- best effort: a post the server's process failed under is
         read back and sent again at a later turn, settlement or cycle; the cycle's own fault handling judges
         the fault */
      this.unsure = true;
      const thrown = err instanceof SimulatedCrash ? "SimulatedCrash" : err instanceof Error ? err.name : "error";
      state.trace.push(`client change ${during}: ${thrown}`);
      state.log.push(`client change ${during}: ${describeErrorChain(err)}`);
    }
  }
}

/** What the cycle loop runs over: the run's draws, watches, process, clients and state. */
export interface LoopParts {
  readonly options: RunOptions;
  /** When the run started, by the wall clock its timeout is measured on. */
  readonly started: number;
  readonly draws: RunDraws;
  readonly world: RunWorld;
  readonly state: RunState;
  readonly server: SimulatedProcess;
  readonly provisioned: Provisioned;
  readonly correction: ClientCorrection;
}

/** What one cycle's runs of the process produced. */
interface CycleRun {
  readonly statuses: string[];
  processed: number;
}

/**
 * The run's cycles, start to end: each runs the live instance (a lost wake skips one, a duplicated
 * one runs two back to back), restarts a process that died, judges the invariants after it, acts
 * as the client, and measures progress and settling. The loop ends at the run's cycle bound, its
 * wall clock, no progress for NO_PROGRESS_CYCLES fault-free cycles, or once every project's end has
 * settled.
 */
export class CycleLoop {
  /** I8's facts reached so far, each `<project index>:<fact>`. */
  private readonly reached = new Set<string>();
  private quiet = 0;
  private faultsSeen = 0;
  private restartsSeen = 0;
  /** Set when the run made no progress for NO_PROGRESS_CYCLES fault-free cycles. */
  noProgress = false;
  private changed = false;
  private returned = false;
  /** How far the client of a declined contract has answered it: not yet, confirmed it as written, restated it. */
  private declineAnswered: "none" | "confirmed" | "restated" = "none";
  private settleLeft: number | null = null;
  private settledOn = "";

  constructor(private readonly parts: LoopParts) {}

  private get projectId(): string {
    const [first] = this.parts.provisioned.projectIds;
    if (first === undefined) throw new NoProjectTendered();
    return first;
  }

  async run(): Promise<void> {
    const { options, state, draws, world, provisioned, server } = this.parts;
    const { observer, projectIds } = provisioned;
    while (state.cycles < options.maxCycles) {
      stopIfAborted(options, state);
      if (Date.now() - this.parts.started > options.timeoutMs) {
        state.replace({
          invariant: "I1",
          step: state.cycles,
          statement: `the seed ran past its ${options.timeoutMs} ms wall clock`,
          key: "I1:timeout",
        });
        break;
      }
      state.cycles += 1;
      if (draws.stopAt !== null && state.cycles === draws.stopAt) await this.clientStops();
      const waking = state.live;
      if (waking === null) throw new NoInstanceComposed(state.cycles);
      // A lost wake skips a cycle; a duplicated one runs two back to back.
      if (draws.tape.chance("wake.lost", FAULTS[options.profile].perSeamCall * 10)) {
        state.trace.push(`cycle ${state.cycles}: wake lost`);
        continue;
      }
      // A process a client request's fault killed or SIGTERMed starts no further cycle: its runner
      // ended with its shutdown signal, so the supervisor's restart comes first.
      await server.recover(waking);
      const current = state.live;
      if (current === null) throw new NoInstanceComposed(state.cycles);
      const repeats = draws.tape.chance("wake.duplicated", FAULTS[options.profile].perSeamCall * 10) ? 2 : 1;
      // I4's receipt clause: every message on record now is answered by the time this cycle ends.
      const owedReceipts = new Set((await unansweredMessages(observer, projectIds)).map((message) => message.id));
      const charges: ChargeSources = {
        db: observer,
        projectIds,
        scheduler: world.scheduler,
        tape: draws.tape,
        consulted: world.consulted,
      };
      const window = await openChargeWindow(charges);
      const ran: CycleRun = { statuses: [], processed: 0 };
      let crashed = false;
      for (let r = 0; r < repeats && !crashed; r++) {
        await this.runOnce(current, ran);
        crashed = current.handle.dead || current.handle.sigtermed;
      }
      stopIfAborted(options, state);
      // The runner's own wait between cycles (orchestrator runner.ts defaults), on the simulated clock.
      draws.clock.jump(ran.processed > 0 ? POLL_INTERVAL_MS : IDLE_INTERVAL_MS);
      await server.recover(current);
      const charged = await closeChargeWindow(window, state.cycles, charges);
      for (const violation of charged) state.report(violation);

      const snapshots = await this.judgeCycle(repeats, ran.statuses);
      await this.clientActs(snapshots[0]);
      if (await this.noProgressAfter(snapshots, repeats, owedReceipts)) break;
      if (this.settled(snapshots)) break;
    }
  }

  /**
   * The world between two settlements of a cycle's lanes, before the freed lane refills: a lane takes
   * the next task at once, so what the world does after a cycle it also does here, where it acts
   * while the loop works: the second project's rows corrupted as the run reaches them, and the
   * client's correction once its arrival is reached. Judging waits for the cycle's end.
   */
  async betweenSettlements(): Promise<void> {
    const { draws, state, provisioned, correction } = this.parts;
    const { observer, projectIds, standIns } = provisioned;
    const snapshots = await snapshotsOf(observer, projectIds);
    const corrupted = projectIds[1];
    const second = snapshots[1];
    if (draws.corruption !== null && corrupted !== undefined && second !== undefined) {
      await corruptRows(observer, corrupted, second, draws.corruption, state.trace);
    }
    await correction.afterSettlement(snapshots[0], standIns.observedReviews().length);
  }

  /** The first project's client asks the work to stop. */
  private async clientStops(): Promise<void> {
    const { server, provisioned, state } = this.parts;
    const { client } = provisioned;
    const projectId = this.projectId;
    await server.clientAct<null>(
      "stop",
      (app) => client.post(app, projectId, { kind: "stop", body: STOP_BODY }),
      (app) => onRecord(client, projectId, app, (message) => message.kind === "stop" && message.body === STOP_BODY),
    );
    state.trace.push(`client stop at cycle ${state.cycles}`);
  }

  /**
   * One run of the live instance's cycle. The runner's own path (orchestrator runner.ts run): once a
   * cycle stops the loop, the process runs only halted cycles until it restarts, and its onHalt
   * removes every cell.
   */
  private async runOnce(current: Live, ran: CycleRun): Promise<void> {
    const { state, world } = this.parts;
    const faultsBefore = world.scheduler.faults().length;
    try {
      if (state.haltedLive === current) await this.haltedCycle(current, faultsBefore);
      else await this.fullCycle(current, faultsBefore, ran);
    } catch (err) {
      /* eslint-disable-next-line ashara/catch-continue -- best effort: the simulator records a cycle's error in its
         trace and reports one no injected fault explains (unfaultedError) as a violation */
      const thrown = err instanceof SimulatedCrash ? "SimulatedCrash" : err instanceof Error ? err.name : "unknown";
      state.trace.push(`cycle ${state.cycles}: error ${thrown}`);
      if (!(err instanceof SimulatedCrash) && !current.handle.dead)
        state.log.push(`cycle error: ${describeErrorChain(err)}`);
      const unfaulted = unfaultedError("cycle", err, state.cycles, world.scheduler.faults().slice(faultsBefore));
      if (unfaulted !== null) state.report(unfaulted);
    }
  }

  private async haltedCycle(current: Live, faultsBefore: number): Promise<void> {
    const { state, world } = this.parts;
    state.cycleRunning = true;
    try {
      await current.ashara.cycles.runHaltedCycle();
    } finally {
      state.cycleRunning = false;
    }
    world.residue.cycleRan(this.unfaulted(current, faultsBefore));
    state.trace.push(`cycle ${state.cycles}: halted`);
  }

  /** One cycle of `current`, with the state marking a cycle running while it runs. */
  private async runningCycle(current: Live) {
    const { state } = this.parts;
    state.cycleRunning = true;
    try {
      return await current.ashara.cycles.runCycle();
    } finally {
      state.cycleRunning = false;
    }
  }

  private async fullCycle(current: Live, faultsBefore: number, ran: CycleRun): Promise<void> {
    const { state, world } = this.parts;
    const result = await this.runningCycle(current);
    world.residue.cycleRan(this.unfaulted(current, faultsBefore));
    state.dispatches += result.tasksProcessed;
    ran.processed += result.tasksProcessed;
    for (const task of result.results) ran.statuses.push(task.status);
    const stop = result.stop === null ? "" : ` stop: ${result.stop.reason.split(":")[0]}`;
    const statuses = result.results.map((t) => t.status).join(",");
    state.trace.push(`cycle ${state.cycles}: ${result.tasksProcessed} task(s) [${statuses}]${stop}`);
    if (result.stop !== null && !current.handle.dead) {
      state.outcome = { kind: "halted", cause: "spend_cap", detail: result.stop.reason };
      state.haltedLive = current;
      // In the boot trace, where the served process's runner removes the cells at a halt.
      await current.ashara.booted(() => current.ashara.teardownCells());
    }
  }

  /** Whether a run of the process ended with no fault injected, no crash and no SIGTERM. */
  private unfaulted(current: Live, faultsBefore: number): boolean {
    const faults = this.parts.world.scheduler.faults().length;
    return faults === faultsBefore && !current.handle.dead && !current.handle.sigtermed;
  }

  /** The invariants judged after a cycle, on every project's snapshot; the snapshots, the first project's first. */
  private async judgeCycle(repeats: number, statuses: readonly string[]): Promise<[Snapshot, ...Snapshot[]]> {
    const { state, world, draws, provisioned } = this.parts;
    const { observer, projectIds, startedCells, standIns } = provisioned;
    const snapshots = await snapshotsOf(observer, projectIds);
    const corrupted = projectIds[1];
    const second = snapshots[1];
    if (draws.corruption !== null && corrupted !== undefined && second !== undefined) {
      await corruptRows(observer, corrupted, second, draws.corruption, state.trace);
    }
    // A cycle that carried an injected fault, a duplicated wake or a restart does not count against a report's
    // bound, and names each of them.
    const faulted = [
      ...world.scheduler
        .faults()
        .slice(this.faultsSeen)
        .map((fault) => `fault ${fault.seam}:${fault.fault} at ${fault.label}`),
      ...(state.restarts > this.restartsSeen ? [`restart ${state.restarts} of the server`] : []),
      ...(repeats > 1 ? [`a duplicated wake at cycle ${state.cycles}`] : []),
    ];
    const cycle: SilenceCycle = faulted.length === 0 ? { kind: "counted" } : { kind: "exempt", faulted };
    for (const [index, each] of snapshots.entries()) {
      const judged = checkSnapshot(state.cycles, each, {
        spendCapUsd: draws.capUsd,
        cells: startedCells,
        final: false,
        reviews: standIns.observedReviews(),
        intakes: standIns.observedIntakes(),
      });
      for (const violation of judged) state.report(ofProject(index, violation));
      for (const violation of world.silence.observe(state.cycles, index, each, cycle))
        state.report(ofProject(index, violation));
      sample(state.coverage, each, world.scheduler.faults(), executionEvidence(each, statuses));
      world.residue.observe(each);
    }
    const overCommitted = await world.admissions.judge(observer, draws.capUsd, state.cycles);
    if (overCommitted !== null) state.report(overCommitted);
    for (const { project, violation } of await world.termination.observe(state.cycles, observer, projectIds)) {
      state.report(ofProject(project, violation));
    }
    state.trace.push(snapshots.map(stateLine).join(" || "));
    return snapshots;
  }

  /**
   * The first project's client after a cycle: its answer to a declined contract, its late change, its
   * correction, a held task returned.
   */
  private async clientActs(snapshot: Snapshot): Promise<void> {
    const { draws, state, provisioned, correction } = this.parts;
    const { observer, standIns } = provisioned;
    if (draws.universe.unverifiable && this.declineAnswered !== "restated") await this.answerDecline();
    if (
      draws.lateChange &&
      !this.changed &&
      snapshot.items.some((i) => i.origin === "decomposition" && i.status === "Completed")
    ) {
      await this.lateChange();
    }
    const draw = draws.correctionDraw;
    if (
      draw !== null &&
      !correction.corrected &&
      correctionArrives(draw.arrival, snapshot, standIns.observedReviews().length)
    ) {
      await this.correct(draw);
    }
    if (draws.heldReturns && !this.returned)
      this.returned = await returnHeldTask(observer, this.projectId, snapshot, state.trace);
  }

  /**
   * The client of the seed's unverifiable tender, once its contract is declined: first it confirms the
   * contract as written, which must leave it declined with no work started (I6's declined-work
   * clause judges every cycle), and once that confirmation is read it restates the guarantees so Ashara
   * can verify them, which releases the work.
   */
  private async answerDecline(): Promise<void> {
    const { server, provisioned, state } = this.parts;
    const { client, standIns, observer } = provisioned;
    const projectId = this.projectId;
    const read = await observer.execute(sql`
      SELECT EXISTS (SELECT 1 FROM client_messages WHERE project_id = ${projectId}
               AND reports_on = 'contract-draft') AS drafted,
             EXISTS (SELECT 1 FROM client_messages WHERE project_id = ${projectId} AND direction = 'inbound'
               AND kind = 'change' AND body = ${CONFIRM_AS_WRITTEN_BODY}
               AND consumed_at IS NOT NULL) AS "confirmRead"`);
    const [standing] = z.array(z.object({ drafted: z.boolean(), confirmRead: z.boolean() })).parse(read.rows);
    if (standing === undefined || !standing.drafted) return;
    if (this.declineAnswered === "none") {
      standIns.askCorrection("confirm-as-written", null);
      await server.clientAct<null>(
        "change",
        (app) => client.post(app, projectId, { kind: "change", body: CONFIRM_AS_WRITTEN_BODY }),
        (app) => onRecord(client, projectId, app, (message) => isChange(message, CONFIRM_AS_WRITTEN_BODY)),
      );
      this.declineAnswered = "confirmed";
      state.trace.push(`client confirms the declined contract as written at cycle ${state.cycles}`);
      return;
    }
    if (!standing.confirmRead) return;
    standIns.askCorrection("restate-unverifiable", null);
    await server.clientAct<null>(
      "change",
      (app) => client.post(app, projectId, { kind: "change", body: RESTATE_BODY }),
      (app) => onRecord(client, projectId, app, (message) => isChange(message, RESTATE_BODY)),
    );
    this.declineAnswered = "restated";
    state.trace.push(`client restates the declined contract at cycle ${state.cycles}`);
  }

  /** The client answers the first question it was asked with a change to an assumption. */
  private async lateChange(): Promise<void> {
    const { server, provisioned, state } = this.parts;
    const { client } = provisioned;
    const projectId = this.projectId;
    const question = await server.clientAct<string | null>(
      "reading its messages",
      async (app) => {
        const listed = await client.messages(app, projectId);
        return listed.ok ? { ok: true, value: firstQuestion(listed.value) } : listed;
      },
      null,
    );
    if (question === null) return;
    await server.clientAct<null>(
      "answer",
      (app) => client.post(app, projectId, { kind: "answer", body: CHANGE_BODY, inReplyTo: question }),
      (app) =>
        onRecord(client, projectId, app, (message) => message.kind === "answer" && message.inReplyTo === question),
    );
    this.changed = true;
    state.trace.push(`client answer changes an assumption at cycle ${state.cycles}`);
  }

  /**
   * The client's correction, posted after the cycle its arrival is drawn for; one whose post inside
   * the cycle may have landed is read back first.
   */
  private async correct(draw: CorrectionDraw): Promise<void> {
    const { server, provisioned, state, correction } = this.parts;
    const { client, standIns } = provisioned;
    const projectId = this.projectId;
    if (correction.unsure) {
      const landed = await server.clientAct<boolean>(
        "reading its messages",
        async (app) => {
          const seen = await onRecord(client, projectId, app, isCorrection);
          return seen.ok ? { ok: true, value: seen.value.found } : seen;
        },
        null,
      );
      correction.unsure = false;
      if (landed) {
        correction.corrected = true;
        state.trace.push(`client correction asking ${draw.kind} found on record at cycle ${state.cycles}`);
        return;
      }
    }
    standIns.askCorrection(draw.kind, null);
    await server.clientAct<null>(
      "change",
      (app) => client.post(app, projectId, { kind: "change", body: CORRECTION_BODY }),
      (app) => onRecord(client, projectId, app, isCorrection),
    );
    correction.corrected = true;
    state.trace.push(`client correction asking ${draw.kind} posted at cycle ${state.cycles}, arrival ${draw.arrival}`);
  }

  /**
   * I8's measure: a fact of any project reached for the first time. A cycle that carried an
   * injected fault, a duplicated wake or a restart neither progresses nor counts against it.
   * True once the run has made no progress for NO_PROGRESS_CYCLES fault-free cycles.
   */
  private async noProgressAfter(
    snapshots: readonly Snapshot[],
    repeats: number,
    owedReceipts: ReadonlySet<string>,
  ): Promise<boolean> {
    const { state, world, provisioned } = this.parts;
    const { observer, projectIds } = provisioned;
    let fresh = 0;
    for (const [index, each] of snapshots.entries()) {
      for (const fact of progressFacts(each)) {
        if (this.reached.has(`${index}:${fact}`)) continue;
        this.reached.add(`${index}:${fact}`);
        fresh += 1;
      }
    }
    const faults = world.scheduler.faults().length;
    const faulted = faults > this.faultsSeen || state.restarts > this.restartsSeen || repeats > 1;
    this.faultsSeen = faults;
    this.restartsSeen = state.restarts;
    if (!faulted) {
      const unanswered = await unansweredMessages(observer, projectIds);
      for (const { project, violation } of lateReceipts(owedReceipts, unanswered, projectIds, state.cycles)) {
        state.report(ofProject(project, violation));
      }
    }
    if (fresh > 0) this.quiet = 0;
    else if (!faulted) this.quiet += 1;
    state.longestQuiet = Math.max(state.longestQuiet, this.quiet);
    if (this.quiet < NO_PROGRESS_CYCLES) return false;
    this.noProgress = true;
    return true;
  }

  /**
   * An ended project runs a few more cycles: what it owes the client (a report) is sent on them.
   * A late client change can reopen an accepted project, and a halt can end and begin again (a
   * new episode): then it is not settling. Every project of the run ends before the run does.
   * True once the settle cycles have run out.
   */
  private settled(snapshots: readonly [Snapshot, ...Snapshot[]]): boolean {
    const state = this.parts.state;
    const spendHalt = state.outcome.kind === "halted" && state.outcome.cause === "spend_cap";
    const ends = snapshots.map(outcomeOf);
    const stand = snapshots.map(standing).join(" ");
    if (
      this.settleLeft !== null &&
      !spendHalt &&
      (ends.some((end) => end.kind === "open") || stand !== this.settledOn)
    ) {
      this.settleLeft = null;
    }
    if (this.settleLeft !== null) {
      this.settleLeft -= 1;
      return this.settleLeft <= 0;
    }
    if (!spendHalt) state.outcome = outcomeOf(snapshots[0]);
    if (spendHalt || ends.every((end) => end.kind !== "open")) {
      this.settleLeft = SETTLE_CYCLES;
      this.settledOn = stand;
    }
    return false;
  }
}

/** One cycle's trace line of a project: each task's status, then the project's. */
function stateLine(snapshot: Snapshot): string {
  const tasks = snapshot.items
    .filter((i) => i.level === "Task")
    .map((i) => `${i.title.slice(0, 40)}=${i.status}`)
    .join("; ");
  return `state ${tasks} | project=${snapshot.project.status}`;
}
