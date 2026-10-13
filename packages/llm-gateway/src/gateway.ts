import { NoObjectGeneratedError, generateObject, generateText } from "ai";
import type { CallWarning, LanguageModel } from "ai";
import { z } from "zod";
import { extractJson } from "@ashara/shared";
import type { CapabilityLevel } from "@ashara/shared";
import { BudgetLedger } from "./budget-ledger.js";
import {
  BudgetExceededError,
  LlmCallContextMissing,
  LlmCallNotRecorded,
  LlmCallRecorderMissing,
  PreCallRefusal,
  ProviderError,
  SchemaValidationError,
  TemperatureNotHonored,
} from "./errors.js";
import { calculateCost } from "./pricing.js";
import type { ResolvedProvider } from "./provider-registry.js";
import { ProviderRegistry } from "./provider-registry.js";
import type { StructuredProvider } from "./reliability-ladder.js";
import type {
  CallRecording,
  CostBreakdown,
  CostSummary,
  ExtractedUsage,
  GatewayConfig,
  KnownLLMSite,
  LlmCallContext,
  LlmCallOperation,
  LlmCallOutcome,
  LlmCallRecorder,
  ModelConfig,
  StructuredRequest,
  StructuredResponse,
  TokenUsage,
} from "./types.js";

export interface ResolvedModel {
  model: LanguageModel;
  modelId: string;
  provider: string;
  modelConfig: ModelConfig;
  effectiveCapability: CapabilityLevel;
}

/** A structured provider scoped to one call context: every provider request it makes is recorded against it. */
export interface ContextualLlm {
  forCall(context: LlmCallContext): StructuredProvider;
}

/** The recorder and context of one recorded call; `null` on an unrecorded gateway. */
type CallScope = { readonly recorder: LlmCallRecorder; readonly context: LlmCallContext } | null;

const OK: LlmCallOutcome = { kind: "ok" };

function errorOutcome(error: unknown): LlmCallOutcome {
  return { kind: "error", errorKind: error instanceof Error ? error.name : typeof error };
}

export class LLMGateway implements ContextualLlm {
  private readonly registry: ProviderRegistry;
  private readonly budgetLedger: BudgetLedger;
  private readonly budget: GatewayConfig["budget"];
  private readonly recording: CallRecording;

  constructor(
    config: GatewayConfig,
    recording: CallRecording,
    ledger: BudgetLedger = new BudgetLedger(),
  ) {
    this.registry = new ProviderRegistry(config);
    this.budgetLedger = ledger;
    this.budget = config.budget;
    this.recording = recording;
  }

  /**
   * Resolves a provider/model for `capability`/`site` and checks the budget,
   * degrading ONCE if a per-provider cap trips (routing-profiles story:
   * fail-degrade instead of fail-call for provider caps, distinct from the
   * total-budget cap which still fails the call outright). Shared by every
   * entry point so the degrade logic exists in exactly one place.
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
   * Shared "resolve → try → catch → fallback → retry once" shape for
   * structured calls: run `execute` against `resolved`; on failure, resolve
   * one fallback provider and retry once, or throw a typed ProviderError if
   * none is available. `shouldRethrow` lets a caller opt an error class out of
   * the fallback retry and propagate it immediately instead —
   * SchemaValidationError, TemperatureNotHonored (the next model may drop the
   * parameter just as silently; the fallback is resolved by capability, which
   * knows nothing about sampling-parameter support), a pre-call refusal and a
   * failed ledger write.
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

  /**
   * The unrecorded entry point, for a process built with
   * `recording: { kind: "unrecorded" }`. A recording gateway refuses it: its
   * calls go through `forCall`, which carries the project they are charged to.
   */
  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResponse<T>> {
    if (this.recording.kind === "recorded") {
      throw new LlmCallContextMissing("generateStructured");
    }
    return this.structured(request, null);
  }

  /** The recorded entry point: every provider request made for `context` writes one row through the recorder. */
  forCall(context: LlmCallContext): StructuredProvider {
    if (this.recording.kind === "unrecorded") {
      throw new LlmCallRecorderMissing(this.recording.reason);
    }
    const scope: CallScope = { recorder: this.recording.recorder, context };
    return {
      generateStructured: <T>(request: StructuredRequest<T>) => this.structured(request, scope),
    };
  }

  private async structured<T>(request: StructuredRequest<T>, scope: CallScope): Promise<StructuredResponse<T>> {
    const resolved = this.resolveWithBudgetDegrade(request.capability, request.site);
    return this.withFallback(
      request,
      resolved,
      (req, r) => this.executeStructuredCall(req, r, scope),
      "structured request",
      (error) =>
        error instanceof SchemaValidationError || isTemperatureViolation(error) || isNeverRetried(error),
    );
  }

  private async executeStructuredCall<T>(
    request: StructuredRequest<T>,
    resolved: ResolvedProvider,
    scope: CallScope,
  ): Promise<StructuredResponse<T>> {
    if (this.providerSupportsStructuredOutput(resolved.providerName)) {
      try {
        return await this.executeGenerateObject(request, resolved, scope);
      } catch (err) {
        // The text fallback exists for models whose STRUCTURED-OUTPUT mode is
        // unusable; it retries the same model, so it cannot recover a dropped
        // temperature and would only buy a second identical violation.
        if (err instanceof TemperatureNotHonored || isNeverRetried(err)) throw err;
        console.warn(`[LLMGateway] generateObject failed, falling back to text extraction:`, err instanceof Error ? err.message : err);
      }
    }
    return await this.executeTextFallback(request, resolved, scope);
  }

  private providerSupportsStructuredOutput(providerName: string): boolean {
    return providerName === "anthropic" || providerName === "openai";
  }

  /**
   * Sends ONE provider request. The recorder's price check runs first, so a
   * refused model never reaches the network; a request that throws is
   * recorded as an error before the throw continues.
   */
  private async send<R>(
    scope: CallScope,
    resolved: ResolvedProvider,
    operation: LlmCallOperation,
    request: () => Promise<R>,
  ): Promise<R> {
    scope?.recorder.assertPriced(resolved.providerName, resolved.modelConfig);
    try {
      return await request();
    } catch (error) {
      await this.record(scope, resolved, operation, usageOfFailedRequest(error), errorOutcome(error), error);
      throw error;
    }
  }

  /** Writes the one row for a provider request. A failed write fails the call (Discipline A). */
  private async record(
    scope: CallScope,
    resolved: ResolvedProvider,
    operation: LlmCallOperation,
    usage: ExtractedUsage | null,
    outcome: LlmCallOutcome,
    providerError?: unknown,
  ): Promise<void> {
    if (!scope) return;
    try {
      await scope.recorder.record({
        context: scope.context,
        provider: resolved.providerName,
        model: resolved.modelConfig,
        operation,
        usage,
        outcome,
      });
    } catch (writeError) {
      throw new LlmCallNotRecorded(
        {
          projectId: scope.context.projectId,
          callSite: scope.context.callSite,
          provider: resolved.providerName,
          model: resolved.modelConfig.id,
          operation,
          callOutcome: outcome.kind === "ok" ? "ok" : `error (${outcome.errorKind})`,
          providerError,
        },
        { cause: writeError },
      );
    }
  }

  private async executeGenerateObject<T>(
    request: StructuredRequest<T>,
    resolved: ResolvedProvider,
    scope: CallScope,
  ): Promise<StructuredResponse<T>> {
    const operation: LlmCallOperation = "generateObject";
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

    const result = await this.send(scope, resolved, operation, () => generateObject(params));

    const extraction = extractUsage(result.usage, result.providerMetadata);
    this.warnUnmeasuredUsage(extraction, resolved.providerName, resolved.modelConfig.id, request.site ?? "unknown", operation);
    const cost = this.recordCost(extraction, resolved.modelConfig, resolved.providerName);

    const violation = temperatureViolation({
      requestedTemperature: request.temperature,
      warnings: result.warnings,
      provider: resolved.providerName,
      model: resolved.modelConfig.id,
      site: request.site,
      operation,
    });
    await this.record(scope, resolved, operation, extraction, violation ? errorOutcome(violation) : OK, violation);
    if (violation) throw violation;

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
    scope: CallScope,
    maxRetries = 2,
  ): Promise<StructuredResponse<T>> {
    const operation: LlmCallOperation = "generateText:structured-fallback";
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

      const result = await this.send(scope, resolved, operation, () => generateText(params));
      lastRawResponse = result.text;

      const extraction = extractUsage(result.usage, result.providerMetadata);
      this.warnUnmeasuredUsage(extraction, resolved.providerName, resolved.modelConfig.id, request.site ?? "unknown", operation);
      const cost = this.recordCost(extraction, resolved.modelConfig, resolved.providerName);

      // Throws OUT of the retry loop rather than `continue`-ing: a dropped
      // temperature is a property of the model, not a transient malformation,
      // so every remaining attempt would violate determinism identically while
      // burning the retry budget reserved for recoverable JSON failures.
      const violation = temperatureViolation({
        requestedTemperature: request.temperature,
        warnings: result.warnings,
        provider: resolved.providerName,
        model: resolved.modelConfig.id,
        site: request.site,
        operation,
      });
      if (violation) {
        await this.record(scope, resolved, operation, extraction, errorOutcome(violation), violation);
        throw violation;
      }

      const jsonText = extractJson(result.text);
      let parsed: unknown;
      try {
        parsed = JSON.parse(jsonText);
      } catch {
        lastErrors = [`Invalid JSON: ${jsonText.slice(0, 100)}`];
        await this.record(scope, resolved, operation, extraction, { kind: "error", errorKind: "InvalidJson" });
        continue;
      }

      const validation = request.schema.safeParse(parsed);
      if (validation.success) {
        await this.record(scope, resolved, operation, extraction, OK);
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
      await this.record(scope, resolved, operation, extraction, { kind: "error", errorKind: "SchemaMismatch" });
    }

    throw new SchemaValidationError(
      [...lastErrors, `Raw LLM response: ${lastRawResponse.slice(0, 500)}`],
    );
  }

  getCostSummary(): CostSummary {
    return {
      totalCost: this.budgetLedger.totalSpent(),
      costByProvider: this.budgetLedger.providerBreakdown(),
    };
  }

  resolveModel(capability: CapabilityLevel, site: KnownLLMSite): ResolvedModel {
    const resolved = this.resolveWithBudgetDegrade(capability, site);
    return {
      model: resolved.provider,
      modelId: resolved.modelConfig.id,
      provider: resolved.providerName,
      modelConfig: resolved.modelConfig,
      effectiveCapability: resolved.modelConfig.capabilityLevel,
    };
  }
}

function isTemperatureViolation(error: unknown): boolean {
  return error instanceof TemperatureNotHonored;
}

/** A pre-call refusal or a failed ledger write: a fallback model would hit the same wall. */
function isNeverRetried(error: unknown): boolean {
  return error instanceof PreCallRefusal || error instanceof LlmCallNotRecorded;
}

/** A structured-output failure still reports what the provider billed; any other throw reports nothing. */
function usageOfFailedRequest(error: unknown): ExtractedUsage | null {
  if (NoObjectGeneratedError.isInstance(error) && error.usage) {
    return extractUsage(error.usage, undefined);
  }
  return null;
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
 * Returns the violation instead of throwing it, so the caller can record the
 * provider call before failing it.
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
export function temperatureViolation(check: TemperatureHonoredCheck): TemperatureNotHonored | null {
  if (check.requestedTemperature === undefined) return null;

  const violation = check.warnings?.find(isTemperatureUnsupportedWarning);
  if (!violation) return null;

  return new TemperatureNotHonored({
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

// Raw Anthropic usage, as @ai-sdk/anthropic 4.0.72 copies it into
// providerMetadata.anthropic.usage (dist/index.js, the `anthropicMetadata`
// object). The camelCase cache keys exist only per-iteration, not at top level.
const AnthropicMetadataSchema = z.looseObject({
  usage: z.looseObject({
    cache_read_input_tokens: z.number().int().nonnegative().nullish(),
    cache_creation_input_tokens: z.number().int().nonnegative().nullish(),
  }),
});

// @ai-sdk/deepseek 3.0.59 copies the response's prompt_cache_hit_tokens and
// prompt_cache_miss_tokens into providerMetadata.deepseek (dist/index.js,
// doGenerate's providerMetadata). The package declares no type for it.
const DeepSeekMetadataSchema = z.looseObject({
  promptCacheHitTokens: z.number().int().nonnegative().nullish(),
  promptCacheMissTokens: z.number().int().nonnegative().nullish(),
});

interface ReportedCache {
  readonly read: number | null;
  readonly write: number | null;
}

/**
 * Cache token counts the provider reported, `null` for each it did not. The
 * AI SDK's own `inputTokenDetails` zero-fills a missing count, so it cannot
 * tell "no cache hit" from "not reported"; the raw provider metadata can.
 */
function reportedCache(
  providerMetadata: Record<string, Record<string, unknown>> | undefined,
  inputTokens: number | undefined,
): ReportedCache {
  const anthropic = AnthropicMetadataSchema.safeParse(providerMetadata?.["anthropic"]);
  if (anthropic.success) {
    return {
      read: anthropic.data.usage.cache_read_input_tokens ?? null,
      write: anthropic.data.usage.cache_creation_input_tokens ?? null,
    };
  }
  const deepseek = DeepSeekMetadataSchema.safeParse(providerMetadata?.["deepseek"]);
  if (deepseek.success) {
    const hit = deepseek.data.promptCacheHitTokens ?? null;
    const miss = deepseek.data.promptCacheMissTokens ?? null;
    // DeepSeek bills no cache-write class: when hits plus misses account for
    // every input token, there were no write tokens. Otherwise it is unknown.
    const accounted = hit !== null && miss !== null && inputTokens !== undefined && hit + miss === inputTokens;
    return { read: hit, write: accounted ? 0 : null };
  }
  return { read: null, write: null };
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
 *   in the SDK contract (`inputTokens: number | undefined`).
 *   This is the branch that fires in practice.
 *
 * Neither branch throws. The throw that used to live here (MissingUsageError)
 * was caught by `withFallback`, which discarded the successful completion,
 * lost its cost accounting, and paid for a second call — strictly worse than
 * the `?? 0` it replaced. `usage` zero-fills for arithmetic; `reported` keeps
 * every unreported count `null`.
 */
export function extractUsage(
  sdkUsage: { inputTokens?: number; outputTokens?: number } | undefined,
  // contract-erasing: providerMetadata carries provider-specific fields, parsed by Zod in reportedCache
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
      reported: { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null },
      missingFields: ["sdkUsageObject"],
    };
  }

  const cache = reportedCache(providerMetadata, sdkUsage.inputTokens);
  const reported = {
    inputTokens: sdkUsage.inputTokens ?? null,
    outputTokens: sdkUsage.outputTokens ?? null,
    cacheReadTokens: cache.read,
    cacheWriteTokens: cache.write,
  };

  // Field-level absence: documented in the SDK contract.
  // Guard structure uses direct undefined checks so TypeScript narrows the
  // fields to `number` on the happy path without non-null assertions.
  if (sdkUsage.inputTokens === undefined || sdkUsage.outputTokens === undefined) {
    const missingFields: string[] = [];
    if (sdkUsage.inputTokens === undefined) missingFields.push("inputTokens");
    if (sdkUsage.outputTokens === undefined) missingFields.push("outputTokens");
    // POLICY default: structural placeholders inside measured:false — the
    // discriminant carries the signal, not the zeros (see JSDoc above).
    return {
      measured: false,
      usage: {
        inputTokens: sdkUsage.inputTokens ?? 0,
        outputTokens: sdkUsage.outputTokens ?? 0,
        cacheReadTokens: cache.read ?? 0,
        cacheWriteTokens: cache.write ?? 0,
      },
      reported,
      missingFields,
    };
  }

  const usage: TokenUsage = {
    inputTokens: sdkUsage.inputTokens,
    outputTokens: sdkUsage.outputTokens,
    // Zero-filled for the in-process budget arithmetic only; `reported` keeps the null.
    cacheReadTokens: cache.read ?? 0,
    cacheWriteTokens: cache.write ?? 0,
  };

  return { measured: true, usage, reported };
}
