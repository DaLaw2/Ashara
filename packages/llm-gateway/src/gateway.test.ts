import { describe, expect, test } from "vitest";
import type { CallWarning } from "ai";
import { TemperatureNotHonored } from "./errors.js";
import { assertTemperatureHonored, LLMGateway } from "./gateway.js";
import type { GatewayConfig } from "./types.js";

describe("LLMGateway", () => {
  test("refuses to start without providers — fails closed instead of silently succeeding (Discipline A)", async () => {
    const config: GatewayConfig = { providers: [], defaultProvider: "none" };
    const gateway = new LLMGateway(config);

    await expect(
      gateway.complete({
        capability: "Strong",
        messages: [{ role: "user", content: "hello" }],
      }),
    ).rejects.toThrow(/No provider available/);
  });
});

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
