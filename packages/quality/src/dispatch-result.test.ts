import { describe, expect, expectTypeOf, test } from "vitest";
import { CellExecInterrupted } from "@ashara/execution-infra";
import { createWorkItemId, wrapError } from "@ashara/shared";
import { recordingLogger } from "@ashara/shared/testing";
import { EXECUTION_STATUSES, NO_AGENT, asharaBlocked, environmentBlocked, mainRunBlocked, thrownBlocked } from "./dispatch-result.js";
import { VerificationInfrastructureFault } from "./fault-class.js";
import type { ExecutionResult } from "./dispatch-result.js";

describe("EXECUTION_STATUSES", () => {
  test("names every status an ExecutionResult can carry, each once", () => {
    // Its `satisfies` admits no member that is not a status; this is the converse, checked by tsc.
    expectTypeOf<(typeof EXECUTION_STATUSES)[number]>().toEqualTypeOf<ExecutionResult["status"]>();
    expect(new Set(EXECUTION_STATUSES).size).toBe(EXECUTION_STATUSES.length);
  });
});

describe("environmentBlocked", () => {
  test("logs the block at error carrying the failure's chain as the record's error", () => {
    const logger = recordingLogger();
    const taskId = createWorkItemId();
    const cause = Object.assign(new Error("cannot connect to the socket"), { name: "SubstrateUnavailable" });
    const chain = wrapError("development", "createWorkdir", cause, { taskId });
    environmentBlocked(
      {
        task: { id: taskId, attempt: 1 },
        sessionId: "s1",
        stage: "createWorkdir",
        fault: "substrate",
        errorClass: "SubstrateUnavailable",
        message: cause.message,
        chain,
        unavailable: "podman",
        ...NO_AGENT,
      },
      undefined,
      logger,
    );
    const blocked = logger.records.filter((r) => r.event === "quality.task-blocked");
    expect(blocked.map((r) => r.level)).toEqual(["error"]);
    expect(blocked[0]?.error).toEqual({
      layers: [
        expect.objectContaining({ boundary: "development", operation: "createWorkdir" }),
        expect.objectContaining({ message: expect.stringContaining("cannot connect to the socket") }),
      ],
    });
  });
});

describe("a stage the shutdown interrupted in a cell", () => {
  const interrupted = new CellExecInterrupted("cell-1", ["sh", "-c", "make test"], "while it ran", new Error("SIGTERM"));

  test("is interrupted, never blocked or failed, however the stage's catch reports the throw", () => {
    const task = { id: createWorkItemId(), attempt: 2 };
    const logger = recordingLogger();
    const results = [
      thrownBlocked({ task, sessionId: "s1", stage: "substrateGate", error: interrupted, where: { step: "substrate gate run", cell: "CI cell" }, agent: NO_AGENT, eventSink: undefined, logger }),
      mainRunBlocked({ task, sessionId: "s1", error: interrupted, agent: NO_AGENT, eventSink: undefined, logger, stage: "checkRedRun", step: "red run on the baseline" }),
      asharaBlocked({ task, sessionId: "s1", stage: "postMergeCheckRun", fault: new VerificationInfrastructureFault(task.id, "run_checks", { cause: interrupted }), agent: NO_AGENT, eventSink: undefined, logger }),
    ];
    expect(results.map((result) => result.status)).toEqual(["interrupted", "interrupted", "interrupted"]);
    expect(results.every((result) => result.attempt === 2 && result.detail.includes("interrupted by shutdown"))).toBe(true);
    expect(logger.records.filter((r) => r.event === "quality.task-blocked")).toEqual([]);
  });
});
