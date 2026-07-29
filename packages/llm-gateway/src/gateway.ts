import { generateObject, generateText, streamText, jsonSchema } from "ai";
import type { CallWarning, ModelMessage, ToolSet } from "ai";
import { extractJson } from "@ashara/shared";
import type { CapabilityLevel } from "@ashara/shared";
import { BudgetLedger } from "./budget-ledger.js";
import {
  BudgetExceededError,
  ProviderError,
  SchemaValidationError,
  TemperatureNotHonored,
} from "./errors.js";
import { calculateCost } from "./pricing.js";
import type { ResolvedProvider } from "./provider-registry.js";
import { ProviderRegistry } from "./provider-registry.js";
import { convertMessage, buildCacheProviderOptions, mapFinishReason } from "./message-conversion.js";
import type {
  CompletionRequest,
  CompletionResponse,
  CostBreakdown,
  CostSummary,
  ExtractedUsage,
  GatewayConfig,
  KnownLLMSite,
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
    site: KnownLLMSite | undefined,
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

  /**
   * Records the cost of a completed call in the gateway's in-process budget
   * ledger.  When usage is unmeasured, no entry is written — the gateway
   * ledger cannot produce a pessimistic estimate (the capability-based
   * estimator lives in the orchestrator's `BudgetTracker.unknownCostCharge`),
   * and recording $0 would be the identity-element defect this change exists
   * to eliminate.
   */
  private recordCost(extraction: ExtractedUsage, model: ModelConfig, provider: string): CostBreakdown {
    if (!extraction.measured) {
      return { inputCost: 0, outputCost: 0, cacheSavings: 0, totalCost: 0, measured: false };
    }
    const cost = calculateCost(
      extraction.usage.inputTokens,
      extraction.usage.outputTokens,
      extraction.usage.cacheReadTokens,
      extraction.usage.cacheWriteTokens,
      model,
    );
    this.budgetLedger.record(cost.totalCost, provider);
    return { ...cost, measured: true };
  }

  /**
   * Discipline C structured warning for unmeasured usage (Discipline A: the
   * throw that used to live here was strictly worse — it lost the first call's
   * accounting AND discarded a successful completion AND paid for a fallback
   * retry). Logs at `warn` with the provider, model, site, operation, and
   * which SDK fields were absent.
   */
  private warnUnmeasuredUsage(
    extraction: ExtractedUsage,
    provider: string,
    model: string,
    site: string,
    operation: string,
  ): void {
    if (extraction.measured) return;
    console.warn(
      `[LLMGateway] unmeasured usage: provider=${provider}, model=${model}, ` +
        `site=${site}, operation=${operation}, ` +
        `missingFields=[${extraction.missingFields.join(", ")}]. ` +
        `Token counts are zero-filled; the cost for this call is an estimate, ` +
        `not a measurement. The orchestrator's pessimistic charge path ` +
        `(BudgetTracker.unknownCostCharge) handles the real budget accounting.`,
    );
  }

  /**
   * Builds the call-shape params shared by generateText/streamText (system
   * prompt incl. cache-prefix splitting, temperature, tools, toolChoice,
   * strict-mode providerOptions) — everything except the model-family-specific
   * fields (`messages`/`maxOutputTokens`/`onChunk`) each caller still sets
   * itself. Loosely typed to match the "ai" SDK interop boundary the two
   * callers already cast through.
   */
  // open-by-design: AI SDK interop boundary — param shape varies per provider/feature combination
  private buildCommonParams(request: CompletionRequest, resolved: ResolvedProvider): Record<string, unknown> {
    const params: Record<string, unknown> = {}; // open-by-design (see method comment above)

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
          // open-by-design: tool parameters is a JSON Schema object, shape defined per tool
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
   * lets a caller opt an error class out of the fallback retry and propagate
   * it immediately instead — generateStructured does so for
   * SchemaValidationError, and all three do for TemperatureNotHonored, whose
   * whole point is that the next model may drop the parameter just as
   * silently (the fallback is resolved by capability, which knows nothing
   * about sampling-parameter support).
   */
  private async withFallback<TRequest extends { capability: CapabilityLevel; site?: KnownLLMSite }, TResult>(
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
    return this.withFallback(
      request,
      resolved,
      (req, r) => this.executeCall(req, r),
      "request",
      isTemperatureViolation,
    );
  }

  private async executeCall(
    request: CompletionRequest,
    resolved: ResolvedProvider,
  ): Promise<CompletionResponse> {
    const t0 = Date.now();
    const messages = request.messages.map((m) => convertMessage(m));

    const result = await generateText({
      model: resolved.provider,
      messages: messages as unknown as ModelMessage[],
      maxOutputTokens: request.maxTokens,
      ...this.buildCommonParams(request, resolved),
    } as Parameters<typeof generateText>[0]);

    const extraction = extractUsage(result.usage, result.providerMetadata);
    this.warnUnmeasuredUsage(extraction, resolved.providerName, resolved.modelConfig.id, request.site ?? "unknown", "generateText");

    const cost = this.recordCost(extraction, resolved.modelConfig, resolved.providerName);

    // Asserted AFTER recordCost at every call site: the tokens were spent
    // whether or not the parameter was honored, so failing closed must not
    // also lose the budget accounting for the call that failed.
    // `result.warnings` aggregates every step, so the tool loop is covered.
    assertTemperatureHonored({
      requestedTemperature: request.temperature,
      warnings: result.warnings,
      provider: resolved.providerName,
      model: resolved.modelConfig.id,
      site: request.site,
      operation: "generateText",
    });

    let toolCalls: ToolCall[] | undefined;
    if (result.toolCalls && result.toolCalls.length > 0) {
      // open-by-design: LLM-authored tool arguments, shape varies per tool
      toolCalls = result.toolCalls.map((tc) => ({
        id: tc.toolCallId,
        name: tc.toolName,
        input: (tc.input ?? {}) as Record<string, unknown>, // open-by-design
      }));
    }

    const finishReason = mapFinishReason(result.finishReason);

    this.emitLogRecord(request.site ?? "unknown", request.capability, resolved, extractPromptExcerpt(request), result.text, extraction.usage, cost.totalCost, t0);

    return {
      content: result.text,
      reasoningContent: result.reasoningText ?? undefined,
      toolCalls,
      usage: extraction.usage,
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
      isTemperatureViolation,
    );
  }

  private async executeStreamCall(
    request: CompletionRequest,
    resolved: ResolvedProvider,
    options?: StreamOptions,
  ): Promise<CompletionResponse> {
    const t0 = Date.now();
    const messages = request.messages.map((m) => convertMessage(m));

    const result = streamText({
      model: resolved.provider,
      messages: messages as unknown as ModelMessage[],
      maxOutputTokens: request.maxTokens,
      onChunk({ chunk }) {
        if (chunk.type === "tool-call" && options?.onToolCall) {
          options.onToolCall({
            id: chunk.toolCallId,
            name: chunk.toolName,
            // open-by-design: LLM-authored tool arguments, shape varies per tool
            input: (chunk.input ?? {}) as Record<string, unknown>,
          });
        }
      },
      ...this.buildCommonParams(request, resolved),
    } as Parameters<typeof streamText>[0]);

    const [text, streamToolCalls, sdkUsage, providerMetadata, finishReason, reasoningText, warnings] = await Promise.all([
      result.text,
      result.toolCalls,
      result.usage,
      result.providerMetadata,
      result.finishReason,
      result.reasoningText,
      result.warnings,
    ]);

    // contract-erasing: providerMetadata carries provider-specific cache token counts (e.g. anthropic.cacheReadInputTokens)
    const extraction = extractUsage(sdkUsage, providerMetadata as Record<string, Record<string, unknown>> | undefined);
    this.warnUnmeasuredUsage(extraction, resolved.providerName, resolved.modelConfig.id, request.site ?? "unknown", "streamText");

    const cost = this.recordCost(extraction, resolved.modelConfig, resolved.providerName);

    assertTemperatureHonored({
      requestedTemperature: request.temperature,
      warnings,
      provider: resolved.providerName,
      model: resolved.modelConfig.id,
      site: request.site,
      operation: "streamText",
    });

    let toolCalls: ToolCall[] | undefined;
    if (streamToolCalls && streamToolCalls.length > 0) {
      // open-by-design: LLM-authored tool arguments, shape varies per tool
      toolCalls = streamToolCalls.map((tc) => ({
        id: tc.toolCallId,
        name: tc.toolName,
        input: (tc.input ?? {}) as Record<string, unknown>, // open-by-design
      }));
    }

    this.emitLogRecord(request.site ?? "unknown", request.capability, resolved, extractPromptExcerpt(request), text, extraction.usage, cost.totalCost, t0);

    return {
      content: text,
      reasoningContent: reasoningText ?? undefined,
      toolCalls,
      usage: extraction.usage,
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
      (error) => error instanceof SchemaValidationError || isTemperatureViolation(error),
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
        // The text fallback exists for models whose STRUCTURED-OUTPUT mode is
        // unusable; it retries the same model, so it cannot recover a dropped
        // temperature and would only buy a second identical violation.
        if (err instanceof TemperatureNotHonored) throw err;
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

    const extraction = extractUsage(result.usage, result.providerMetadata);
    this.warnUnmeasuredUsage(extraction, resolved.providerName, resolved.modelConfig.id, request.site ?? "unknown", "generateObject");
    const cost = this.recordCost(extraction, resolved.modelConfig, resolved.providerName);

    assertTemperatureHonored({
      requestedTemperature: request.temperature,
      warnings: result.warnings,
      provider: resolved.providerName,
      model: resolved.modelConfig.id,
      site: request.site,
      operation: "generateObject",
    });

    const responseExcerpt = JSON.stringify(result.object).slice(0, 200);
    this.emitLogRecord(request.site ?? "unknown", request.capability, resolved, request.prompt.slice(0, 200), responseExcerpt, extraction.usage, cost.totalCost, t0);

    return {
      data: result.object as T,
      usage: extraction.usage,
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

      const extraction = extractUsage(result.usage, result.providerMetadata);
      this.warnUnmeasuredUsage(extraction, resolved.providerName, resolved.modelConfig.id, request.site ?? "unknown", "generateText:structured-fallback");
      const cost = this.recordCost(extraction, resolved.modelConfig, resolved.providerName);

      // Throws OUT of the retry loop rather than `continue`-ing: a dropped
      // temperature is a property of the model, not a transient malformation,
      // so every remaining attempt would violate determinism identically while
      // burning the retry budget reserved for recoverable JSON failures.
      assertTemperatureHonored({
        requestedTemperature: request.temperature,
        warnings: result.warnings,
        provider: resolved.providerName,
        model: resolved.modelConfig.id,
        site: request.site,
        operation: "generateText:structured-fallback",
      });

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
        this.emitLogRecord(request.site ?? "unknown", request.capability, resolved, request.prompt.slice(0, 200), responseExcerpt, extraction.usage, cost.totalCost, t0);
        return {
          data: validation.data,
          usage: extraction.usage,
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

  resolveEffectiveCapability(capability: CapabilityLevel): CapabilityLevel {
    try {
      const resolved = this.registry.resolve(capability);
      return resolved.modelConfig.capabilityLevel;
    } catch {
      return capability;
    }
  }

  resolveFormatGroup(capability: CapabilityLevel): string | undefined {
    try {
      const resolved = this.registry.resolve(capability);
      return resolved.modelConfig.formatGroup;
    } catch {
      return undefined;
    }
  }
}

function isTemperatureViolation(error: unknown): boolean {
  return error instanceof TemperatureNotHonored;
}

function isTemperatureUnsupportedWarning(
  warning: CallWarning,
): warning is Extract<CallWarning, { type: "unsupported" }> {
  return warning.type === "unsupported" && warning.feature === "temperature";
}

export interface TemperatureHonoredCheck {
  /** `undefined` means the caller never asked for a temperature — nothing to honor. */
  readonly requestedTemperature: number | undefined;
  /** Structured provider warnings for the completed call; `undefined` when the SDK reported none. */
  readonly warnings: readonly CallWarning[] | undefined;
  readonly provider: string;
  readonly model: string;
  readonly site: KnownLLMSite | undefined;
  readonly operation: string;
}

/**
 * Fail-closed determinism gate shared by every SDK entry point (Discipline A).
 *
 * Matches on the provider-spec-level warning shape (`type: "unsupported"`,
 * `feature: "temperature"`) rather than on model or provider names: Anthropic
 * `rejectsSamplingParameters` models, Anthropic with thinking enabled, OpenAI
 * reasoning models and OpenAI search-preview models all emit exactly this
 * warning, and a name list would have to be re-derived every catalog change.
 *
 * Any requested temperature counts, not just 0 — "I asked for X and silently
 * got something else" is the violation regardless of X.
 */
export function assertTemperatureHonored(check: TemperatureHonoredCheck): void {
  if (check.requestedTemperature === undefined) return;

  const violation = check.warnings?.find(isTemperatureUnsupportedWarning);
  if (!violation) return;

  throw new TemperatureNotHonored({
    requestedTemperature: check.requestedTemperature,
    model: check.model,
    provider: check.provider,
    site: check.site ?? "unknown",
    operation: check.operation,
    details: violation.details,
    howToFix: TEMPERATURE_HOW_TO_FIX,
  });
}

const TEMPERATURE_HOW_TO_FIX =
  "Route this site to a model that honors sampling parameters (see [routing.profiles] in " +
  "config/models.toml), or stop requesting a temperature for this call if it does not need " +
  "determinism. Do not suppress this check — an ignored temperature makes a call the system " +
  "treats as deterministic silently non-deterministic.";

function extractPromptExcerpt(request: CompletionRequest): string {
  const lastUserMsg = [...request.messages].reverse().find((m) => m.role === "user");
  if (!lastUserMsg) return "";
  const text = typeof lastUserMsg.content === "string"
    ? lastUserMsg.content
    : lastUserMsg.content.find((b) => b.type === "text")?.text ?? "";
  return text.slice(0, 200);
}

/**
 * Extracts token usage from the SDK response, returning a discriminated
 * `ExtractedUsage` that separates measured from unmeasured values.
 *
 * Two levels of absence:
 * - **Object-level** (`sdkUsage` is falsy): unreachable per the AI SDK's types
 *   (`LanguageModelUsage` is non-optional on every result type). A defensive
 *   guard remains because the SDK is a trust boundary and TypeScript types
 *   cannot be enforced at runtime. Handled identically to field-level absence.
 * - **Field-level** (`inputTokens` or `outputTokens` is undefined): documented
 *   in the SDK contract (`inputTokens?: number` at `ai/dist/index.d.ts:324`).
 *   This is the branch that fires in practice.
 *
 * Neither branch throws. The throw that used to live here (MissingUsageError)
 * was caught by `withFallback`, which discarded the successful completion,
 * lost its cost accounting, and paid for a second call — strictly worse than
 * the `?? 0` it replaced.
 */
export function extractUsage(
  sdkUsage: { inputTokens?: number; outputTokens?: number } | undefined,
  // contract-erasing: providerMetadata carries provider-specific fields (e.g. anthropic cache tokens)
  providerMetadata: Record<string, Record<string, unknown>> | undefined,
): ExtractedUsage {
  // Object-level absence: unreachable per SDK types, guarded defensively
  // across the trust boundary. Not a separate error class — the same
  // "unmeasured" treatment applies, and adding a throw for the unreachable
  // case is exactly the defect this change removes.
  if (!sdkUsage) {
    return {
      measured: false,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      missingFields: ["sdkUsageObject"],
    };
  }

  // Field-level absence: documented in the SDK contract.
  // Guard structure uses direct undefined checks so TypeScript narrows the
  // fields to `number` on the happy path without non-null assertions.
  if (sdkUsage.inputTokens === undefined || sdkUsage.outputTokens === undefined) {
    const missingFields: string[] = [];
    if (sdkUsage.inputTokens === undefined) missingFields.push("inputTokens");
    if (sdkUsage.outputTokens === undefined) missingFields.push("outputTokens");
    return {
      measured: false,
      usage: {
        inputTokens: sdkUsage.inputTokens ?? 0,
        outputTokens: sdkUsage.outputTokens ?? 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      missingFields,
    };
  }

  const usage: TokenUsage = {
    inputTokens: sdkUsage.inputTokens,
    outputTokens: sdkUsage.outputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };

  if (providerMetadata?.["anthropic"]) {
    // contract-erasing: anthropic metadata has known fields (cacheReadInputTokens, cacheCreationInputTokens)
    const anthropicMeta = providerMetadata["anthropic"] as Record<string, unknown>;
    if (typeof anthropicMeta["cacheReadInputTokens"] === "number") {
      usage.cacheReadTokens = anthropicMeta["cacheReadInputTokens"];
    }
    if (typeof anthropicMeta["cacheCreationInputTokens"] === "number") {
      usage.cacheWriteTokens = anthropicMeta["cacheCreationInputTokens"];
    }
  }

  return { measured: true, usage };
}
