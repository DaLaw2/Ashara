import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it } from "vitest";
import { recordingLogger } from "@ashara/shared/testing";
import type { ServedComposition } from "./process-lifecycle.js";
import { serveAshara } from "./process-lifecycle.js";

/**
 * A composition whose runner returns once aborted; startup and the drain each log one record. Like
 * composeAshara it composes in a boot trace of its own, and logs `test.composed` there.
 */
function composition(
  run: ServedComposition["runner"]["run"] = (signal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve(null))),
): ServedComposition & { readonly logger: ReturnType<typeof recordingLogger> } {
  const logger = recordingLogger();
  const abort = new AbortController();
  const inBootTrace = logger.scope({ trace: "new" }, () => {
    logger.info("test.composed", "composed");
    return AsyncLocalStorage.snapshot();
  });
  return {
    logger,
    booted: (work) => inBootTrace(work),
    port: 0,
    shutdownSignal: abort.signal,
    startup: async () => logger.info("test.startup", "startup ran"),
    runner: {
      run: (signal, onHalt) => {
        logger.info("test.runner", "runner started");
        return run(signal, onHalt);
      },
    },
    abort: () => abort.abort(),
    teardownCells: async () => logger.info("test.teardown", "cells removed"),
    closeDatabase: async () => {},
  };
}

describe("a served process's boot and shutdown", () => {
  it("boot logs in the composition's boot trace and shutdown in a trace of its own, each a child of the logger's root, never the root itself", async () => {
    const ashara = composition();
    const root = ashara.logger.trace();
    let closed = false;
    const served = await serveAshara(ashara, () => ({ close: () => (closed = true) }), 5_000);
    expect(await served.shutdown()).toBe("stopped");
    expect(closed).toBe(true);

    const traceOf = (event: string): { traceId: string; parentTraceId: string | undefined } => {
      const found = ashara.logger.records.find((r) => r.event === event);
      if (found === undefined) throw new Error(`no ${event} record`);
      return { traceId: found.traceId, parentTraceId: found.parentTraceId };
    };
    const boot = traceOf("server.listening");
    const shutdown = traceOf("server.shutting-down");
    for (const scoped of [boot, shutdown]) {
      expect(scoped.traceId).not.toBe(root);
      expect(scoped.parentTraceId).toBe(root);
    }
    expect(shutdown.traceId).not.toBe(boot.traceId);
    expect(traceOf("test.composed").traceId).toBe(boot.traceId);
    expect(traceOf("test.startup").traceId).toBe(boot.traceId);
    expect(traceOf("test.runner").traceId).toBe(boot.traceId);
    expect(traceOf("test.teardown").traceId).toBe(shutdown.traceId);
    expect(traceOf("server.stopped").traceId).toBe(shutdown.traceId);
    expect(ashara.logger.records.every((r) => r.traceId !== root)).toBe(true);
  });

  it("a runner still in flight at the deadline ends the shutdown there, naming the step it was in, and the cells and pool are left to the next startup", async () => {
    const ashara = composition(() => new Promise(() => {}));
    let closedDatabase = false;
    const served = await serveAshara({ ...ashara, closeDatabase: async () => void (closedDatabase = true) }, () => ({ close: () => {} }), 50);
    const started = Date.now();

    expect(await served.shutdown()).toBe("deadline-passed");

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(closedDatabase).toBe(false);
    const deadline = ashara.logger.records.find((r) => r.event === "server.shutdown-deadline");
    expect(deadline?.level).toBe("error");
    expect(deadline?.fields).toEqual({ deadlineMs: 50, step: "draining the runner" });
    expect(ashara.logger.records.some((r) => r.event === "server.stopped")).toBe(false);
    // Every caller shares the one shutdown and its outcome.
    expect(await served.shutdown()).toBe("deadline-passed");
  });
});
