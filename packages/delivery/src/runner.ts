import { listenForEvents } from "@ashara/db";
import type { PgListener } from "@ashara/db";
import type { CycleResult, LoopStop } from "./types.js";

/** What the runner drives — CoreLoop satisfies it; tests supply a double. */
export interface CycleRunner {
  runCycle(): Promise<CycleResult>;
  /**
   * What still runs once a cycle has stopped the loop, each with no LLM call: the client's stops,
   * each recorded and answered, so a stop sent while the loop is halted holds, and the block, delivered
   * and plan reports still due, so a report written or faulted in the stopping cycle is still posted.
   */
  runHaltedCycle(): Promise<void>;
}

interface RunnerConfig {
  readonly pollIntervalMs: number;
  readonly idleIntervalMs: number;
  readonly maxConsecutiveErrors: number;
  /** The database the runner LISTENs on for wake-ups; `null` is poll only, a choice the caller states. */
  readonly databaseUrl: string | null;
}

const DEFAULT_RUNNER_CONFIG: Omit<RunnerConfig, "databaseUrl"> = {
  pollIntervalMs: 10_000,
  idleIntervalMs: 30_000,
  maxConsecutiveErrors: 3,
};

export class ContinuousRunner {
  private readonly coreLoop: CycleRunner;
  private readonly config: RunnerConfig;
  private wakeResolve: (() => void) | null = null;
  // Set by wake() on any NOTIFY, armed to false at the top of each cycle. A NOTIFY
  // that lands while a cycle is running has no wait to resolve; without this flag
  // the work it announced would sit until the idle timeout.
  private wakePending = false;

  constructor(coreLoop: CycleRunner, config: Pick<RunnerConfig, "databaseUrl"> & Partial<RunnerConfig>) {
    this.coreLoop = coreLoop;
    this.config = { ...DEFAULT_RUNNER_CONFIG, ...config };
  }

  /**
   * Cycles until `signal` aborts. A cycle that reports a stop halts the loop for good: `onHalt` runs
   * once with it, and from then on only halted cycles run (CycleRunner.runHaltedCycle), each wake or
   * idle interval, until `signal` aborts, so a stop sent while the loop is halted is answered.
   * Resolves, once `signal` aborted, to the stop that halted the loop, or `null` when
   * none did.
   */
  async run(signal: AbortSignal, onHalt: (stop: LoopStop) => Promise<void>): Promise<LoopStop | null> {
    console.log("Continuous runner starting");

    let pgListener: PgListener | null = null;
    if (this.config.databaseUrl !== null) {
      pgListener = await listenForEvents(this.config.databaseUrl, () => {
        this.wake();
      });
      const pid = pgListener.backendPid();
      console.log(
        pid === null
          ? "PG listener not connected; reconnecting in the background, polling meanwhile"
          : `PG listener connected (backend pid ${pid})`,
      );
    }

    let stop: LoopStop | null = null;
    try {
      stop = await this.cycleUntilStop(signal);
      if (stop !== null) {
        console.error(
          `Continuous runner halted: ${stop.reason}. Until the process restarts, only the client's stops are taken in and answered.`,
        );
        await onHalt(stop);
        await this.answerStopsUntilAborted(signal);
      }
    } finally {
      if (pgListener) {
        await pgListener.stop();
      }
    }

    console.log("Continuous runner stopped");
    return stop;
  }

  /** Full cycles until `signal` aborts (null) or a cycle reports a stop (that stop). */
  private async cycleUntilStop(mergedSignal: AbortSignal): Promise<LoopStop | null> {
    let consecutiveErrors = 0;
    while (!mergedSignal.aborted) {
      // Arm the wake guard BEFORE running the cycle: any NOTIFY from here on sets
      // wakePending, so the idle wait below cannot sleep through it.
      this.wakePending = false;

      try {
        const result: CycleResult = await this.coreLoop.runCycle();
        consecutiveErrors = 0;
        console.log(`Cycle complete: ${result.tasksProcessed} tasks processed`);

        if (result.stop) return result.stop;

        // A NOTIFY during the cycle skips the wait: the work it announced is picked
        // up by the very next cycle. Only this normal wait honors it — the backoff
        // wait below must not, or a throwing cycle that published an event would
        // re-run with no backoff.
        if (this.wakePending) {
          console.log("Wake received during the cycle; re-cycling without waiting");
          continue;
        }

        const waitMs = result.tasksProcessed === 0
          ? this.config.idleIntervalMs
          : this.config.pollIntervalMs;

        await this.waitForWakeOrTimeout(waitMs, mergedSignal);
      } catch (e) {
        // eslint-disable-next-line ashara/catch-continue -- best effort: the supervisor loop: a failed cycle is counted in consecutiveErrors, backs off, and the next cycle re-reads every item from the store
        consecutiveErrors += 1;
        console.error(`Cycle error (consecutive: ${consecutiveErrors}):`, e);
        await this.backOff(consecutiveErrors, mergedSignal);
      }
    }
    return null;
  }

  /** Once halted: the client's stops each wake or idle interval, until `signal` aborts. */
  private async answerStopsUntilAborted(signal: AbortSignal): Promise<void> {
    let consecutiveErrors = 0;
    while (!signal.aborted) {
      this.wakePending = false;
      try {
        await this.coreLoop.runHaltedCycle();
        consecutiveErrors = 0;
        if (this.wakePending) continue;
        await this.waitForWakeOrTimeout(this.config.idleIntervalMs, signal);
      } catch (e) {
        // eslint-disable-next-line ashara/catch-continue -- best effort: the supervisor loop: a failed halted cycle is counted in consecutiveErrors, backs off, and the next one re-reads the client's stops
        consecutiveErrors += 1;
        console.error(`Halted cycle error (consecutive: ${consecutiveErrors}): the client's stops are not taken in this time:`, e);
        await this.backOff(consecutiveErrors, signal);
      }
    }
  }

  /** At the bound of consecutive errors, waits 2^n s (n capped at 6) before the next try. */
  private async backOff(consecutiveErrors: number, signal: AbortSignal): Promise<void> {
    if (consecutiveErrors < this.config.maxConsecutiveErrors) return;
    const exponent = Math.min(consecutiveErrors, 6);
    const backoffMs = Math.pow(2, exponent) * 1000;
    console.warn(`Backing off for ${backoffMs / 1000}s after ${consecutiveErrors} consecutive errors`);
    await this.waitForWakeOrTimeout(backoffMs, signal);
  }

  wake(): void {
    this.wakePending = true;
    if (this.wakeResolve) {
      this.wakeResolve();
      this.wakeResolve = null;
    }
  }

  private waitForWakeOrTimeout(timeoutMs: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }

      const timer = setTimeout(() => {
        this.wakeResolve = null;
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, timeoutMs);

      this.wakeResolve = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve();
      };

      const onAbort = () => {
        clearTimeout(timer);
        this.wakeResolve = null;
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
