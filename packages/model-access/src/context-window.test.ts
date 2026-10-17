import { APICallError } from "ai";
import type { ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import { contextOverflowOf, contextPreflight, projectTurnInput } from "./context-window.js";
import { ContextBudgetExceeded, ProviderError } from "./errors.js";
import { LLMGateway } from "./gateway.js";
import type { ModelConfig, ProviderRequest } from "./types.js";

/** Two bytes a token, the estimate context-window.ts makes of unmeasured input. */
const estimatedTokens = (bytes: number): number => Math.ceil(bytes / 2);

describe("contextPreflight: last input + new tail > window - output reserve", () => {
  const WINDOW = 10_000;
  const RESERVE = 2_000;

  test("input of exactly the window less the reserve fits; one token more is context_budget_exceeded", () => {
    const at = (lastInputTokens: number, tailTokens: number) =>
      contextPreflight({ kind: "reported-plus-tail", lastInputTokens, tailTokens }, WINDOW, RESERVE);
    expect(at(7_000, 1_000)).toEqual({ kind: "fits", projectedInputTokens: 8_000, limitTokens: 8_000 });
    expect(at(7_000, 1_001)).toEqual({ kind: "context_budget_exceeded", projectedInputTokens: 8_001, limitTokens: 8_000 });
    expect(at(8_001, 0).kind).toBe("context_budget_exceeded");
  });

  test("a whole-request estimate is judged against the same limit", () => {
    expect(contextPreflight({ kind: "estimated", tokens: 8_000 }, WINDOW, RESERVE).kind).toBe("fits");
    expect(contextPreflight({ kind: "estimated", tokens: 8_001 }, WINDOW, RESERVE).kind).toBe("context_budget_exceeded");
  });
});

describe("projectTurnInput", () => {
  const assistant: ModelMessage = { role: "assistant", content: [{ type: "text", text: "a".repeat(40) }] };
  const tool: ModelMessage = {
    role: "tool",
    content: [{ type: "tool-result", toolCallId: "t1", toolName: "read_file", output: { type: "text", value: "b".repeat(400) } }],
  };
  const request = { system: "s".repeat(1000), messages: [{ role: "user", content: "go" }, assistant, tool] satisfies ModelMessage[], tools: {} };

  test("starts from the previous request's reported input and estimates only what came after its answer", () => {
    const projection = projectTurnInput(5_000, request);
    expect(projection).toEqual({ kind: "reported-plus-tail", lastInputTokens: 5_000, tailTokens: estimatedTokens(Buffer.byteLength(JSON.stringify([assistant, tool]))) });
  });

  test("with no reported input, the whole request is estimated: unmeasured is never read as 0", () => {
    const projection = projectTurnInput(null, request);
    expect(projection.kind).toBe("estimated");
    if (projection.kind !== "estimated") return;
    expect(projection.tokens).toBeGreaterThan(estimatedTokens(1000));
  });
});

/** An HTTP error response as a provider adapter reports it: a status and the provider's own body. */
function httpError(statusCode: number, body: unknown): APICallError {
  return new APICallError({
    message: "Bad Request",
    url: "https://provider.invalid/v1",
    requestBodyValues: {},
    statusCode,
    responseBody: JSON.stringify(body),
    isRetryable: false,
  });
}

describe("contextOverflowOf: the provider's error data, never its name", () => {
  test.each([
    ["an error code", { error: { code: "context_length_exceeded", message: "Input too long." } }],
    ["a maximum-context message", { error: { message: "This model's maximum context length is 65536 tokens. However, you requested 70000 tokens." } }],
    ["a prompt-too-long message", { type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 210000 tokens > 200000 maximum" } }],
    ["an error type", { error: { type: "exceed_context_size_error", message: "request too large" } }],
  ])("reads a 400 whose body states the overflow by %s", (_how, body) => {
    expect(contextOverflowOf(new Error("wrapped", { cause: httpError(400, body) }))).not.toBeNull();
  });

  test("another 400, a 5xx with the same words, and an error with no provider response are not overflow", () => {
    expect(contextOverflowOf(httpError(400, { error: { message: "temperature must be at most 2" } }))).toBeNull();
    expect(contextOverflowOf(httpError(500, { error: { message: "maximum context length" } }))).toBeNull();
    expect(contextOverflowOf(httpError(400, "not json"))).toBeNull();
    expect(contextOverflowOf(new Error("socket hang up"))).toBeNull();
  });
});

describe("an agent turn that does not fit its window", () => {
  const MODEL: ModelConfig = {
    id: "any-model",
    apiModelId: "any-model",
    provider: "any",
    capabilityLevel: "Strong",
    inputCostPer1M: 1,
    outputCostPer1M: 2,
    maxContextTokens: 40_000,
    cacheReadCostPer1M: null,
    cacheWriteCostPer1M: null,
    priceWindows: [],
    priceTiers: [],
  };

  function gatewayWith(model: MockLanguageModelV4) {
    const gateway = new LLMGateway(
      { providers: [{ name: "any", providerType: "openai-compatible", apiKey: "k", baseUrl: "https://provider.invalid/v1", models: [MODEL], enabled: true }], defaultProvider: "any" },
      () => new Date("2026-10-17T00:00:00Z"),
      () => model,
    );
    const admitted: ProviderRequest[] = [];
    const port = gateway.gated("agent-runner", { admit: async (request) => void admitted.push(request), settle: async () => {} });
    return { gateway, port, admitted };
  }

  function turnOf(gateway: LLMGateway, priorInputTokens: number | null, messages: ModelMessage[]) {
    return {
      model: gateway.resolveModel("Strong", "agent-runner"),
      system: "You are a worker.",
      messages,
      tools: {},
      abortSignal: new AbortController().signal,
      priorInputTokens,
    };
  }

  const answered: ModelMessage = { role: "assistant", content: [{ type: "text", text: "next" }] };

  test("is refused before it is admitted when the last input and the new tail leave no room for the output reserve", async () => {
    const model = new MockLanguageModelV4();
    const { gateway, port, admitted } = gatewayWith(model);
    // The turn's output reserve is 16,384 tokens, so 40,000 - 16,384 = 23,616 tokens of input fit.
    const error = await port.generateTurn(turnOf(gateway, 23_616, [{ role: "user", content: "go" }, answered])).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ContextBudgetExceeded);
    expect(error).toMatchObject({ context: { provider: "any", model: "any-model", windowTokens: 40_000, outputReserveTokens: 16_384, breach: { source: "preflight" } } });
    expect(admitted).toEqual([]);
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  test("a provider's overflow rejection ends it as the same typed error, not a provider failure", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw httpError(400, { error: { code: "context_length_exceeded", message: "Input exceeds the context window." } });
      },
    });
    const { gateway, port, admitted } = gatewayWith(model);
    const error = await port.generateTurn(turnOf(gateway, null, [{ role: "user", content: "go" }])).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ContextBudgetExceeded);
    expect(error).not.toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ context: { breach: { source: "provider" } } });
    expect(admitted).toHaveLength(1);
  });
});
