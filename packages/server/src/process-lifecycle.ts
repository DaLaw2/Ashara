import type { AsharaInstance } from "./compose.js";

/** What a served process uses of its composition. */
export type ServedComposition = Pick<
  AsharaInstance,
  "logger" | "booted" | "port" | "shutdownSignal" | "startup" | "abort" | "teardownCells" | "closeDatabase"
> & { readonly runner: Pick<AsharaInstance["runner"], "run"> };

/**
 * How a shutdown ended: every step of it done, or its deadline passed first. Past the deadline the
 * process exits without the rest: a model call still pending in llm_calls, a task still InProgress
 * and a cell still running are each reconciled by the next startup.
 */
type ShutdownOutcome = "stopped" | "deadline-passed";

export interface ServedProcess {
  /** Settles once the runner returned, which it does only once the shutdown signal aborted it. */
  readonly runnerDone: Promise<unknown>;
  /**
   * The one shutdown, shared by every caller (signals, the fatal-error exit, the runner's return):
   * abort every model call and attempt in flight, stop accepting requests, drain the runner, remove
   * every cell, close the pool, all within the deadline `serveAshara` was given.
   */
  shutdown(): Promise<ShutdownOutcome>;
}

/** The step of a shutdown in progress, named when its deadline passes. */
type ShutdownStep = "draining the runner" | "removing the cells" | "closing the database";

/**
 * Boots `ashara` in its boot trace: startup reconciliation (Discipline B, before the runner
 * cycles), then the runner, then `listen` for HTTP. The shutdown it returns runs in a trace of its
 * own, a child of the trace it is called from, and ends within `shutdownDeadlineMs`.
 */
export function serveAshara(ashara: ServedComposition, listen: () => { close(): void }, shutdownDeadlineMs: number): Promise<ServedProcess> {
  const { logger } = ashara;
  return ashara.booted(async () => {
    await ashara.startup();

    // A halt (the deployment's spend cap) stops the work for good but not the process: HTTP stays up,
    // and the runner keeps taking in and answering the client's stops until SIGTERM. No
    // attempt runs from the halt on, so every cell is removed then.
    const runnerDone = ashara.runner.run(ashara.shutdownSignal, async (stop) => {
      logger.error(
        "server.runner-halted",
        `the continuous runner stopped its work: ${stop.reason}. HTTP stays up and the client's stops are still answered; SIGTERM to exit.`,
        { reason: stop.reason },
      );
      await ashara.teardownCells();
    });

    const server = listen();
    logger.info("server.listening", `Ashara server listening on port ${ashara.port}`, { port: ashara.port });
    logger.info("server.runner-started", "Continuous runner started in background");

    let shutdownRun: Promise<ShutdownOutcome> | null = null;
    const shutdown = (): Promise<ShutdownOutcome> => {
      shutdownRun ??= logger.scope({ trace: "new" }, async () => {
        logger.info("server.shutting-down", `Shutting down within ${shutdownDeadlineMs}ms`, { deadlineMs: shutdownDeadlineMs });
        // The abort cancels every model call and attempt in flight; each dispatch then tears its
        // own cells down, and the drain below removes whatever is left.
        ashara.abort();
        server.close();
        let step: ShutdownStep = "draining the runner";
        const steps = async (): Promise<ShutdownOutcome> => {
          await runnerDone;
          step = "removing the cells";
          await ashara.teardownCells();
          step = "closing the database";
          await ashara.closeDatabase();
          return "stopped";
        };
        let timer: NodeJS.Timeout | undefined;
        const deadline = new Promise<ShutdownOutcome>((resolve) => {
          timer = setTimeout(() => resolve("deadline-passed"), shutdownDeadlineMs);
        });
        try {
          const outcome = await Promise.race([steps(), deadline]);
          if (outcome === "deadline-passed") {
            logger.error(
              "server.shutdown-deadline",
              `the shutdown did not finish within ${shutdownDeadlineMs}ms (still ${step}); the process exits without the rest, ` +
                `and the next startup reconciles what it left: pending model calls, tasks in progress and cells`,
              { deadlineMs: shutdownDeadlineMs, step },
            );
          } else {
            logger.info("server.stopped", "Server and continuous runner stopped");
          }
          return outcome;
        } finally {
          clearTimeout(timer);
        }
      });
      return shutdownRun;
    };
    return { runnerDone, shutdown };
  });
}
