import { describe, expect, test } from "vitest";
import type { CallWarning } from "ai";
import { TemperatureNotHonored } from "./errors.js";
import { assertTemperatureHonored, extractUsage } from "./gateway.js";

const TEMPERATURE_UNSUPPORTED: CallWarning = {
  type: "unsupported",
  feature: "temperature",
  details: "temperature is not supported by claude-sonnet-5 and will be ignored",
};

function check(overrides: Partial<Parameters<typeof assertTemperatureHonored>[0]> = {}) {
  return {
    requestedTemperature: 0,
    warnings: undefined,
    provider: "anthropic",
    model: "claude-sonnet-5",
    site: "decomposition" as const,
    operation: "generateObject",
    ...overrides,
  };
}

describe("assertTemperatureHonored", () => {
  test("throws with self-diagnosing context when the provider reports it dropped the temperature", () => {
    let thrown: unknown;
    try {
      assertTemperatureHonored(check({ warnings: [TEMPERATURE_UNSUPPORTED] }));
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(TemperatureNotHonored);
    if (!(thrown instanceof TemperatureNotHonored)) throw new Error("unreachable");
    expect(thrown.requestedTemperature).toBe(0);
    expect(thrown.model).toBe("claude-sonnet-5");
    expect(thrown.provider).toBe("anthropic");
    expect(thrown.site).toBe("decomposition");
    expect(thrown.operation).toBe("generateObject");
    expect(thrown.details).toBe(TEMPERATURE_UNSUPPORTED.details);
    expect(thrown.message).toContain(TEMPERATURE_UNSUPPORTED.details);
  });

  test("throws for any requested temperature, not only 0 — the violation is the silent substitution", () => {
    expect(() =>
      assertTemperatureHonored(check({ requestedTemperature: 0.7, warnings: [TEMPERATURE_UNSUPPORTED] })),
    ).toThrow(TemperatureNotHonored);
  });

  test("passes when no warnings were returned, including the undefined case", () => {
    expect(() => assertTemperatureHonored(check({ warnings: undefined }))).not.toThrow();
    expect(() => assertTemperatureHonored(check({ warnings: [] }))).not.toThrow();
  });

  test("passes on warnings about other features or of other kinds", () => {
    const unrelated: CallWarning[] = [
      { type: "unsupported", feature: "topP", details: "topP is not supported" },
      { type: "compatibility", feature: "temperature", details: "clamped for compatibility" },
    ];
    expect(() => assertTemperatureHonored(check({ warnings: unrelated }))).not.toThrow();
  });

  test("passes when no temperature was requested — nothing was promised to honor", () => {
    expect(() =>
      assertTemperatureHonored(
        check({ requestedTemperature: undefined, warnings: [TEMPERATURE_UNSUPPORTED] }),
      ),
    ).not.toThrow();
  });
});

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

  test("extracts Anthropic cache tokens from providerMetadata", () => {
    const extraction = extractUsage(
      { inputTokens: 200, outputTokens: 80 },
      { anthropic: { cacheReadInputTokens: 150, cacheCreationInputTokens: 30 } },
    );
    expect(extraction.measured).toBe(true);
    expect(extraction.usage.inputTokens).toBe(200);
    expect(extraction.usage.outputTokens).toBe(80);
    expect(extraction.usage.cacheReadTokens).toBe(150);
    expect(extraction.usage.cacheWriteTokens).toBe(30);
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
