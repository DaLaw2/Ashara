import { serve } from "@hono/node-server";
import { createPgPool } from "@ashara/db";
import { execFileGitRunner, spawnProcess } from "@ashara/execution-infra";
import { NoLLMProvidersConfigured, sdkLanguageModels } from "@ashara/model-access";
import { concurrentTaskLanes } from "@ashara/delivery";
import { stdoutSink, systemClock } from "@ashara/shared";
import { composeAshara } from "./compose.js";
import type { AsharaInstance } from "./compose.js";
import { loadDatabaseUrl } from "./config.js";
import { loadServerMasterKey } from "./secrets.js";
import { createFatalExit } from "./fail-closed.js";
import { serveAshara } from "./process-lifecycle.js";

// Policy: how long a fatal error waits for the graceful shutdown (cancelled attempts,
// cell removal, pool close) before the process exits without it.
const FATAL_SHUTDOWN_DEADLINE_MS = 30_000;

async function main(): Promise<void> {
  // Phase 1: the master key, before anything else — without it no credential
  // can be read. Then the database URL from env or policy default.
  const masterKey = loadServerMasterKey(process.env);
  const databaseUrl = loadDatabaseUrl();

  // The production ports: a plain pg pool, the AI SDK providers, podman spawned directly, the
  // host's git, the host's clock and JSON lines on stdout.
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
      log: stdoutSink,
    });
  } catch (err) {
    if (err instanceof NoLLMProvidersConfigured) {
      console.error("FATAL: LLM gateway refused to start: no model provider is configured -- server will not boot.");
      console.error(`  checked sources: ${err.checkedSources.join(", ") || "none"}`);
      console.error(`  how to fix: ${err.howToFix}`);
      console.error(`  ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  const served = await serveAshara(ashara, () => serve({ fetch: ashara.app.fetch, port: ashara.port }));
  fatalExit.setShutdown(served.shutdown);
  process.on("SIGTERM", () => void served.shutdown());
  process.on("SIGINT", () => void served.shutdown());

  // The runner returns only once the shutdown signal aborted it.
  await served.runnerDone;
  await served.shutdown();
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
