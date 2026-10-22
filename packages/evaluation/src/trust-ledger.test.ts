import { describe, expect, test } from "vitest";
import { spendOf } from "./trust-ledger.js";

type CallTotals = Parameters<typeof spendOf>[1][number];

function totals(overrides: Partial<CallTotals>): CallTotals {
  return {
    taskId: null,
    provider: "deepseek",
    calls: 1,
    measuredCalls: 1,
    measuredUsd: 0.25,
    unmeasuredEstimateUsd: 0,
    unestimatedCalls: 0,
    pendingCalls: 0,
    lostCalls: 0,
    zeroCostCalls: 0,
    cacheCountedCalls: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    ...overrides,
  };
}

describe("spendOf", () => {
  test("an unmeasured call at its worst-case estimate is counted", () => {
    expect(spendOf("r1", [totals({ calls: 2, measuredCalls: 1, unmeasuredEstimateUsd: 0.5 })])).toEqual({ claudeUsd: 0, deepseekUsd: 0.75 });
  });

  test("one call with neither a cost nor an estimate, beside one with an estimate, refuses rather than counting it as $0", () => {
    const mixed = totals({ calls: 2, measuredCalls: 0, measuredUsd: 0, unmeasuredEstimateUsd: 0.5, unestimatedCalls: 1 });

    expect(() => spendOf("r1", [mixed])).toThrow(/1 deepseek call\(s\) are unmeasured with no worst-case estimate/);
  });
});
