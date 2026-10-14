import { serve } from "@hono/node-server";
import { createPgPool } from "@ashara/db";
import { execFileGitRunner, spawnProcess } from "@ashara/execution-infra";
import { NoLLMProvidersConfigured, sdkLanguageModels } from "@ashara/llm-gateway";
import { concurrentTaskLanes } from "@ashara/orchestrator";
import { systemClock } from "@ashara/shared";
import { composeAshara } from "./compose.js";
import type { AsharaInstance } from "./compose.js";
import { loadDatabaseUrl } from "./config.js";
import { loadServerMasterKey } from "./secrets.js";
import { createFatalExit } from "./fail-closed.js";

// Policy: how long a fatal error waits for the graceful shutdown (cancelled attempts,
// cell removal, pool close) before the process exits without it.
const FATAL_SHUTDOWN_DEADLINE_MS = 30_000;

async function main(): Promise<void> {
  // Phase 1: the master key, before anything else — without it no credential
  // can be read (ADR-075 C2). Then the database URL from env or policy default.
  const masterKey = loadServerMasterKey(process.env);
  const databaseUrl = loadDatabaseUrl();

  // The production ports: a plain pg pool, the AI SDK providers, podman spawned directly, the
  // host's git and the host's clock.
  let ashara: AsharaInstance;
  try {
    ashara = await composeAshara({
      masterKey,
      databaseUrl,
      createPool: createPgPool,
      models: sdkLanguageModels,
      processRunner: spawnProcess,
      git: execFileGitRunner,
      clock: systemClock,
      taskLanes: concurrentTaskLanes,
    });
  } catch (err) {
    if (err instanceof NoLLMProvidersConfigured) {
      console.error("FATAL: LLM gateway refused to start (ADR-030) -- server will not boot.");
      console.error(`  checked sources: ${err.checkedSources.join(", ") || "none"}`);
      console.error(`  how to fix: ${err.howToFix}`);
      console.error(`  ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  // Startup reconciliation (Discipline B) — MUST run before the runner starts cycling.
  await ashara.startup();

  // A halt (the deployment's spend cap) stops the work for good but not the process: HTTP stays up,
  // and the runner keeps taking in and answering the client's stops until SIGTERM (smoke1 D3). No
  // attempt runs from the halt on, so every cell is removed then.
  const runnerPromise = ashara.runner.run(ashara.shutdownSignal, async (stop) => {
    console.error(
      `FATAL: the continuous runner stopped its work: ${stop.reason}. HTTP stays up and the client's stops are still ` +
        `answered; SIGTERM to exit.`,
    );
    await ashara.teardownCells();
  });

  const server = serve({
    fetch: ashara.app.fetch,
    port: ashara.port,
  });

  console.log(`Ashara server listening on port ${ashara.port}`);
  console.log("Continuous runner started in background");

  // One shutdown, shared by SIGTERM/SIGINT and the fatal-error exit: stop accepting
  // requests, cancel and drain the runner, remove every cell, close the pool.
  let shutdownRun: Promise<void> | null = null;
  const shutdown = (): Promise<void> => {
    shutdownRun ??= (async () => {
      console.log("Shutting down...");
      // The abort cancels every attempt in flight; each dispatch then tears its
      // own cells down, and the drain below removes whatever is left.
      ashara.abort();
      server.close();
      await runnerPromise;
      await ashara.teardownCells();
      await ashara.closeDatabase();
    })();
    return shutdownRun;
  };
  fatalExit.setShutdown(shutdown);
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  // The runner returns only once the shutdown signal aborted it.
  await runnerPromise;
  await shutdown();
  console.log("Server and continuous runner stopped");
}

const fatalExit = createFatalExit({
  deadlineMs: FATAL_SHUTDOWN_DEADLINE_MS,
  exit: (code) => process.exit(code),
  log: (line) => console.error(line),
});
process.on("uncaughtException", (err: Error) => fatalExit.onFatal("uncaughtException", err));
process.on("unhandledRejection", (err: unknown) => fatalExit.onFatal("unhandledRejection", err));

// main() rejecting once the shutdown exists drains the runner, removes the cells and closes the
// pool like any other fatal error; during boot there is nothing to drain and the exit is immediate.
main().catch((e: unknown) => fatalExit.onFatal("main", e));
