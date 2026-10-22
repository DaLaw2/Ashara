import { describe, expect, test } from "vitest";
import { CallTotalsRowSchema } from "./run-evidence.js";

const ROW = {
  taskId: null,
  provider: "deepseek",
  calls: 2,
  measuredCalls: 0,
  measuredUsd: 0,
  unmeasuredEstimateUsd: 0.5,
  unestimatedCalls: 1,
  pendingCalls: 0,
  lostCalls: 0,
  zeroCostCalls: 0,
  cacheCountedCalls: 0,
  inputTokens: 0,
  cacheReadTokens: 0,
};

describe("CallTotalsRowSchema", () => {
  test("requires the unestimated count, with no default standing in for an absent one", () => {
    const withoutCount = Object.fromEntries(Object.entries(ROW).filter(([field]) => field !== "unestimatedCalls"));

    expect(CallTotalsRowSchema.safeParse(withoutCount).success).toBe(false);
    expect(CallTotalsRowSchema.parse(ROW).unestimatedCalls).toBe(1);
  });
});
