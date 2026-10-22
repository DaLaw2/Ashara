import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it } from "vitest";
import { recordingLogger } from "@ashara/shared/testing";
import type { ServedComposition } from "./process-lifecycle.js";
import { serveAshara } from "./process-lifecycle.js";

/**
 * A composition whose runner returns once aborted; startup and the drain each log one record. Like
 * composeAshara it composes in a boot trace of its own, and logs `test.composed` there.
 */
function composition(): ServedComposition & { readonly logger: ReturnType<typeof recordingLogger> } {
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
      run: (signal) =>
        new Promise((resolve) => {
          logger.info("test.runner", "runner started");
          signal.addEventListener("abort", () => resolve(null));
        }),
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
    const served = await serveAshara(ashara, () => ({ close: () => (closed = true) }));
    await served.shutdown();
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
});
