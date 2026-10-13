import { describe, expect, test, vi } from "vitest";
import type { AgentOutputJson } from "@ashara/shared/agent-output";
import { costFromOutput } from "./types.js";
import { BudgetTracker } from "./budget.js";
import type { CoreLoopConfig } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function measuredOutput(overrides: Partial<AgentOutputJson> = {}): AgentOutputJson {
  return {
    status: "done",
    summary: "task complete",
    findings: [],
    error: null,
    error_detail: null,
    total_tokens: { input: 5000, output: 2000 },
    total_cost: 0.05,
    cost_measured: true,
    turn_count: 3,
    finish_reason: "completed",
    ...overrides,
  };
}

function unmeasuredOutput(overrides: Partial<AgentOutputJson> = {}): AgentOutputJson {
  return {
    ...measuredOutput(),
    // One call was unmeasured, so the total is understated — e.g. 3 of 4
    // calls reported $0.04, the 4th reported $0 because the provider gave
    // no token counts. The accumulated total_cost is 0.04, not 0.
    total_cost: 0.04,
    cost_measured: false,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<CoreLoopConfig> = {}): CoreLoopConfig {
  return { ...DEFAULT_CONFIG, workdirBase: "/tmp/test", budgetLimitUsd: 10, ...overrides };
}

// ---------------------------------------------------------------------------
// costFromOutput — unmeasured flag
// ---------------------------------------------------------------------------

describe("costFromOutput — unmeasured cost propagation", () => {
  test("measured output returns the reported cost as costUsd", () => {
    const output = measuredOutput({ total_cost: 0.05 });
    const cost = costFromOutput(output, 1, true);

    expect(cost.costUsd).toBe(0.05);
    expect(cost.inputTokens).toBe(5000);
    expect(cost.outputTokens).toBe(2000);
  });

  test("unmeasured output returns costUsd: null regardless of total_cost", () => {
    const output = unmeasuredOutput({ total_cost: 0.04 });
    const cost = costFromOutput(output, 1, true);

    // The key assertion: a positive total_cost is NOT trusted when
    // cost_measured is false. The budget must use unknownCostCharge.
    expect(cost.costUsd).toBeNull();
    // Token counts still flow through for diagnostics
    expect(cost.inputTokens).toBe(5000);
    expect(cost.outputTokens).toBe(2000);
  });

  test("unmeasured output with zero cost also returns null", () => {
    const output = unmeasuredOutput({ total_cost: 0 });
    const cost = costFromOutput(output, 1, true);

    expect(cost.costUsd).toBeNull();
  });

  test("null output with agentInvoked returns null (pre-existing behavior)", () => {
    const cost = costFromOutput(null, 1, true);
    expect(cost.costUsd).toBeNull();
  });

  test("null output without agentInvoked returns 0 (pre-existing behavior)", () => {
    const cost = costFromOutput(null, 1, false);
    expect(cost.costUsd).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// BudgetTracker — unmeasured run charges unknownCostCharge
// ---------------------------------------------------------------------------

describe("BudgetTracker — unmeasured cost path", () => {
  test("unmeasured run charges unknownCostCharge, not the understated total", () => {
    const config = makeConfig({ budgetLimitUsd: 10 });
    const tracker = new BudgetTracker(config);

    // Simulate: costFromOutput returned null because cost_measured was false
    const costInfo = costFromOutput(unmeasuredOutput(), 1, true);
    expect(costInfo.costUsd).toBeNull();

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    tracker.accumulateCost(costInfo, "Strong", true);

    // The tracker must have charged SOMETHING — not $0
    expect(tracker.totalCostUsd).toBeGreaterThan(0);

    // The warn log must mention the unknown-cost charge path
    const unknownWarn = warnSpy.mock.calls.find(
      (args) => typeof args[0] === "string" && args[0].includes("reported no cost"),
    );
    expect(unknownWarn).toBeDefined();

    vi.restoreAllMocks();
  });

  test("measured run charges the reported cost, not unknownCostCharge", () => {
    const config = makeConfig({ budgetLimitUsd: 10 });
    const tracker = new BudgetTracker(config);

    const costInfo = costFromOutput(measuredOutput({ total_cost: 0.05 }), 1, true);
    expect(costInfo.costUsd).toBe(0.05);

    vi.spyOn(console, "log").mockImplementation(() => {});

    tracker.accumulateCost(costInfo, "Strong", true);

    expect(tracker.totalCostUsd).toBe(0.05);

    vi.restoreAllMocks();
  });

  test("unmeasured run does not train the estimator", async () => {
    const config = makeConfig({ budgetLimitUsd: 10 });
    const tracker = new BudgetTracker(config);

    const costInfo = costFromOutput(unmeasuredOutput(), 1, true);
    expect(costInfo.costUsd).toBeNull();

    // recordTaskCost guards on costUsd === null and returns early,
    // which means updateHistory is never called.
    const costRepo = {
      recordTaskCost: vi.fn().mockResolvedValue(undefined),
      loadModelPricing: vi.fn().mockResolvedValue({}),
      loadCostHistory: vi.fn().mockResolvedValue({}),
    };

    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    await tracker.recordTaskCost(
      costRepo as never,
      "task-1",
      "Strong",
      costInfo,
      true,
    );

    // The DB write must NOT have been called — null cost is excluded
    expect(costRepo.recordTaskCost).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  test("measured run DOES train the estimator", async () => {
    const config = makeConfig({ budgetLimitUsd: 10 });
    const tracker = new BudgetTracker(config);

    const costInfo = costFromOutput(measuredOutput({ total_cost: 0.05 }), 1, true);

    const costRepo = {
      recordTaskCost: vi.fn().mockResolvedValue(undefined),
      loadModelPricing: vi.fn().mockResolvedValue({}),
      loadCostHistory: vi.fn().mockResolvedValue({}),
    };

    vi.spyOn(console, "log").mockImplementation(() => {});

    await tracker.recordTaskCost(
      costRepo as never,
      "task-1",
      "Strong",
      costInfo,
      true,
    );

    // The DB write MUST have been called — measured cost trains the estimator
    expect(costRepo.recordTaskCost).toHaveBeenCalledOnce();

    vi.restoreAllMocks();
  });
});
