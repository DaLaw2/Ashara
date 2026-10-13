import { listenForEvents } from "@ashara/db";
import type { PgListener } from "@ashara/db";
import type { CycleResult } from "./types.js";

/** The one method the runner drives — CoreLoop satisfies it; tests supply a double. */
export interface CycleRunner {
  runCycle(): Promise<CycleResult>;
}

export interface RunnerConfig {
  readonly pollIntervalMs: number;
  readonly idleIntervalMs: number;
  readonly maxConsecutiveErrors: number;
  readonly databaseUrl: string;
}

export const DEFAULT_RUNNER_CONFIG: RunnerConfig = {
  pollIntervalMs: 10_000,
  idleIntervalMs: 30_000,
  maxConsecutiveErrors: 3,
  databaseUrl: "",
};

export class ContinuousRunner {
  private readonly coreLoop: CycleRunner;
  private readonly config: RunnerConfig;
  private abortController: AbortController | null = null;
  private wakeResolve: (() => void) | null = null;
  // Set by wake() on any NOTIFY, armed to false at the top of each cycle. A NOTIFY
  // that lands while a cycle is running has no wait to resolve; without this flag
  // the work it announced would sit until the idle timeout.
  private wakePending = false;

  constructor(coreLoop: CycleRunner, config: Partial<RunnerConfig> = {}) {
    this.coreLoop = coreLoop;
    this.config = { ...DEFAULT_RUNNER_CONFIG, ...config };
  }

  async run(signal?: AbortSignal): Promise<void> {
    console.log("Continuous runner starting");

    this.abortController = new AbortController();
    const mergedSignal = signal ?? this.abortController.signal;

    let pgListener: PgListener | null = null;
    if (this.config.databaseUrl) {
      pgListener = await listenForEvents(this.config.databaseUrl, () => {
        this.wake();
      });
      console.log("PG listener connected");
    }

    let consecutiveErrors = 0;

    try {
      while (!mergedSignal.aborted) {
        // Arm the wake guard BEFORE running the cycle: any NOTIFY from here on sets
        // wakePending, so the idle wait below cannot sleep through it.
        this.wakePending = false;

        try {
          const result: CycleResult = await this.coreLoop.runCycle();
          consecutiveErrors = 0;
          console.log(`Cycle complete: ${result.tasksProcessed} tasks processed`);

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
          consecutiveErrors += 1;
          console.error(`Cycle error (consecutive: ${consecutiveErrors}):`, e);

          if (consecutiveErrors >= this.config.maxConsecutiveErrors) {
            const exponent = Math.min(consecutiveErrors, 6);
            const backoffMs = Math.pow(2, exponent) * 1000;
            console.warn(`Backing off for ${backoffMs / 1000}s after ${consecutiveErrors} consecutive errors`);
            await this.waitForWakeOrTimeout(backoffMs, mergedSignal);
          }
        }
      }
    } finally {
      if (pgListener) {
        pgListener.stop();
      }
    }

    console.log("Continuous runner stopped");
  }

  wake(): void {
    this.wakePending = true;
    if (this.wakeResolve) {
      this.wakeResolve();
      this.wakeResolve = null;
    }
  }

  stop(): void {
    this.abortController?.abort();
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
