import { describe, expect, test } from "vitest";
import { extractUsage } from "./gateway.js";
import { measureCost } from "./pricing.js";
import type { ModelConfig } from "./types.js";

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
    priceWindows: [],
    ...overrides,
  };
}

const AT = new Date("2026-10-14T12:00:00Z");

describe("extractUsage", () => {
  test("reads OpenAI Responses cache reads from the raw usage", () => {
    const { reported } = extractUsage({
      inputTokens: 1000,
      outputTokens: 50,
      raw: { input_tokens: 1000, output_tokens: 50, input_tokens_details: { cached_tokens: 600 } },
    });
    expect(reported).toEqual({ inputTokens: 1000, outputTokens: 50, cacheReadTokens: 600, cacheWriteTokens: null });
  });

  test("reads Chat Completions cache reads, as every createOpenAI().chat provider reports them", () => {
    const { reported } = extractUsage({
      inputTokens: 1000,
      outputTokens: 50,
      raw: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 0 } },
    });
    expect(reported.cacheReadTokens).toBe(0);
    expect(reported.cacheWriteTokens).toBeNull();
  });

  test("reads Anthropic cache reads and writes from the raw usage", () => {
    const { reported } = extractUsage({
      inputTokens: 200,
      outputTokens: 80,
      raw: { input_tokens: 20, cache_read_input_tokens: 150, cache_creation_input_tokens: 30 },
    });
    expect(reported.cacheReadTokens).toBe(150);
    expect(reported.cacheWriteTokens).toBe(30);
  });

  test("reads DeepSeek cache hits", () => {
    const { reported } = extractUsage({
      inputTokens: 1000,
      outputTokens: 40,
      raw: { prompt_tokens: 1000, prompt_cache_hit_tokens: 600, prompt_cache_miss_tokens: 400 },
    });
    expect(reported.cacheReadTokens).toBe(600);
  });

  test("an absent raw usage reports no cache count rather than 0", () => {
    const extraction = extractUsage({ inputTokens: 100, outputTokens: 50 });
    expect(extraction.reported.cacheReadTokens).toBeNull();
    expect(extraction.reported.cacheWriteTokens).toBeNull();
    expect(extraction.usage.cacheReadTokens).toBe(0);
  });

  test("absent usage or counts are null in `reported`, zero-filled in `usage`, and never throw", () => {
    for (const sdkUsage of [undefined, {}, { inputTokens: 100 }, { outputTokens: 50 }]) {
      const extraction = extractUsage(sdkUsage);
      expect(extraction.reported.inputTokens).toBe(sdkUsage?.inputTokens ?? null);
      expect(extraction.reported.outputTokens).toBe(sdkUsage?.outputTokens ?? null);
      expect(extraction.usage.inputTokens).toBe(sdkUsage?.inputTokens ?? 0);
    }
  });
});

describe("measureCost", () => {
  test("prices an OpenAI-shaped response with cache reads at the cache-read rate", () => {
    const { reported } = extractUsage({
      inputTokens: 1000,
      outputTokens: 50,
      raw: { input_tokens_details: { cached_tokens: 600 } },
    });
    const cost = measureCost(reported, model({}), AT);
    expect(cost.measured).toBe(true);
    if (!cost.measured) return;
    expect(cost.totalCost).toBeCloseTo((400 * 2 + 600 * 0.5 + 50 * 8) / 1_000_000, 12);
  });

  test("prices an Anthropic-shaped response with both cache classes", () => {
    const { reported } = extractUsage({
      inputTokens: 1200,
      outputTokens: 80,
      raw: { cache_read_input_tokens: 900, cache_creation_input_tokens: 100 },
    });
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
    const cost = measureCost(extractUsage(undefined).reported, model({ cacheReadCostPer1M: null }), AT);
    expect(cost).toEqual({ measured: false, missingCounts: ["inputTokens", "outputTokens"], missingRates: [] });
  });
});
