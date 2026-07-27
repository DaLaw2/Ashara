import { describe, expect, test, vi } from "vitest";
import { LLMGateway } from "./gateway.js";
import type { GatewayConfig, LLMCallRecord } from "./types.js";

vi.mock("ai", () => ({
  generateText: vi.fn().mockResolvedValue({
    text: "mock response text here",
    toolCalls: [],
    usage: { inputTokens: 100, outputTokens: 50 },
    providerMetadata: undefined,
    finishReason: "stop",
    reasoningText: undefined,
  }),
  streamText: vi.fn(),
  generateObject: vi.fn(),
  jsonSchema: vi.fn((s: unknown) => s),
}));

function makeConfig(): GatewayConfig {
  return {
    providers: [
      {
        name: "test-provider",
        apiKey: "test-key",
        models: [
          {
            id: "test-model",
            apiModelId: "test-model-api",
            provider: "test-provider",
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
    defaultProvider: "test-provider",
  };
}

describe("LLMGateway logSink", () => {
  test("complete() emits an LLMCallRecord to the logSink", async () => {
    const records: LLMCallRecord[] = [];
    const gateway = new LLMGateway(makeConfig(), undefined, (r) => records.push(r));

    await gateway.complete({
      capability: "Strong",
      messages: [{ role: "user", content: "hello world" }],
      site: "agent-runner",
    });

    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.site).toBe("agent-runner");
    expect(r.capability).toBe("Strong");
    expect(r.model).toBe("test-model");
    expect(r.provider).toBe("test-provider");
    expect(r.promptExcerpt).toBe("hello world");
    expect(r.responseExcerpt).toBe("mock response text here");
    expect(r.inputTokens).toBe(100);
    expect(r.outputTokens).toBe(50);
    expect(r.costUsd).toBeGreaterThan(0);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
    expect(r.timestamp).toBeTruthy();
  });

  test("complete() without logSink does not throw", async () => {
    const gateway = new LLMGateway(makeConfig());

    const result = await gateway.complete({
      capability: "Strong",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(result.content).toBe("mock response text here");
  });
});
