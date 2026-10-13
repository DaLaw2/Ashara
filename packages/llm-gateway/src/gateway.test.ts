import { describe, expect, test } from "vitest";
import { extractUsage } from "./gateway.js";

describe("extractUsage", () => {
  test("returns measured extraction when the SDK provides all token counts", () => {
    const extraction = extractUsage(
      { inputTokens: 100, outputTokens: 50 },
      undefined,
    );
    expect(extraction.measured).toBe(true);
    expect(extraction.usage.inputTokens).toBe(100);
    expect(extraction.usage.outputTokens).toBe(50);
    expect(extraction.usage.cacheReadTokens).toBe(0);
    expect(extraction.usage.cacheWriteTokens).toBe(0);
  });

  test("reports no cache counts when the provider metadata carries none", () => {
    const extraction = extractUsage({ inputTokens: 100, outputTokens: 50 }, undefined);
    expect(extraction.reported).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: null,
      cacheWriteTokens: null,
    });
  });

  test("extracts Anthropic cache tokens from the raw usage @ai-sdk/anthropic copies into providerMetadata", () => {
    const extraction = extractUsage(
      { inputTokens: 200, outputTokens: 80 },
      { anthropic: { usage: { input_tokens: 20, cache_read_input_tokens: 150, cache_creation_input_tokens: 30 } } },
    );
    expect(extraction.measured).toBe(true);
    expect(extraction.usage.inputTokens).toBe(200);
    expect(extraction.usage.outputTokens).toBe(80);
    expect(extraction.usage.cacheReadTokens).toBe(150);
    expect(extraction.usage.cacheWriteTokens).toBe(30);
    expect(extraction.reported.cacheReadTokens).toBe(150);
    expect(extraction.reported.cacheWriteTokens).toBe(30);
  });

  test("extracts DeepSeek cache hits; no write class when hits plus misses cover every input token", () => {
    const extraction = extractUsage(
      { inputTokens: 1000, outputTokens: 40 },
      { deepseek: { promptCacheHitTokens: 600, promptCacheMissTokens: 400 } },
    );
    expect(extraction.reported.cacheReadTokens).toBe(600);
    expect(extraction.reported.cacheWriteTokens).toBe(0);
  });

  test("leaves DeepSeek cache writes unknown when the miss count is not reported", () => {
    const extraction = extractUsage(
      { inputTokens: 1000, outputTokens: 40 },
      { deepseek: { promptCacheHitTokens: 600 } },
    );
    expect(extraction.reported.cacheReadTokens).toBe(600);
    expect(extraction.reported.cacheWriteTokens).toBeNull();
  });

  test("returns unmeasured when the usage object is absent — completes, does not throw", () => {
    const extraction = extractUsage(undefined, undefined);
    expect(extraction.measured).toBe(false);
    if (!extraction.measured) {
      expect(extraction.missingFields).toContain("sdkUsageObject");
    }
    expect(extraction.usage.inputTokens).toBe(0);
    expect(extraction.usage.outputTokens).toBe(0);
  });

  test("returns unmeasured when inputTokens is undefined — flags the missing field", () => {
    const extraction = extractUsage({ outputTokens: 50 }, undefined);
    expect(extraction.measured).toBe(false);
    if (!extraction.measured) {
      expect(extraction.missingFields).toContain("inputTokens");
      expect(extraction.missingFields).not.toContain("outputTokens");
    }
    expect(extraction.usage.inputTokens).toBe(0);
    expect(extraction.usage.outputTokens).toBe(50);
  });

  test("returns unmeasured when outputTokens is undefined — flags the missing field", () => {
    const extraction = extractUsage({ inputTokens: 100 }, undefined);
    expect(extraction.measured).toBe(false);
    if (!extraction.measured) {
      expect(extraction.missingFields).toContain("outputTokens");
      expect(extraction.missingFields).not.toContain("inputTokens");
    }
    expect(extraction.usage.inputTokens).toBe(100);
    expect(extraction.usage.outputTokens).toBe(0);
  });

  test("returns unmeasured when both token counts are undefined — flags both fields", () => {
    const extraction = extractUsage({}, undefined);
    expect(extraction.measured).toBe(false);
    if (!extraction.measured) {
      expect(extraction.missingFields).toContain("inputTokens");
      expect(extraction.missingFields).toContain("outputTokens");
    }
    expect(extraction.usage.inputTokens).toBe(0);
    expect(extraction.usage.outputTokens).toBe(0);
  });

  test("accepts zero token counts — zero is a real number, not absence", () => {
    const extraction = extractUsage({ inputTokens: 0, outputTokens: 0 }, undefined);
    expect(extraction.measured).toBe(true);
    expect(extraction.usage.inputTokens).toBe(0);
    expect(extraction.usage.outputTokens).toBe(0);
  });

  test("unmeasured extraction produces a completed call — not a throw, not a retry", () => {
    // The old MissingUsageError was caught by withFallback, discarding the
    // successful completion and retrying on a fallback provider. This test
    // verifies that extractUsage now completes synchronously without throwing,
    // so the successful response is preserved and no retry is triggered.
    const cases = [
      undefined,
      { outputTokens: 50 },
      { inputTokens: 100 },
      {},
    ] as const;

    for (const sdkUsage of cases) {
      let threw = false;
      try {
        const extraction = extractUsage(sdkUsage, undefined);
        // Verify the result is usable — the call completed
        expect(extraction.measured).toBe(false);
        expect(extraction.usage).toBeDefined();
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
    }
  });
});
