import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { BudgetTracker } from "@ashara/orchestrator";
import type { TaskCostInfo } from "@ashara/orchestrator";
import { loadServerConfig, loadDatabaseUrl, DEFAULT_DATABASE_URL } from "./config.js";

const TEST_DB_URL = "postgres://localhost:5432/test";
const TEST_TOKEN = "test-token";

// Finding (a), E2E Run 11: the enforcing per-run cap must reach
// CoreLoopConfig.budgetLimitUsd from the owner's env, and the economy stop must
// trip at that value. These tests pin both the plumbing (which env var wins) and
// the downstream behavior (BudgetTracker.isExhausted at the env cap).
describe("loadServerConfig — budget cap plumbing (finding a)", () => {
  const saved: Record<string, string | undefined> = {};
  const KEYS = [
    "DATABASE_URL",
    "ASHARA_BUDGET_LIMIT_USD",
    "ASHARA_BUDGET_TOTAL",
  ] as const;

  beforeEach(() => {
    for (const key of KEYS) saved[key] = process.env[key];
    delete process.env["ASHARA_BUDGET_LIMIT_USD"];
    delete process.env["ASHARA_BUDGET_TOTAL"];
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  test("ASHARA_BUDGET_TOTAL reaches budgetLimitUsd when ASHARA_BUDGET_LIMIT_USD is unset", () => {
    process.env["ASHARA_BUDGET_TOTAL"] = "1";
    const config = loadServerConfig(TEST_DB_URL, TEST_TOKEN);
    expect(config.coreLoop.budgetLimitUsd).toBe(1);
  });

  test("ASHARA_BUDGET_LIMIT_USD wins when both are set", () => {
    process.env["ASHARA_BUDGET_LIMIT_USD"] = "2";
    process.env["ASHARA_BUDGET_TOTAL"] = "1";
    const config = loadServerConfig(TEST_DB_URL, TEST_TOKEN);
    expect(config.coreLoop.budgetLimitUsd).toBe(2);
  });

  test("a blank ASHARA_BUDGET_LIMIT_USD does not mask the ASHARA_BUDGET_TOTAL fallback", () => {
    process.env["ASHARA_BUDGET_LIMIT_USD"] = "   ";
    process.env["ASHARA_BUDGET_TOTAL"] = "1";
    const config = loadServerConfig(TEST_DB_URL, TEST_TOKEN);
    expect(config.coreLoop.budgetLimitUsd).toBe(1);
  });

  test("defaults to 5 when neither is set", () => {
    const config = loadServerConfig(TEST_DB_URL, TEST_TOKEN);
    expect(config.coreLoop.budgetLimitUsd).toBe(5);
  });

  test("the economy stop trips at the env cap (ASHARA_BUDGET_TOTAL=1)", () => {
    process.env["ASHARA_BUDGET_TOTAL"] = "1";
    const config = loadServerConfig(TEST_DB_URL, TEST_TOKEN);
    expect(config.coreLoop.budgetLimitUsd).toBe(1);

    const budget = new BudgetTracker(config.coreLoop);
    // Below the cap: economy stop must NOT trip.
    budget.accumulateCost(measured(0.9293), "Strong", true);
    expect(budget.isExhausted()).toBe(false);
    expect(budget.checkpoint()).not.toBe("exhausted");

    // The Run-11 over-run shape: crossing $1 must trip the economy stop.
    budget.accumulateCost(measured(0.1512), "Strong", true);
    expect(budget.totalCostUsd).toBeCloseTo(1.0805);
    expect(budget.isExhausted()).toBe(true);
    expect(budget.checkpoint()).toBe("exhausted");
  });

  // An agent that crashed, timed out, or wrote malformed output reports no cost.
  // Charging that as $0 is what let the budget under-count real spend; the cap
  // exists to bound a runaway, and a runaway is exactly the shape that loses its
  // own cost report.
  test("an unknown cost is charged, not treated as free", () => {
    process.env["ASHARA_BUDGET_TOTAL"] = "1";
    const budget = new BudgetTracker(loadServerConfig(TEST_DB_URL, TEST_TOKEN).coreLoop);

    budget.accumulateCost(unknown(), "Strong", false);

    expect(budget.totalCostUsd).toBeGreaterThan(0);
  });

  test("repeated unknown costs still reach the cap and stop the run", () => {
    process.env["ASHARA_BUDGET_TOTAL"] = "1";
    const budget = new BudgetTracker(loadServerConfig(TEST_DB_URL, TEST_TOKEN).coreLoop);

    for (let i = 0; i < 50 && !budget.isExhausted(); i += 1) {
      budget.accumulateCost(unknown(), "Strong", false);
    }

    expect(budget.isExhausted()).toBe(true);
  });

  test("no dispatch means a MEASURED zero — an idle cycle never burns budget", () => {
    process.env["ASHARA_BUDGET_TOTAL"] = "1";
    const budget = new BudgetTracker(loadServerConfig(TEST_DB_URL, TEST_TOKEN).coreLoop);

    budget.accumulateCost(measured(0), "Strong", false);

    expect(budget.totalCostUsd).toBe(0);
    expect(budget.isExhausted()).toBe(false);
  });
});

describe("loadDatabaseUrl — policy default", () => {
  const saved = process.env["DATABASE_URL"];

  afterEach(() => {
    if (saved === undefined) delete process.env["DATABASE_URL"];
    else process.env["DATABASE_URL"] = saved;
  });

  test("uses DEFAULT_DATABASE_URL when DATABASE_URL is not set", () => {
    delete process.env["DATABASE_URL"];
    expect(loadDatabaseUrl()).toBe(DEFAULT_DATABASE_URL);
  });

  test("DATABASE_URL env var overrides the default", () => {
    process.env["DATABASE_URL"] = "postgres://other:5432/other";
    expect(loadDatabaseUrl()).toBe("postgres://other:5432/other");
  });
});

function measured(costUsd: number): TaskCostInfo {
  return { costUsd, inputTokens: 0, outputTokens: 0, modelId: null, attempt: 1 };
}

function unknown(): TaskCostInfo {
  return { costUsd: null, inputTokens: 0, outputTokens: 0, modelId: null, attempt: 1 };
}
