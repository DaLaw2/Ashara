import { describe, expect, expectTypeOf, test } from "vitest";
import { createWorkItemId, recordingLogger, wrapError } from "@ashara/shared";
import { EXECUTION_STATUSES, NO_AGENT, environmentBlocked } from "./dispatch-result.js";
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
