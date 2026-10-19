import type { AsharaInstance } from "./compose.js";

/** What a served process uses of its composition. */
export type ServedComposition = Pick<
  AsharaInstance,
  "logger" | "booted" | "port" | "shutdownSignal" | "startup" | "abort" | "teardownCells" | "closeDatabase"
> & { readonly runner: Pick<AsharaInstance["runner"], "run"> };

export interface ServedProcess {
  /** Settles once the runner returned, which it does only once the shutdown signal aborted it. */
  readonly runnerDone: Promise<unknown>;
  /**
   * The one shutdown, shared by every caller (signals, the fatal-error exit, the runner's return):
   * stop accepting requests, cancel and drain the runner, remove every cell, close the pool.
   */
  shutdown(): Promise<void>;
}

/**
 * Boots `ashara` in its boot trace: startup reconciliation (Discipline B, before the runner
 * cycles), then the runner, then `listen` for HTTP. The shutdown it returns runs in a trace of its
 * own, a child of the trace it is called from.
 */
export function serveAshara(ashara: ServedComposition, listen: () => { close(): void }): Promise<ServedProcess> {
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

    let shutdownRun: Promise<void> | null = null;
    const shutdown = (): Promise<void> => {
      shutdownRun ??= logger.scope({ trace: "new" }, async () => {
        logger.info("server.shutting-down", "Shutting down");
        // The abort cancels every attempt in flight; each dispatch then tears its
        // own cells down, and the drain below removes whatever is left.
        ashara.abort();
        server.close();
        await runnerDone;
        await ashara.teardownCells();
        await ashara.closeDatabase();
        logger.info("server.stopped", "Server and continuous runner stopped");
      });
      return shutdownRun;
    };
    return { runnerDone, shutdown };
  });
}
