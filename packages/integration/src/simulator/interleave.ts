import { AsyncLocalStorage } from "node:async_hooks";
import type { AsharaPorts } from "@ashara/server/compose";
import type { ContendedWaitKind, ContendedWaitObserver } from "@ashara/shared";
import type { Tape } from "./tape.js";

type TaskLanes = AsharaPorts["taskLanes"];

/** How likely a seam call of the running task hands the turn to another task waiting for it. */
const SWITCH_RATE = 0.3;
/** Real time with no scheduling step while a task waits for its turn: past it, the batch is stalled. */
const STALL_MS = 20_000;
const WATCH_INTERVAL_MS = 1_000;

/**
 * - ready: waiting for its turn at a seam call (or before its first code);
 * - running: holds the turn, or was released by a stall;
 * - blocked: waiting on another task (a contended wait), not on the scheduler;
 * - ended: its task settled.
 */
type LaneState = "ready" | "running" | "blocked" | "ended";

/** One task of the pool in flight, as the scheduler knows it. */
interface Lane {
  readonly index: number;
  readonly taskId: string;
  state: LaneState;
  /** What wakes each of its waits for the turn (a task's own concurrent branches each wait). */
  grants: Array<() => void>;
  /** Pool connections it holds: a transaction may hold row locks the other task would wait on. */
  connections: number;
}

export type InterleaveEvent =
  | { readonly kind: "batch"; readonly size: number }
  | { readonly kind: "switch"; readonly from: number; readonly to: number; readonly at: string }
  | { readonly kind: "contended"; readonly wait: ContendedWaitKind; readonly lane: number }
  | { readonly kind: "bypassed"; readonly wait: ContendedWaitKind }
  | { readonly kind: "lane-ended"; readonly taskId: string }
  | { readonly kind: "stall"; readonly detail: string };

/** A pool began while another was still running: the loop awaits each cycle's lanes, so the driver is wrong. */
class PoolsOverlapped extends Error {
  constructor(readonly running: readonly string[]) {
    super(`a pool of lanes began while the lanes of ${running.join(", ")} were still running`);
    this.name = "PoolsOverlapped";
  }
}

/** A lane that ended with no settlement recorded: a defect of the scheduler itself. */
class LaneNeverSettled extends Error {
  constructor(readonly taskId: string) {
    super(`the lane of task ${taskId} ended without a settlement`);
    this.name = "LaneNeverSettled";
  }
}

function newLane(index: number, taskId: string): Lane {
  return { index, taskId, state: "ready", grants: [], connections: 0 };
}

/** How `run` on `item` settled: its value, or what it threw. */
async function settledRun<I, T>(run: (item: I) => Promise<T>, item: I): Promise<PromiseSettledResult<T>> {
  try {
    return { status: "fulfilled", value: await run(item) };
  } catch (reason) {
    return { status: "rejected", reason };
  }
}

function nextMacrotask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Runs a pool's tasks one at a time, so two admissions race the spend cap: exactly one task holds the turn, and it
 * gives the turn up only at a seam call (drawn from the tape, keyed `interleave:<seam>:<label>`
 * like a fault), when it ends, or when it must wait on another task (a contended wait: the
 * checkout lock, the spend cap's admission queue). Every other task is parked at a seam call or
 * blocked on that wait, so what runs next, and what a seam call returns, is a function of the
 * seed: a seed replays the same interleaving. The same holds for what is read outside the seams
 * (the simulated clock, the seeded ids, the stand-ins' draws): only the task holding the turn runs.
 * A turn is also offered after a call ran, before its caller sees the result (Scheduler.returned),
 * and never while the running task holds a pool connection (a transaction's row locks).
 *
 * A lane whose task settled lets the world act (betweenSettlements), then asks the pool's `next` for
 * the following task, while it still holds the turn, outside any task (no seam call in either hands
 * the turn on, and none is the ended task's), and only then gives the turn up: when the world acts,
 * when a lane refills, and with what, are a function of the seed too.
 *
 * Not modelled: a task waiting on another through an in-process wait production does not pass
 * through `contendedWait`. That stalls the pool, and the watchdog names it (I1:interleave-stall)
 * and releases every task, so the run ends instead of hanging.
 */
export class Interleaver {
  private readonly current = new AsyncLocalStorage<Lane>();
  private lanesNow: Lane[] = [];
  private holder: Lane | null = null;
  private stalled = false;
  private progress = 0;
  private quietSince = 0;
  private lastProgress = -1;

  constructor(
    private readonly tape: Tape,
    /** Waits a mutation skips: the lane goes on as if the other task had let it (simulator-plants.test.ts). */
    private readonly bypass: ReadonlySet<ContendedWaitKind>,
    private readonly observe: (event: InterleaveEvent) => void,
  ) {}

  /** What the world does after each settlement of a pool's lanes, before the freed lane refills. */
  private settled: () => Promise<void> = () => Promise.resolve();

  /** Sets what the world does after each settlement; the cycle loop acts as the client there (run-cycle-loop.ts). */
  betweenSettlements(world: () => Promise<void>): void {
    this.settled = world;
  }

  /** The task of the lane running this code, or null outside a pool's tasks. */
  currentTask(): string | null {
    return this.current.getStore()?.taskId ?? null;
  }

  readonly lanes: TaskLanes = async <I extends { readonly id: string }, T>(
    count: number,
    next: () => Promise<I | null>,
    run: (item: I) => Promise<T>,
  ) => {
    if (this.lanesNow.length > 0) throw new PoolsOverlapped(this.lanesNow.map((lane) => lane.taskId));
    this.holder = null;
    this.stalled = false;
    this.lastProgress = -1;
    const settlements: Array<{ readonly item: I; settled: PromiseSettledResult<T> | null }> = [];
    const asking: { failure: { readonly error: unknown } | null } = { failure: null };
    let inFlight = 0;
    let alive = 0;
    let observedTwo = false;
    let drained: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      drained = resolve;
    });

    // Asked outside any lane: the gate's calls are no task's, and none of them hands the turn on.
    const askNow = async (): Promise<I | null> => {
      if (asking.failure !== null) return null;
      try {
        return await this.current.exit(next);
      } catch (error) {
        asking.failure = { error };
        return null;
      }
    };
    // One question at a time even once a stall released every lane at once.
    let asked: Promise<unknown> = Promise.resolve();
    const ask = (): Promise<I | null> => {
      const answer = asked.then(askNow);
      asked = answer;
      return answer;
    };
    // The world's turn after a settlement, outside any lane and in line with the questions, so what
    // it does is read by the next question; a world that throws ends the asking as `next` does.
    const settleNow = async (): Promise<void> => {
      if (asking.failure !== null) return;
      try {
        await this.current.exit(this.settled);
      } catch (error) {
        asking.failure = { error };
        return;
      }
    };
    const settle = (): Promise<void> => {
      const turn = asked.then(settleNow);
      asked = turn;
      return turn;
    };
    const start = (item: I): void => {
      const lane = newLane(this.lanesNow.length, item.id);
      this.lanesNow.push(lane);
      const entry: { readonly item: I; settled: PromiseSettledResult<T> | null } = { item, settled: null };
      settlements.push(entry);
      inFlight += 1;
      alive += 1;
      if (inFlight >= 2 && !observedTwo) {
        observedTwo = true;
        this.observe({ kind: "batch", size: inFlight });
      }
      void this.current.run(lane, async () => {
        await this.acquire(lane);
        entry.settled = await settledRun(run, item);
        inFlight -= 1;
        // Still holding the turn: the world's turn and the refill happen before any other lane runs.
        try {
          await settle();
          await refill();
        } finally {
          this.end(lane);
          alive -= 1;
          if (alive === 0) drained();
        }
      });
    };
    const refill = async (): Promise<void> => {
      while (inFlight < count) {
        const item = await ask();
        if (item === null) return;
        start(item);
      }
    };

    const watchdog = setInterval(() => this.watch(), WATCH_INTERVAL_MS);
    watchdog.unref();
    try {
      // The first lanes are all asked for before any starts, so each of them starts waiting for the turn at once.
      const first: I[] = [];
      while (first.length < count) {
        const item = await ask();
        if (item === null) break;
        first.push(item);
      }
      for (const item of first) start(item);
      if (alive > 0) await done;
    } finally {
      clearInterval(watchdog);
      this.lanesNow = [];
      this.holder = null;
    }
    if (asking.failure !== null) throw asking.failure.error;
    return settlements.map((entry) => {
      if (entry.settled === null) throw new LaneNeverSettled(entry.item.id);
      return { item: entry.item, settled: entry.settled };
    });
  };

  /** Before every seam call (Scheduler.enter): the running task may hand the turn on here. */
  async turn(site: string): Promise<void> {
    const lane = this.laneOfBatch();
    if (lane === null) return;
    if (this.holder !== lane) await this.acquire(lane);
    if (this.stalled) return;
    this.progress += 1;
    // A task released from a contended wait asks for its turn within microtasks: let it, so the
    // set of tasks waiting for the turn does not depend on how far this one got meanwhile.
    if (this.lanesNow.some((other) => other.state === "blocked")) await nextMacrotask();
    if (lane.connections > 0) return;
    const ready = this.lanesNow.filter((other) => other !== lane && other.state === "ready");
    if (ready.length === 0) return;
    if (!this.tape.chance(`interleave:${site}`, SWITCH_RATE)) return;
    const next = this.pick(ready, `interleave.next:${site}`);
    if (next === null) return;
    this.observe({ kind: "switch", from: lane.index, to: next.index, at: site });
    lane.state = "ready";
    const turn = this.waitForTurn(lane);
    this.give(next);
    await turn;
  }

  /** A pool connection the running task checked out; the returned function gives it back. */
  connectionHeld(): () => void {
    const lane = this.laneOfBatch();
    if (lane === null) return () => {};
    lane.connections += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      lane.connections -= 1;
    };
  }

  /** Installed with observeContendedWaits for the run. */
  readonly contended: ContendedWaitObserver = async (kind, waiting) => {
    if (this.bypass.has(kind)) {
      this.observe({ kind: "bypassed", wait: kind });
      // The skipped wait still settles later; its rejection has no reader now but the log.
      waiting.catch((err: unknown) =>
        console.warn(
          `[simulator] a bypassed ${kind} wait rejected: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      return undefined;
    }
    const lane = this.laneOfBatch();
    if (lane === null || this.stalled) return waiting;
    let settled = false;
    // Only whether it settled is read here; its outcome, a rejection included, reaches the caller through `waiting`.
    void Promise.allSettled([waiting]).then(() => {
      settled = true;
    });
    // An uncontended wait settles within microtasks: then no other task is involved.
    await nextMacrotask();
    if (settled) return waiting;
    this.observe({ kind: "contended", wait: kind, lane: lane.index });
    lane.state = "blocked";
    if (this.holder === lane) {
      this.holder = null;
      this.passOn(`wait:${kind}`);
    }
    try {
      return await waiting;
    } finally {
      await this.acquire(lane);
    }
  };

  private laneOfBatch(): Lane | null {
    const lane = this.current.getStore();
    return lane !== undefined && this.lanesNow.includes(lane) ? lane : null;
  }

  private waitForTurn(lane: Lane): Promise<void> {
    return new Promise<void>((resolve) => {
      lane.grants.push(resolve);
    });
  }

  private async acquire(lane: Lane): Promise<void> {
    this.progress += 1;
    if (this.stalled || this.holder === lane) {
      lane.state = "running";
      return;
    }
    if (this.holder === null) {
      this.holder = lane;
      lane.state = "running";
      return;
    }
    lane.state = "ready";
    await this.waitForTurn(lane);
  }

  private give(to: Lane): void {
    this.progress += 1;
    this.holder = to;
    to.state = "running";
    const grants = to.grants;
    to.grants = [];
    for (const grant of grants) grant();
  }

  /** One of the tasks waiting for the turn: the tape draws only when there is a choice. */
  private pick(ready: readonly Lane[], site: string): Lane | null {
    if (ready.length <= 1) return ready[0] ?? null;
    return ready[this.tape.pick(site, ready.length)] ?? null;
  }

  private passOn(site: string): void {
    if (this.stalled) return;
    const next = this.pick(
      this.lanesNow.filter((lane) => lane.state === "ready"),
      `interleave.next:${site}`,
    );
    if (next === null) {
      this.holder = null;
      return;
    }
    this.give(next);
  }

  private end(lane: Lane): void {
    this.progress += 1;
    lane.state = "ended";
    this.observe({ kind: "lane-ended", taskId: lane.taskId });
    if (this.holder === lane) {
      this.holder = null;
      this.passOn("end");
    }
  }

  private watch(): void {
    if (this.stalled || this.lanesNow.filter((lane) => lane.state !== "ended").length < 2) return;
    if (this.progress !== this.lastProgress) {
      this.lastProgress = this.progress;
      this.quietSince = Date.now();
      return;
    }
    if (Date.now() - this.quietSince < STALL_MS) return;
    const waiting = this.lanesNow.filter((lane) => lane.state === "ready");
    if (waiting.length === 0) return;
    this.stalled = true;
    const states = this.lanesNow
      .map((lane) => `task ${lane.index} ${lane.state}${lane === this.holder ? " (holds the turn)" : ""}`)
      .join(", ");
    this.observe({
      kind: "stall",
      detail: `no scheduling step for ${STALL_MS} ms while a task waited for its turn: ${states}`,
    });
    this.holder = null;
    for (const lane of this.lanesNow) {
      if (lane.state === "ready") this.give(lane);
    }
    this.holder = null;
  }
}
