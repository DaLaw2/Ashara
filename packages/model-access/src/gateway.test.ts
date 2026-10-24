import { createDeepSeek } from "@ai-sdk/deepseek";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { LLMGateway, extractUsage, parseStructuredText, textStructuredPrompt } from "./gateway.js";
import { ROUTING_RULES } from "./routing-rules.js";
import { loadThinkingPolicyFromToml } from "./thinking.js";
import type { KnownLLMSite, ModelConfig, ProviderRequest } from "./types.js";
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

// A provider that answers in text receives no schema parameter: what the answer is validated against travels in the prompt.
describe("a structured request to a provider that answers in text", () => {
  const Schema = z.strictObject({ problems: z.array(z.strictObject({ kind: z.literal("undecided-item"), item: z.string(), evidence: z.string() })) });

  test("its prompt carries the JSON Schema the answer is validated against, every required property named", () => {
    const prompt = textStructuredPrompt("Review the checks.", Schema);
    expect(prompt.startsWith("Review the checks.\n\nRespond with valid JSON only.")).toBe(true);
    expect(prompt).toContain(`"required":["kind","item","evidence"]`);
    expect(prompt).toContain(`"additionalProperties":false`);
  });

  test("an answer that is not JSON names where the parser stopped and the text around it, for the re-ask", () => {
    const parsed = parseStructuredText(`{"problems": [{"kind": "undecided-item", "item": "S4", "evidence": "fsync \\$D"}]}`, Schema);
    if (parsed.ok) return expect.unreachable("an invalid escape is not JSON");
    expect(parsed.errorKind).toBe("InvalidJson");
    expect(parsed.errors[0]).toMatch(/^Invalid JSON \(Bad escaped character in JSON at position 75 /);
    expect(parsed.errors[0]).toContain(String.raw`\"evidence\": \"fsync \\" and from it "$D\"}]}"`);
  });

  test("an answer missing a required property names the property", () => {
    const parsed = parseStructuredText(`{"problems": [{"kind": "undecided-item", "item": "S4"}]}`, Schema);
    if (parsed.ok) return expect.unreachable("a missing property does not validate");
    expect(parsed).toMatchObject({ errorKind: "SchemaMismatch", errors: ["problems.0.evidence: Invalid input: expected string, received undefined"] });
  });
});

describe("the reasoning allowance of an escalated attempt", () => {
  const FLASH: ModelConfig = {
    id: "deepseek-flash-like",
    apiModelId: "deepseek-flash-like",
    provider: "deepseek",
    capabilityLevel: "Strong", thinkingOffCapabilityLevel: "Light",
    inputCostPer1M: 0.1,
    outputCostPer1M: 0.4,
    maxContextTokens: 1_000_000,
    cacheReadCostPer1M: null,
    cacheWriteCostPer1M: null,
    priceWindows: [],
    priceTiers: [], datedPrices: [],
  };
  const REPO_MODELS_TOML = new URL("../../../config/models.toml", import.meta.url).pathname;
  // The most deepseek-flash reasoned on one suite review.
  const MOST_SUITE_REVIEW_REASONING = 51_729;

  class Refused extends Error {}

  async function admittedBound(site: KnownLLMSite): Promise<ProviderRequest> {
    const admitted: ProviderRequest[] = [];
    const gateway = new LLMGateway(
      {
        providers: [{ name: "deepseek", providerType: "deepseek", apiKey: "k", models: [FLASH], enabled: true }],
        defaultProvider: "deepseek",
        contextOverflow: { statuses: [400], codes: ["context_length_exceeded"], phrases: [] },
        thinking: loadThinkingPolicyFromToml(REPO_MODELS_TOML),
      },
      () => new Date("2026-10-24T12:00:00Z"),
      (provider, modelConfig) => createDeepSeek({ apiKey: provider.apiKey })(modelConfig.apiModelId),
      ROUTING_RULES,
    );
    const call = gateway
      .gated("suite-review", {
        admit: async (request) => {
          admitted.push(request);
          throw new Refused("never sent");
        },
        settle: async () => {},
      })
      .generateStructured({ prompt: "review", schema: z.object({ ok: z.boolean() }), maxTokens: 16_200, site, capability: "Strong", abortSignal: new AbortController().signal });
    await expect(call).rejects.toBeInstanceOf(Refused);
    const [request] = admitted;
    if (request === undefined) return expect.unreachable("the gate saw no request");
    return request;
  }

  test.each<KnownLLMSite>(["suite-review", "escalation"])(
    "a suite review routed as %s to deepseek-flash keeps the suite-review allowance, with headroom over the most reasoning seen",
    async (site) => {
      const request = await admittedBound(site);
      expect(request.maxOutputTokens - 16_200).toBeGreaterThanOrEqual(Math.ceil(MOST_SUITE_REVIEW_REASONING * 1.25));
    },
  );
});
