import pg from "pg";

import { listenForEvents } from "@ashara/db";

import type { CycleResult } from "./types.js";
import { emitRunSummary } from "./run-summary.js";
import type { EventLogger } from "./event-logger.js";

/** The one method the runner drives — CoreLoop satisfies it; tests supply a double. */
export interface CycleRunner {
  runCycle(): Promise<CycleResult>;
}

export interface RunnerConfig {
  readonly pollIntervalMs: number;
  readonly idleIntervalMs: number;
  readonly maxConsecutiveErrors: number;
  readonly databaseUrl: string;
  /**
   * Whether a `stop` termination verdict actually stops the runner (mig-phase-7,
   * ADR-029 rollback clause). DEFAULT ON. When OFF the runner logs, LOUDLY, what it
   * WOULD have decided each idle cycle and keeps the legacy infinite idle — the escape
   * hatch if a false-positive termination is ever observed in production.
   */
  readonly terminationEnabled: boolean;
}

export const DEFAULT_RUNNER_CONFIG: RunnerConfig = {
  pollIntervalMs: 10_000,
  idleIntervalMs: 30_000,
  maxConsecutiveErrors: 3,
  databaseUrl: "",
  terminationEnabled: true,
};

export class ContinuousRunner {
  private readonly coreLoop: CycleRunner;
  private readonly config: RunnerConfig;
  private readonly eventLogger: EventLogger | null;
  private abortController: AbortController | null = null;
  private pgClient: pg.Client | null = null;
  private wakeResolve: (() => void) | null = null;
  // Set by wake() on any NOTIFY, armed to false at the top of each cycle. Guards the
  // wake-on-NOTIFY race: external work committed after the termination snapshot but
  // before the runner acts on a stop must not be lost (see run()).
  private wakePending = false;

  constructor(coreLoop: CycleRunner, config: Partial<RunnerConfig> = {}, eventLogger?: EventLogger) {
    this.coreLoop = coreLoop;
    this.config = { ...DEFAULT_RUNNER_CONFIG, ...config };
    this.eventLogger = eventLogger ?? null;
  }

  async run(signal?: AbortSignal): Promise<void> {
    console.log("Continuous runner starting");

    this.abortController = new AbortController();
    const mergedSignal = signal ?? this.abortController.signal;

    let pgClient: pg.Client | null = null;
    if (this.config.databaseUrl) {
      try {
        pgClient = await listenForEvents(this.config.databaseUrl, () => {
          this.wake();
        });
        this.pgClient = pgClient;
        console.log("PG listener connected");
      } catch (e) {
        console.warn("Initial PG listener connection failed, running in polling-only mode:", e);
      }
    }

    let consecutiveErrors = 0;

    while (!mergedSignal.aborted) {
      // Arm the wake guard BEFORE running the cycle: any NOTIFY from here until we act
      // on the verdict sets wakePending, so a stop cannot swallow work that arrived
      // after this cycle's snapshot was taken.
      this.wakePending = false;

      try {
        const result: CycleResult = await this.coreLoop.runCycle();
        consecutiveErrors = 0;
        console.log(`Cycle complete: ${result.tasksProcessed} tasks processed`);

        const action = this.handleTermination(result);
        if (action === "stop") break;
        // A stop verdict superseded by an in-cycle wake: re-cycle immediately (skip the
        // idle wait) so the newly-arrived work is observed on the very next snapshot.
        if (action === "recycle") continue;

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

    if (pgClient) {
      try {
        await pgClient.end();
      } catch {
        // ignore
      }
    }
    this.pgClient = null;

    console.log("Continuous runner stopped");
  }

  /**
   * Acts on this cycle's termination verdict:
   *  - `stop`     — the runner should exit its loop cleanly (summary emitted here).
   *  - `recycle`  — a stop was superseded by an in-cycle wake; re-cycle immediately.
   *  - `continue` — no stop (or the flag is off); take the normal idle/poll wait.
   *
   * There is no `await` between the wakePending check and the return, so — under Node's
   * run-to-completion — no NOTIFY callback can interleave in that window: a wake either
   * landed before the check (→ recycle, not stop) or fires after the runner has already
   * committed to stopping (out of this run's scope).
   */
  private handleTermination(result: CycleResult): "stop" | "recycle" | "continue" {
    const outcome = result.termination;
    if (!outcome || outcome.decision.decision !== "stop") return "continue";

    const { reason, counts } = outcome.decision;

    if (!this.config.terminationEnabled) {
      // Rollback clause: legacy infinite idle. Announce, loudly and every cycle, the
      // stop that WOULD have happened so a false positive is visible without acting.
      console.warn(
        `[termination DISABLED] Runner WOULD have stopped this cycle (reason=${reason}, ` +
          `total=${counts.total}, nonTerminal=${counts.nonTerminal}). Continuing legacy ` +
          `infinite idle because terminationEnabled=false.`,
      );
      return "continue";
    }

    if (this.wakePending) {
      // Wake-on-NOTIFY race: external work arrived after this cycle's snapshot. Do not
      // stop — re-cycle so the next snapshot observes it.
      console.log(
        `Termination (${reason}) superseded by newly-arrived work (NOTIFY); re-cycling instead of stopping`,
      );
      return "recycle";
    }

    if (outcome.summary) {
      if (this.eventLogger) {
        emitRunSummary(this.eventLogger, outcome.summary);
      }
      console.log(outcome.summary.narrative);
    }
    console.log(`Continuous runner terminating: ${reason}`);
    return "stop";
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

export function computeBackoff(consecutiveErrors: number): number {
  const exponent = Math.min(consecutiveErrors, 6);
  return Math.pow(2, exponent) * 1000;
}
