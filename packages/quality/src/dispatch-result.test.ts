import { describe, expect, expectTypeOf, test } from "vitest";
import { EXECUTION_STATUSES } from "./dispatch-result.js";
import type { ExecutionResult } from "./dispatch-result.js";

describe("EXECUTION_STATUSES", () => {
  test("names every status an ExecutionResult can carry, each once", () => {
    // Its `satisfies` admits no member that is not a status; this is the converse, checked by tsc.
    expectTypeOf<(typeof EXECUTION_STATUSES)[number]>().toEqualTypeOf<ExecutionResult["status"]>();
    expect(new Set(EXECUTION_STATUSES).size).toBe(EXECUTION_STATUSES.length);
  });
});
