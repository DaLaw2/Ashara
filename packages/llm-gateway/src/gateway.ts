import { generateObject, generateText, streamText, jsonSchema } from "ai";
import type { ToolSet } from "ai";
import { extractJson } from "@ashara/shared";
import type { CapabilityLevel } from "@ashara/shared";
import { BudgetLedger } from "./budget-ledger.js";
import { BudgetExceededError, ProviderError, SchemaValidationError } from "./errors.js";
import { calculateCost } from "./pricing.js";
import type { ResolvedProvider } from "./provider-registry.js";
import { ProviderRegistry } from "./provider-registry.js";
import { convertMessage, buildCacheProviderOptions, mapFinishReason } from "./message-conversion.js";
import type {
  CompletionRequest,
  CompletionResponse,
  CostBreakdown,
  CostSummary,
  GatewayConfig,
  LLMCallRecord,
  ModelConfig,
  StreamOptions,
  StructuredRequest,
  StructuredResponse,
  ToolCall,
  TokenUsage,
} from "./types.js";

export class LLMGateway {
  private readonly registry: ProviderRegistry;
  private readonly budgetLedger: BudgetLedger;
  private readonly budget: GatewayConfig["budget"];
  private readonly logSink?: (record: LLMCallRecord) => void;

  constructor(
    config: GatewayConfig,
    ledger: BudgetLedger = new BudgetLedger(),
    logSink?: (record: LLMCallRecord) => void,
  ) {
    this.registry = new ProviderRegistry(config);
    this.budgetLedger = ledger;
    this.budget = config.budget;
    this.logSink = logSink;
  }

  /**
   * Resolves a provider/model for `capability`/`site` and checks the budget,
   * degrading ONCE if a per-provider cap trips (routing-profiles story:
   * fail-degrade instead of fail-call for provider caps, distinct from the
   * total-budget cap which still fails the call outright). Shared by
   * `complete`/`streamComplete`/`generateStructured` so the degrade logic
   * exists in exactly one place.
   */
  private resolveWithBudgetDegrade(
    capability: CapabilityLevel,
    site: string | undefined,
  ): ResolvedProvider {
    const resolved = this.registry.resolve(capability, [], site);
    try {
      this.checkBudget(resolved.providerName);
      return resolved;
    } catch (err) {
      if (!(err instanceof BudgetExceededError) || !err.provider) {
        throw err;
      }

      const degraded = this.registry.resolveFallback(capability, err.provider, site);
      if (!degraded) {
        throw err;
      }

      console.warn(
        `[LLMGateway] provider budget cap tripped (provider=${err.provider}, cap=$${err.budget.toFixed(4)}), ` +
          `degrading to provider=${degraded.providerName} model=${degraded.modelConfig.id} ` +
          `for site=${site ?? "none"} (one-hop budget-degrade)`,
      );

      // Bounded to exactly one hop: re-check WITHOUT catching. If the
      // degraded provider (or the total budget) also trips here, the typed
      // BudgetExceededError propagates and the call fails closed.
      this.checkBudget(degraded.providerName);
      return degraded;
    }
  }

  private checkBudget(provider: string): void {
    if (!this.budget) return;

    if (this.budgetLedger.isOverBudget(this.budget.maxCostTotal)) {
      throw new BudgetExceededError(
        "total",
        this.budgetLedger.totalSpent(),
        this.budget.maxCostTotal,
      );
    }

    const providerCap = this.budget.maxCostPerProvider?.[provider];
    if (providerCap !== undefined && this.budgetLedger.isProviderOverBudget(provider, providerCap)) {
      throw new BudgetExceededError(
        `provider:${provider}`,
        this.budgetLedger.providerSpent(provider),
        providerCap,
        { provider },
      );
    }
  }

  private recordCost(usage: TokenUsage, model: ModelConfig, provider: string): CostBreakdown {
    const cost = calculateCost(
      usage.inputTokens,
      usage.outputTokens,
      usage.cacheReadTokens,
      usage.cacheWriteTokens,
      model,
    );
    this.budgetLedger.record(cost.totalCost, provider);
    return cost;
  }

  /**
   * Builds the call-shape params shared by generateText/streamText (system
   * prompt incl. cache-prefix splitting, temperature, tools, toolChoice,
   * strict-mode providerOptions) — everything except the model-family-specific
   * fields (`messages`/`maxOutputTokens`/`onChunk`) each caller still sets
   * itself. Loosely typed to match the "ai" SDK interop boundary the two
   * callers already cast through.
   */
  private buildCommonParams(request: CompletionRequest, resolved: ResolvedProvider): Record<string, unknown> {
    const params: Record<string, unknown> = {};

    if (request.cachePrefixLength && request.systemPrompt) {
      const staticPart = request.systemPrompt.slice(0, request.cachePrefixLength);
      const dynamicPart = request.systemPrompt.slice(request.cachePrefixLength);
      const cacheOptions = buildCacheProviderOptions(resolved.providerName);
      params.system = [
        {
          role: "system" as const,
          content: staticPart,
          ...(cacheOptions ? { providerOptions: cacheOptions } : {}),
        },
        ...(dynamicPart ? [{ role: "system" as const, content: dynamicPart }] : []),
      ];
    } else {
      params.system = request.systemPrompt;
    }

    if (request.temperature !== undefined) {
      params.temperature = request.temperature;
    }

    if (request.tools && request.tools.length > 0) {
      const tools: ToolSet = {};
      for (const td of request.tools) {
        tools[td.name] = {
          description: td.description,
          inputSchema: jsonSchema(td.parameters as Record<string, unknown>),
        };
      }
      params.tools = tools;

      if (request.toolChoice !== undefined) {
        params.toolChoice = request.toolChoice;
      }
    }

    if (resolved.modelConfig.strictMode) {
      params.providerOptions = { openai: { strictJsonSchema: true } };
    }

    return params;
  }

  /**
   * Shared "resolve → try → catch → fallback → retry once" shape for
   * complete/streamComplete/generateStructured: run `execute` against
   * `resolved`; on failure, resolve one fallback provider and retry once,
   * or throw a typed ProviderError if none is available. `shouldRethrow`
   * lets a caller (generateStructured) opt an error class out of the
   * fallback retry and propagate it immediately instead.
   */
  private async withFallback<TRequest extends { capability: CapabilityLevel; site?: string }, TResult>(
    request: TRequest,
    resolved: ResolvedProvider,
    execute: (request: TRequest, resolved: ResolvedProvider) => Promise<TResult>,
    label: string,
    shouldRethrow?: (error: unknown) => boolean,
  ): Promise<TResult> {
    try {
      return await execute(request, resolved);
    } catch (error) {
      if (shouldRethrow?.(error)) throw error;

      const fallback = this.registry.resolveFallback(
        request.capability,
        resolved.providerName,
        request.site,
      );
      if (!fallback) {
        const rootMsg = error instanceof Error ? error.message : String(error);
        throw new ProviderError(
          resolved.providerName,
          `${label} failed (${rootMsg}) and no fallback available`,
          { cause: error },
        );
      }

      return await execute(request, fallback);
    }
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const resolved = this.resolveWithBudgetDegrade(request.capability, request.site);
    return this.withFallback(request, resolved, (req, r) => this.executeCall(req, r), "request");
  }

  private async executeCall(
    request: CompletionRequest,
    resolved: ResolvedProvider,
  ): Promise<CompletionResponse> {
    const t0 = Date.now();
    const messages = request.messages.map((m) => convertMessage(m));

    // TODO: remove cast when AI SDK types are properly mapped
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const generateParams: Parameters<typeof generateText>[0] = {
      model: resolved.provider,
      messages: messages as any,
      maxOutputTokens: request.maxTokens,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(this.buildCommonParams(request, resolved) as any),
    };

    const result = await generateText(generateParams);

    const usage = extractUsage(result.usage, result.providerMetadata);

    const cost = this.recordCost(usage, resolved.modelConfig, resolved.providerName);

    let toolCalls: ToolCall[] | undefined;
    if (result.toolCalls && result.toolCalls.length > 0) {
      toolCalls = result.toolCalls.map((tc) => ({
        id: tc.toolCallId,
        name: tc.toolName,
        input: (tc.input ?? {}) as Record<string, unknown>,
      }));
    }

    const finishReason = mapFinishReason(result.finishReason);

    this.emitLogRecord(request.site ?? "unknown", request.capability, resolved, extractPromptExcerpt(request), result.text, usage, cost.totalCost, t0);

    return {
      content: result.text,
      reasoningContent: result.reasoningText ?? undefined,
      toolCalls,
      usage,
      cost,
      provider: resolved.providerName,
      model: resolved.modelConfig.id,
      finishReason,
    };
  }

  async streamComplete(
    request: CompletionRequest,
    options?: StreamOptions,
  ): Promise<CompletionResponse> {
    const resolved = this.resolveWithBudgetDegrade(request.capability, request.site);
    return this.withFallback(
      request,
      resolved,
      (req, r) => this.executeStreamCall(req, r, options),
      "stream request",
    );
  }

  private async executeStreamCall(
    request: CompletionRequest,
    resolved: ResolvedProvider,
    options?: StreamOptions,
  ): Promise<CompletionResponse> {
    const t0 = Date.now();
    const messages = request.messages.map((m) => convertMessage(m));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const streamParams: Parameters<typeof streamText>[0] = {
      model: resolved.provider,
      messages: messages as any,
      maxOutputTokens: request.maxTokens,
      onChunk({ chunk }) {
        if (chunk.type === "tool-call" && options?.onToolCall) {
          options.onToolCall({
            id: chunk.toolCallId,
            name: chunk.toolName,
            input: (chunk.input ?? {}) as Record<string, unknown>,
          });
        }
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(this.buildCommonParams(request, resolved) as any),
    };

    const result = streamText(streamParams);

    const [text, streamToolCalls, sdkUsage, providerMetadata, finishReason, reasoningText] = await Promise.all([
      result.text,
      result.toolCalls,
      result.usage,
      result.providerMetadata,
      result.finishReason,
      result.reasoningText,
    ]);

    const usage = extractUsage(sdkUsage, providerMetadata as Record<string, Record<string, unknown>> | undefined);

    const cost = this.recordCost(usage, resolved.modelConfig, resolved.providerName);

    let toolCalls: ToolCall[] | undefined;
    if (streamToolCalls && streamToolCalls.length > 0) {
      toolCalls = streamToolCalls.map((tc) => ({
        id: tc.toolCallId,
        name: tc.toolName,
        input: (tc.input ?? {}) as Record<string, unknown>,
      }));
    }

    this.emitLogRecord(request.site ?? "unknown", request.capability, resolved, extractPromptExcerpt(request), text, usage, cost.totalCost, t0);

    return {
      content: text,
      reasoningContent: reasoningText ?? undefined,
      toolCalls,
      usage,
      cost,
      provider: resolved.providerName,
      model: resolved.modelConfig.id,
      finishReason: mapFinishReason(finishReason),
    };
  }

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResponse<T>> {
    const resolved = this.resolveWithBudgetDegrade(request.capability, request.site);
    return this.withFallback(
      request,
      resolved,
      (req, r) => this.executeStructuredCall(req, r),
      "structured request",
      (error) => error instanceof SchemaValidationError,
    );
  }

  private async executeStructuredCall<T>(
    request: StructuredRequest<T>,
    resolved: ResolvedProvider,
  ): Promise<StructuredResponse<T>> {
    const t0 = Date.now();
    if (this.providerSupportsStructuredOutput(resolved.providerName)) {
      try {
        return await this.executeGenerateObject(request, resolved, t0);
      } catch (err) {
        console.warn(`[LLMGateway] generateObject failed, falling back to text extraction:`, err instanceof Error ? err.message : err);
      }
    }
    return await this.executeTextFallback(request, resolved, 2, t0);
  }

  private providerSupportsStructuredOutput(providerName: string): boolean {
    return providerName === "anthropic" || providerName === "openai";
  }

  private async executeGenerateObject<T>(
    request: StructuredRequest<T>,
    resolved: ResolvedProvider,
    t0: number,
  ): Promise<StructuredResponse<T>> {
    const params: Parameters<typeof generateObject>[0] = {
      model: resolved.provider,
      schema: request.schema,
      prompt: request.prompt,
      system: request.systemPrompt,
      maxOutputTokens: request.maxTokens,
    };
    if (request.temperature !== undefined) {
      params.temperature = request.temperature;
    }

    const result = await generateObject(params);

    const usage = extractUsage(result.usage, result.providerMetadata);
    const cost = this.recordCost(usage, resolved.modelConfig, resolved.providerName);

    const responseExcerpt = JSON.stringify(result.object).slice(0, 200);
    this.emitLogRecord(request.site ?? "unknown", request.capability, resolved, request.prompt.slice(0, 200), responseExcerpt, usage, cost.totalCost, t0);

    return {
      data: result.object as T,
      usage,
      cost,
      provider: resolved.providerName,
      model: resolved.modelConfig.id,
    };
  }

  private async executeTextFallback<T>(
    request: StructuredRequest<T>,
    resolved: ResolvedProvider,
    maxRetries = 2,
    t0: number = Date.now(),
  ): Promise<StructuredResponse<T>> {
    let lastErrors: string[] = [];
    let lastRawResponse = "";
    const jsonSuffix = "\n\nRespond with valid JSON only. No markdown, no explanation.";

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let currentPrompt: string;
      if (attempt === 0) {
        currentPrompt = request.prompt + jsonSuffix;
      } else {
        currentPrompt =
          request.prompt +
          jsonSuffix +
          "\n\nYour previous response was not valid JSON. Return ONLY a JSON object matching the schema." +
          `\n\nPrevious errors: ${lastErrors.join("; ")}` +
          `\n\nYour previous response (truncated):\n${lastRawResponse.slice(0, 500)}`;
      }

      const params: Parameters<typeof generateText>[0] = {
        model: resolved.provider,
        prompt: currentPrompt,
        system: request.systemPrompt,
        maxOutputTokens: request.maxTokens,
      };
      if (request.temperature !== undefined) {
        params.temperature = request.temperature;
      }

      const result = await generateText(params);
      lastRawResponse = result.text;

      const usage = extractUsage(result.usage, result.providerMetadata);
      const cost = this.recordCost(usage, resolved.modelConfig, resolved.providerName);

      const jsonText = extractJson(result.text);
      let parsed: unknown;
      try {
        parsed = JSON.parse(jsonText);
      } catch {
        lastErrors = [`Invalid JSON: ${jsonText.slice(0, 100)}`];
        continue;
      }

      const validation = request.schema.safeParse(parsed);
      if (validation.success) {
        const responseExcerpt = JSON.stringify(validation.data).slice(0, 200);
        this.emitLogRecord(request.site ?? "unknown", request.capability, resolved, request.prompt.slice(0, 200), responseExcerpt, usage, cost.totalCost, t0);
        return {
          data: validation.data,
          usage,
          cost,
          provider: resolved.providerName,
          model: resolved.modelConfig.id,
        };
      }

      lastErrors = validation.error.issues.map(
        (issue) => `${issue.path.join(".")}: ${issue.message}`,
      );
    }

    throw new SchemaValidationError(
      [...lastErrors, `Raw LLM response: ${lastRawResponse.slice(0, 500)}`],
    );
  }

  private emitLogRecord(
    site: string,
    capability: CapabilityLevel,
    resolved: ResolvedProvider,
    promptExcerpt: string,
    responseExcerpt: string,
    usage: TokenUsage,
    costUsd: number,
    t0: number,
  ): void {
    this.logSink?.({
      site,
      capability,
      model: resolved.modelConfig.id,
      provider: resolved.providerName,
      promptExcerpt: promptExcerpt.slice(0, 200),
      responseExcerpt: responseExcerpt.slice(0, 200),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd,
      durationMs: Date.now() - t0,
      timestamp: new Date().toISOString(),
    });
  }

  getCostSummary(): CostSummary {
    return {
      totalCost: this.budgetLedger.totalSpent(),
      costByProvider: this.budgetLedger.providerBreakdown(),
    };
  }
}

function extractPromptExcerpt(request: CompletionRequest): string {
  const lastUserMsg = [...request.messages].reverse().find((m) => m.role === "user");
  if (!lastUserMsg) return "";
  const text = typeof lastUserMsg.content === "string"
    ? lastUserMsg.content
    : lastUserMsg.content.find((b) => b.type === "text")?.text ?? "";
  return text.slice(0, 200);
}

function extractUsage(
  sdkUsage: { inputTokens?: number; outputTokens?: number } | undefined,
  providerMetadata: Record<string, Record<string, unknown>> | undefined,
): TokenUsage {
  const usage: TokenUsage = {
    inputTokens: sdkUsage?.inputTokens ?? 0,
    outputTokens: sdkUsage?.outputTokens ?? 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };

  if (providerMetadata?.["anthropic"]) {
    const anthropicMeta = providerMetadata["anthropic"] as Record<string, unknown>;
    if (typeof anthropicMeta["cacheReadInputTokens"] === "number") {
      usage.cacheReadTokens = anthropicMeta["cacheReadInputTokens"];
    }
    if (typeof anthropicMeta["cacheCreationInputTokens"] === "number") {
      usage.cacheWriteTokens = anthropicMeta["cacheCreationInputTokens"];
    }
  }

  return usage;
}
