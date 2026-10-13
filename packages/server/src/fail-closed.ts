import { inspect } from "node:util";
import { ServerStartupRefused } from "./secrets.js";

/** `main`: main() itself rejected, the same corrupted process reached through the boot's own await chain. */
type FatalOrigin = "uncaughtException" | "unhandledRejection" | "main";

/** The error, its stack, its own fields and every `cause` beneath it, as one log line set. */
function describeErrorChain(err: unknown): string {
  return inspect(err, { depth: 12, breakLength: 120 });
}

interface FatalExitDeps {
  /** Upper bound on the graceful shutdown; past it the process exits regardless. */
  readonly deadlineMs: number;
  readonly exit: (code: number) => void;
  readonly log: (line: string) => void;
}

interface FatalExit {
  /** The graceful shutdown (drain, cells, DB) a fatal error runs before the exit. */
  setShutdown(shutdown: () => Promise<void>): void;
  /** The process-level handler: a corrupted process stops, it never runs on. */
  onFatal(origin: FatalOrigin, err: unknown): void;
}

/**
 * Discipline A at the process boundary. An uncaught exception, an unhandled rejection or main()
 * rejecting means some invariant no longer holds, so the process logs the whole cause chain, runs the graceful
 * shutdown under a hard deadline and exits non-zero. Before the shutdown exists (during boot)
 * there is nothing to drain and the exit is immediate.
 */
export function createFatalExit(deps: FatalExitDeps): FatalExit {
  let shutdown: (() => Promise<void>) | null = null;
  let stopping = false;
  let exited = false;

  const exitOnce = (): void => {
    if (exited) return;
    exited = true;
    deps.exit(1);
  };

  return {
    setShutdown(fn) {
      shutdown = fn;
    },
    onFatal(origin, err) {
      if (err instanceof ServerStartupRefused) deps.log(`FATAL: server refused to start. ${err.message}`);
      deps.log(`FATAL: ${origin}; the process stops and exits non-zero.\n${describeErrorChain(err)}`);
      if (stopping) {
        deps.log("FATAL: a further error arrived while the fatal shutdown runs; it continues under its deadline.");
        return;
      }
      stopping = true;
      const run = shutdown;
      if (run === null) {
        exitOnce();
        return;
      }
      const deadline = setTimeout(() => {
        deps.log(`FATAL: the graceful shutdown did not finish within ${deps.deadlineMs}ms; exiting without it.`);
        exitOnce();
      }, deps.deadlineMs);
      run().then(
        () => {
          clearTimeout(deadline);
          exitOnce();
        },
        (shutdownErr: unknown) => {
          clearTimeout(deadline);
          deps.log(`FATAL: the graceful shutdown itself failed:\n${describeErrorChain(shutdownErr)}`);
          exitOnce();
        },
      );
    },
  };
}

/**
 * Startup reconciliation that threw leaves the board in an unknown state (orphaned
 * InProgress items, Failed items never routed); the loop must not start on it.
 */
export async function reconcileOrRefuse(reconcile: () => Promise<unknown>, where: string): Promise<void> {
  try {
    await reconcile();
  } catch (err: unknown) {
    throw new ServerStartupRefused(
      `Startup reconciliation failed, so the board's state after the last process is unknown: ${
        err instanceof Error ? err.message : String(err)
      }`,
      where,
      "Fix the cause in the error chain (most often the database is unreachable) and start the server again; " +
        "the loop never runs on an unreconciled board.",
      { cause: err },
    );
  }
}
