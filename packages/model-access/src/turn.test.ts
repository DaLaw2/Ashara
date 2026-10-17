import { createAnthropic } from "@ai-sdk/anthropic";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { LLMGateway } from "./gateway.js";
import { cachedTurnPrompt, mapFinishReason, parseToolCalls } from "./turn.js";
import type { ModelConfig, SentProviderRequest } from "./types.js";

describe("Anthropic prompt caching on agent turns", () => {
  const SONNET: ModelConfig = {
    id: "sonnet-like",
    apiModelId: "claude-sonnet-like",
    provider: "anthropic",
    capabilityLevel: "Strong",
    inputCostPer1M: 3,
    outputCostPer1M: 15,
    maxContextTokens: 200_000,
    cacheReadCostPer1M: 0.3,
    cacheWriteCostPer1M: 3.75,
    priceWindows: [],
    priceTiers: [],
  };
  const CacheControlSchema = z.object({ type: z.literal("ephemeral") });
  const BlockSchema = z.looseObject({ cache_control: CacheControlSchema.optional() });
  const BodySchema = z.looseObject({
    system: z.array(BlockSchema),
    messages: z.array(z.looseObject({ role: z.string(), content: z.array(BlockSchema) })),
  });

  test("the request carries cache breakpoints on the system prompt and the conversation, and the row keeps both cache counts", async () => {
    const bodies: unknown[] = [];
    const fetchStub = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(typeof init?.body === "string" ? init.body : "null"));
      return new Response(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-like",
          content: [{ type: "tool_use", id: "toolu_2", name: "read_file", input: { path: "b.txt" } }],
          stop_reason: "tool_use",
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 300, cache_read_input_tokens: 600 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const recorded: SentProviderRequest[] = [];
    const gateway = new LLMGateway(
      {
        providers: [{ name: "anthropic", providerType: "anthropic", apiKey: "k", models: [SONNET], enabled: true }],
        defaultProvider: "anthropic",
      },
      () => new Date("2026-10-14T12:00:00Z"),
      (provider, modelConfig) => createAnthropic({ apiKey: provider.apiKey, fetch: fetchStub })(modelConfig.apiModelId),
    );

    await gateway
      .gated("agent-runner", { admit: async () => {}, settle: async (request) => void recorded.push(request) })
      .generateTurn({
        model: gateway.resolveModel("Strong", "agent-runner"),
        system: "You are a worker.",
        messages: [
          { role: "user", content: "Read a.txt then b.txt" },
          { role: "assistant", content: [{ type: "tool-call", toolCallId: "toolu_1", toolName: "read_file", input: { path: "a.txt" } }] },
          {
            role: "tool",
            content: [{ type: "tool-result", toolCallId: "toolu_1", toolName: "read_file", output: { type: "text", value: "A" } }],
          },
        ],
        tools: { read_file: { description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } } } } },
        abortSignal: new AbortController().signal,
        priorInputTokens: 1200,
      });

    const body = BodySchema.parse(bodies[0]);
    expect(body.system.at(-1)?.cache_control).toEqual({ type: "ephemeral" });
    const marked = body.messages.map((m) => m.content.some((block) => block.cache_control !== undefined));
    // The previous turn's last message (the user message before the assistant) and this turn's last message.
    expect(body.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(marked).toEqual([true, false, true]);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.usage?.reported).toMatchObject({ cacheReadTokens: 600, cacheWriteTokens: 300 });
  });

  test("any other provider type gets the system prompt and conversation unchanged", () => {
    const messages = [{ role: "user" as const, content: "hi" }];
    expect(cachedTurnPrompt("deepseek", "s", messages)).toEqual({ system: "s", messages });
  });
});

describe("mapFinishReason", () => {
  test("is total: a missing, `error` or undocumented finish reason is provider_error", () => {
    expect(mapFinishReason("length")).toBe("truncated");
    expect(mapFinishReason("tool-calls")).toBe("tool_calls");
    for (const absent of [undefined, null, "error", "unknown", 42]) {
      expect(mapFinishReason(absent)).toBe("provider_error");
    }
  });
});

describe("parseToolCalls", () => {
  const declared = { read_file: { description: "d", inputSchema: { type: "object" as const } } };

  test("an SDK-flagged invalid call is returned as invalid; an undeclared unflagged call is an issue", () => {
    const { toolCalls, issues } = parseToolCalls(
      [
        { toolCallId: "a", toolName: "nope", input: "{", invalid: true, error: new Error("no such tool") },
        { toolCallId: "b", toolName: "nope", input: {} },
        { toolName: "read_file", input: {} },
      ],
      declared,
    );
    expect(toolCalls).toEqual([
      { kind: "invalid", toolCallId: "a", toolName: "nope", input: "{", error: "Error: no such tool" },
    ]);
    expect(issues).toHaveLength(2);
  });
});
