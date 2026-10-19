import { describe, expect, test } from "vitest";
import type { ModelConfig } from "@ashara/model-access";
import { measureCost } from "./cost.js";

function model(overrides: Partial<ModelConfig>): ModelConfig {
  return {
    id: "m",
    apiModelId: "m",
    provider: "p",
    capabilityLevel: "Strong",
    inputCostPer1M: 2,
    outputCostPer1M: 8,
    maxContextTokens: 100_000,
    cacheReadCostPer1M: 0.5,
    cacheWriteCostPer1M: null,
    priceWindows: [], priceTiers: [], datedPrices: [],
    ...overrides,
  };
}

const AT = new Date("2026-10-14T12:00:00Z");

describe("measureCost", () => {
  test("prices a response with cache reads at the cache-read rate", () => {
    const reported = { inputTokens: 1000, outputTokens: 50, cacheReadTokens: 600, cacheWriteTokens: null };
    const cost = measureCost(reported, model({}), AT);
    expect(cost.measured).toBe(true);
    if (!cost.measured) return;
    expect(cost.totalCost).toBeCloseTo((400 * 2 + 600 * 0.5 + 50 * 8) / 1_000_000, 12);
  });

  test("prices a response with both cache classes", () => {
    const reported = { inputTokens: 1200, outputTokens: 80, cacheReadTokens: 900, cacheWriteTokens: 100 };
    const cost = measureCost(reported, model({ inputCostPer1M: 3, outputCostPer1M: 15, cacheReadCostPer1M: 0.3, cacheWriteCostPer1M: 3.75 }), AT);
    expect(cost.measured).toBe(true);
    if (!cost.measured) return;
    expect(cost.totalCost).toBeCloseTo((200 * 3 + 900 * 0.3 + 100 * 3.75 + 80 * 15) / 1_000_000, 12);
  });

  test("an unreported class the model bills is a missing count; an unbilled one is plain input", () => {
    const reported = { inputTokens: 1000, outputTokens: 50, cacheReadTokens: null, cacheWriteTokens: null };
    expect(measureCost(reported, model({}), AT)).toEqual({
      measured: false,
      missingCounts: ["cacheReadTokens"],
      missingRates: [],
    });
    const unbilled = measureCost(reported, model({ cacheReadCostPer1M: null }), AT);
    expect(unbilled.measured).toBe(true);
  });

  test("reported tokens of a class with no rate are a missing rate", () => {
    const reported = { inputTokens: 1000, outputTokens: 50, cacheReadTokens: 700, cacheWriteTokens: null };
    expect(measureCost(reported, model({ cacheReadCostPer1M: null }), AT)).toEqual({
      measured: false,
      missingCounts: [],
      missingRates: ["cacheReadTokens"],
    });
  });

  test("unreported input or output counts are missing counts, never a $0 cost", () => {
    const cost = measureCost({ inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null }, model({ cacheReadCostPer1M: null }), AT);
    expect(cost).toEqual({ measured: false, missingCounts: ["inputTokens", "outputTokens"], missingRates: [] });
  });
  describe("a prompt-length tier prices the whole call from its reported input count", () => {
    // claude-haiku-5-5 as the seeded catalog stores it: a prompt over 100,000 tokens, cache classes included.
    const haiku = model({
      inputCostPer1M: 0.1, outputCostPer1M: 0.5, cacheReadCostPer1M: 0.01, cacheWriteCostPer1M: 0.125,
      priceTiers: [{
        minInputTokens: 100_001,
        rates: { inputCostPer1M: 0.5, outputCostPer1M: 2.5, cacheReadCostPer1M: 0.05, cacheWriteCostPer1M: 0.625 },
      }],
    });
    const costOf = (inputTokens: number, cacheReadTokens: number): number => {
      const cost = measureCost({ inputTokens, outputTokens: 1_000, cacheReadTokens, cacheWriteTokens: 0 }, haiku, AT);
      if (!cost.measured) return expect.unreachable("every count is reported");
      return cost.totalCost;
    };

    test("at the boundary the base rates apply; one token past it, the tier's rates apply to every token", () => {
      expect(costOf(100_000, 0)).toBeCloseTo((100_000 * 0.1 + 1_000 * 0.5) / 1_000_000, 12);
      expect(costOf(100_001, 0)).toBeCloseTo((100_001 * 0.5 + 1_000 * 2.5) / 1_000_000, 12);
    });

    test("cache reads count toward the threshold and are billed at the tier's cache rate", () => {
      expect(costOf(150_000, 90_000)).toBeCloseTo((60_000 * 0.5 + 90_000 * 0.05 + 1_000 * 2.5) / 1_000_000, 12);
    });

    test("of several tiers a count reaches, the highest threshold wins", () => {
      const twoTiers = model({
        cacheReadCostPer1M: null,
        priceTiers: [
          { minInputTokens: 500, rates: { inputCostPer1M: 4, outputCostPer1M: 16, cacheReadCostPer1M: null, cacheWriteCostPer1M: null } },
          { minInputTokens: 200, rates: { inputCostPer1M: 3, outputCostPer1M: 12, cacheReadCostPer1M: null, cacheWriteCostPer1M: null } },
        ],
      });
      const priced = (inputTokens: number) =>
        measureCost({ inputTokens, outputTokens: 0, cacheReadTokens: null, cacheWriteTokens: null }, twoTiers, AT);
      expect(priced(199)).toMatchObject({ measured: true, totalCost: (199 * 2) / 1_000_000 });
      expect(priced(200)).toMatchObject({ measured: true, totalCost: (200 * 3) / 1_000_000 });
      expect(priced(500)).toMatchObject({ measured: true, totalCost: (500 * 4) / 1_000_000 });
    });
  });

  describe("a dated price replaces the base rates from its effective instant on", () => {
    // gemini-4-argon as the seeded catalog schedules it: base 2 / 10 / 0.1, dated 4 / 20 / 0.2.
    const argon = model({
      id: "gemini-4-argon", apiModelId: "gemini-4-argon", provider: "google",
      inputCostPer1M: 2, outputCostPer1M: 10, cacheReadCostPer1M: 0.1, cacheWriteCostPer1M: null,
      datedPrices: [{
        effectiveFrom: new Date("2026-12-01T00:00:00Z"),
        rates: { inputCostPer1M: 4, outputCostPer1M: 20, cacheReadCostPer1M: 0.2, cacheWriteCostPer1M: null },
      }],
    });
    const costAt = (at: string): number => {
      const cost = measureCost({ inputTokens: 10_000, outputTokens: 2_000, cacheReadTokens: 4_000, cacheWriteTokens: null }, argon, new Date(at));
      if (!cost.measured) return expect.unreachable("every count is reported");
      return cost.totalCost;
    };

    test("a call one minute before the date pays the base rates; a call at the date pays the dated rates", () => {
      const before = costAt("2026-11-30T23:59:00Z");
      const after = costAt("2026-12-01T00:00:00Z");
      expect(before).toBeCloseTo((6_000 * 2 + 4_000 * 0.1 + 2_000 * 10) / 1_000_000, 12);
      expect(after).toBeCloseTo((6_000 * 4 + 4_000 * 0.2 + 2_000 * 20) / 1_000_000, 12);
      expect(after).not.toBeCloseTo(before, 12);
    });

    test("of several dated prices already in force, the latest one applies whatever their listed order", () => {
      const rate = (input: number) => ({ inputCostPer1M: input, outputCostPer1M: 1, cacheReadCostPer1M: null, cacheWriteCostPer1M: null });
      const twoChanges = model({
        cacheReadCostPer1M: null,
        datedPrices: [
          { effectiveFrom: new Date("2027-06-01T00:00:00Z"), rates: rate(7) },
          { effectiveFrom: new Date("2027-01-01T00:00:00Z"), rates: rate(5) },
        ],
      });
      const priced = (at: string) =>
        measureCost({ inputTokens: 1_000, outputTokens: 0, cacheReadTokens: null, cacheWriteTokens: null }, twoChanges, new Date(at));
      expect(priced("2026-12-31T23:59:59Z")).toMatchObject({ measured: true, totalCost: (1_000 * 2) / 1_000_000 });
      expect(priced("2027-03-01T00:00:00Z")).toMatchObject({ measured: true, totalCost: (1_000 * 5) / 1_000_000 });
      expect(priced("2027-06-01T00:00:00Z")).toMatchObject({ measured: true, totalCost: (1_000 * 7) / 1_000_000 });
    });
  });
});
