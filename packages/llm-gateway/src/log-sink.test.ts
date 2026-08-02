import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { LLMGateway } from "./gateway.js";
import type { GatewayConfig, LLMCallRecord } from "./types.js";

vi.mock("ai", () => ({
  generateObject: vi.fn().mockResolvedValue({
    object: { greeting: "hello" },
    usage: { inputTokens: 100, outputTokens: 50 },
    providerMetadata: undefined,
    warnings: [],
  }),
  generateText: vi.fn(),
}));

function makeConfig(): GatewayConfig {
  return {
    providers: [
      {
        name: "anthropic",
        apiKey: "test-key",
        baseUrl: "https://test.example.com/v1",
        models: [
          {
            id: "test-model",
            apiModelId: "test-model-api",
            provider: "anthropic",
            capabilityLevel: "Strong",
            inputCostPer1M: 3,
            outputCostPer1M: 15,
            maxContextTokens: 100000,
            supportsCaching: false,
          },
        ],
        enabled: true,
      },
    ],
    defaultProvider: "anthropic",
  };
}

describe("LLMGateway logSink", () => {
  test("generateStructured() emits an LLMCallRecord to the logSink", async () => {
    const records: LLMCallRecord[] = [];
    const gateway = new LLMGateway(makeConfig(), undefined, (r) => records.push(r));

    await gateway.generateStructured({
      capability: "Strong",
      prompt: "say hello",
      schema: z.object({ greeting: z.string() }),
      site: "agent-runner",
    });

    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.site).toBe("agent-runner");
    expect(r.capability).toBe("Strong");
    expect(r.model).toBe("test-model");
    expect(r.provider).toBe("anthropic");
    expect(r.inputTokens).toBe(100);
    expect(r.outputTokens).toBe(50);
    expect(r.costUsd).toBeGreaterThan(0);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
    expect(r.timestamp).toBeTruthy();
  });

  test("generateStructured() without logSink does not throw", async () => {
    const gateway = new LLMGateway(makeConfig());

    const result = await gateway.generateStructured({
      capability: "Strong",
      prompt: "say hello",
      schema: z.object({ greeting: z.string() }),
    });

    expect(result.data).toEqual({ greeting: "hello" });
  });
});
