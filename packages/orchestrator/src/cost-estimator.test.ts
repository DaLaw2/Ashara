import { describe, expect, test, vi } from "vitest";
import type { CapabilityCostEstimate } from "@ashara/db";
import { CostEstimator } from "./cost-estimator.js";
import type { CostDataSource } from "./cost-estimator.js";

function stubRepo(overrides: Partial<CostDataSource> = {}): CostDataSource {
  return {
    loadModelPricing: vi.fn<CostDataSource["loadModelPricing"]>()
      .mockResolvedValue({ Strong: { inputPer1m: 3, outputPer1m: 15 } }),
    loadCostHistory: vi.fn<CostDataSource["loadCostHistory"]>()
      .mockResolvedValue({
        Strong: { avgInputTokens: 8000, avgOutputTokens: 4000, avgCostUsd: 0.09, sampleCount: 5 },
      }),
    ...overrides,
  };
}

describe("CostEstimator.load", () => {
  test("sets loaded after both loads succeed", async () => {
    const estimator = new CostEstimator();
    const repo = stubRepo();

    expect(estimator.isLoaded()).toBe(false);
    await estimator.load(repo);
    expect(estimator.isLoaded()).toBe(true);
  });

  test("stays not-loaded when both loads fail", async () => {
    const estimator = new CostEstimator();
    const repo = stubRepo({
      loadModelPricing: vi.fn().mockRejectedValue(new Error("db down")),
      loadCostHistory: vi.fn().mockRejectedValue(new Error("db down")),
    });

    await estimator.load(repo);
    expect(estimator.isLoaded()).toBe(false);
  });

  test("stays not-loaded when only pricing succeeds", async () => {
    const estimator = new CostEstimator();
    const repo = stubRepo({
      loadCostHistory: vi.fn().mockRejectedValue(new Error("history table missing")),
    });

    await estimator.load(repo);
    expect(estimator.isLoaded()).toBe(false);
  });

  test("stays not-loaded when only history succeeds", async () => {
    const estimator = new CostEstimator();
    const repo = stubRepo({
      loadModelPricing: vi.fn().mockRejectedValue(new Error("pricing table missing")),
    });

    await estimator.load(repo);
    expect(estimator.isLoaded()).toBe(false);
  });

  test("retry succeeds after a transient failure", async () => {
    const estimator = new CostEstimator();
    const failOnce = vi.fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue({ Strong: { inputPer1m: 3, outputPer1m: 15 } });

    const repo = stubRepo({ loadModelPricing: failOnce });

    await estimator.load(repo);
    // History loaded, pricing failed — not loaded yet
    expect(estimator.isLoaded()).toBe(false);

    await estimator.load(repo);
    // Second attempt succeeds — now fully loaded
    expect(estimator.isLoaded()).toBe(true);
    expect(failOnce).toHaveBeenCalledTimes(2);
  });

  test("retry skips already-loaded source", async () => {
    const estimator = new CostEstimator();
    const pricingFn = vi.fn<() => Promise<Record<string, { inputPer1m: number; outputPer1m: number }>>>()
      .mockResolvedValue({ Strong: { inputPer1m: 3, outputPer1m: 15 } });
    const historyFn = vi.fn<() => Promise<Record<string, CapabilityCostEstimate>>>()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue({
        Strong: { avgInputTokens: 8000, avgOutputTokens: 4000, avgCostUsd: 0.09, sampleCount: 5 },
      });

    const repo = stubRepo({ loadModelPricing: pricingFn, loadCostHistory: historyFn });

    await estimator.load(repo);
    expect(estimator.isLoaded()).toBe(false);

    await estimator.load(repo);
    expect(estimator.isLoaded()).toBe(true);
    // Pricing already loaded on first call — not re-fetched on second
    expect(pricingFn).toHaveBeenCalledTimes(1);
    expect(historyFn).toHaveBeenCalledTimes(2);
  });
});
