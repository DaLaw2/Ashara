import { describe, expect, test } from "vitest";
import { extractUsage } from "./gateway.js";
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
