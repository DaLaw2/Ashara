import { randomUUID } from "node:crypto";
import { NoObjectGeneratedError, generateObject, generateText, isStepCount } from "ai";
import type { LanguageModel } from "ai";
import { z } from "zod";
import { describeErrorChain, extractJson } from "@ashara/shared";
import type { CapabilityLevel } from "@ashara/shared";
import {
  LlmCallContextMissing,
  LlmCallNotRecorded,
  LlmCallRecorderMissing,
  PreCallRefusal,
  ProviderError,
  SchemaValidationError,
  StructuredOutputTruncated,
  TurnResponseInvalid,
} from "./errors.js";
import { describeUnmeasuredCost, measureCost } from "./pricing.js";
import type { ResolvedProvider } from "./provider-registry.js";
import { ProviderRegistry } from "./provider-registry.js";
import type { LanguageModelFactory } from "./provider-registry.js";
import type { StructuredProvider } from "./reliability-ladder.js";
import { outputBudget, thinkingModeFor, thinkingProviderOptions } from "./thinking.js";
import type { OutputBudget } from "./thinking.js";
import { assistantMessageOf, cachedTurnPrompt, mapFinishReason, parseToolCalls, toSdkTools } from "./turn.js";
import type { TurnLlm, TurnRequest, TurnResult } from "./turn.js";
import type {
  CallRecording,
  CostMeasurement,
  ExtractedUsage,
  GatewayConfig,
  KnownLLMSite,
  LlmCallContext,
  LlmCallOperation,
  LlmFinishReason,
  LlmCallOutcome,
  LlmCallRecorder,
  ModelConfig,
  PendingLlmCall,
  ProviderType,
  StructuredRequest,
  StructuredResponse,
  ThinkingPolicy,
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

/** The turn port of the same gateway: one recorded single-step call per agent turn (ADR-074 d7). */
export interface ContextualTurnLlm {
  forCall(context: LlmCallContext): TurnLlm;
}

/** The recorder and context of one recorded call; `null` on an unrecorded gateway. */
type CallScope = { readonly recorder: LlmCallRecorder; readonly context: LlmCallContext } | null;

/** A provider request the recorder admitted, to be recorded under the same id; `null` on an unrecorded gateway. */
type AdmittedCall = { readonly recorder: LlmCallRecorder; readonly pending: PendingLlmCall } | null;

/** What Finance prices a request's worst case from: its input size and its output bound. */
interface RequestSize {
  readonly requestBytes: number;
  readonly maxOutputTokens: number;
}

/**
 * The output bound of one agent turn. A turn request carries none of its own,
 * and an unbounded request has no worst-case cost to check against the cap. 16k
 * holds one tool call that writes a file of about 50 KB; a turn that needs more
 * stops at `length`, which the attempt loop reads as a truncated turn.
 */
const TURN_MAX_OUTPUT_TOKENS = 16_384;

function utf8Bytes(...parts: readonly (string | undefined)[]): number {
  return parts.reduce((total, part) => total + (part === undefined ? 0 : Buffer.byteLength(part, "utf8")), 0);
}

/** The JSON schema generateObject sends with the request, as text, for its size. */
function schemaText(schema: StructuredRequest<unknown>["schema"]): string {
  return JSON.stringify(z.toJSONSchema(schema, { unrepresentable: "any" }));
}

/** The provider and model a request is priced and recorded against, and the adapter type its options are built for. */
type CallTarget = Pick<ResolvedProvider, "providerName" | "modelConfig" | "providerType">;

const OK: LlmCallOutcome = { kind: "ok" };

function errorOutcome(error: unknown): LlmCallOutcome {
  return { kind: "error", errorKind: error instanceof Error ? error.name : typeof error };
}

/** The error kind of a structured call that stopped at `maxTokens` without a valid result. */
const TRUNCATED: LlmCallOutcome = { kind: "error", errorKind: "truncated" };

const SdkFinishReasonSchema = z.enum(["stop", "length", "content-filter", "tool-calls", "error", "other"]);

/** The SDK's finish reason as recorded; total over every input, so an undocumented value is kept, never folded. */
function recordedFinishReason(sdkFinishReason: unknown): LlmFinishReason {
  const parsed = SdkFinishReasonSchema.safeParse(sdkFinishReason);
  return parsed.success ? parsed.data : `unrecognized:${String(sdkFinishReason)}`;
}

export class LLMGateway implements ContextualLlm, ContextualTurnLlm {
  private readonly registry: ProviderRegistry;
  private readonly recording: CallRecording;
  /** Read once per provider request, before it is sent: that instant prices the call everywhere. */
  private readonly clock: () => Date;
  private readonly thinking: ThinkingPolicy | undefined;

  constructor(config: GatewayConfig, recording: CallRecording, clock: () => Date, models: LanguageModelFactory) {
    this.registry = new ProviderRegistry(config, models);
    this.recording = recording;
    this.clock = clock;
    this.thinking = config.thinking;
  }

  /**
   * The thinking switch for a request to `target` at `site` (none for a provider
   * type that takes no switch), and the output bound it is sent with: the
   * caller's `answerTokens`, plus a reasoning allowance, sized by `promptBytes`, when thinking is on.
   */
  private thinkingFor(target: CallTarget, site: string | undefined, answerTokens: number, promptBytes: number) {
    const mode = thinkingModeFor(this.thinking, site);
    return {
      providerOptions: thinkingProviderOptions(target.providerType, mode),
      budget: outputBudget(target.providerType, mode, answerTokens, promptBytes),
    };
  }

  /**
   * The cost of a completed call, priced at `requestedAt`. An unmeasured cost
   * is logged at `warn`: its llm_calls row counts against the spend cap at the
   * call's pre-call estimate, never at $0.
   */
  private measuredCost(
    extraction: ExtractedUsage,
    resolved: CallTarget,
    site: string,
    operation: LlmCallOperation,
    requestedAt: Date,
  ): CostMeasurement {
    const cost = measureCost(extraction.reported, resolved.modelConfig, requestedAt);
    if (!cost.measured) {
      console.warn(
        `[LLMGateway] ${describeUnmeasuredCost(cost, resolved.providerName, resolved.modelConfig.id)}, ` +
          `site=${site}, operation=${operation}; the spend cap counts this call at its pre-call estimate`,
      );
    }
    return cost;
  }

  /**
   * Shared "resolve → try → catch → fallback → retry once" shape for
   * structured calls: run `execute` against `resolved`; on failure, resolve
   * one fallback provider and retry once, or throw a typed ProviderError if
   * none is available. `shouldRethrow` lets a caller opt an error class out of
   * the fallback retry and propagate it immediately instead —
   * SchemaValidationError, a pre-call refusal and a failed ledger write.
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
        const rootMsg = describeErrorChain(error);
        throw new ProviderError(
          resolved.providerName,
          `${label} failed (${rootMsg}) and no fallback available`,
          { cause: error },
        );
      }

      console.warn(
        `[LLMGateway] ${label} on provider=${resolved.providerName} model=${resolved.modelConfig.id} failed ` +
          `(${describeErrorChain(error)}); ` +
          `one failover request to provider=${fallback.providerName} model=${fallback.modelConfig.id} ` +
          `for site=${request.site ?? "none"}`,
      );
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
  forCall(context: LlmCallContext): StructuredProvider & TurnLlm {
    if (this.recording.kind === "unrecorded") {
      throw new LlmCallRecorderMissing(this.recording.reason);
    }
    const scope = { recorder: this.recording.recorder, context };
    return {
      generateStructured: <T>(request: StructuredRequest<T>) => this.structured(request, scope),
      generateTurn: (request: TurnRequest) => this.turn(request, scope),
    };
  }

  /**
   * One agent turn: exactly one provider request, one step, one llm_calls row.
   * Tools go out as schemas and come back as calls; nothing is executed and
   * nothing loops (ADR-074 d7). The model is the caller's pinned resolution:
   * no re-routing, no fallback (ADR-074 d44), and no SDK
   * retry, so every provider request is the row the caller sees.
   *
   * Called by @ashara/workplace runAttempt, whose own production caller is
   * t-isolated-switchover (s-isolated-worker-m1).
   */
  private async turn(request: TurnRequest, scope: NonNullable<CallScope>): Promise<TurnResult> {
    const operation: LlmCallOperation = "generateText:turn";
    const target: CallTarget = {
      providerName: request.model.provider,
      modelConfig: request.model.modelConfig,
      providerType: this.registry.providerTypeOf(request.model.provider),
    };
    const site = scope.context.callSite;
    const tools = toSdkTools(request.tools);
    const { providerOptions, budget } = this.thinkingFor(target, site, TURN_MAX_OUTPUT_TOKENS, 0);
    const prompt = cachedTurnPrompt(target.providerType, request.system, request.messages);

    const params: Parameters<typeof generateText>[0] = {
      model: request.model.model,
      system: prompt.system,
      messages: prompt.messages,
      tools,
      stopWhen: isStepCount(1),
      maxOutputTokens: budget.maxOutputTokens,
      maxRetries: 0,
      providerOptions,
      abortSignal: request.abortSignal,
    };
    const size: RequestSize = {
      requestBytes: utf8Bytes(request.system, JSON.stringify(request.messages), JSON.stringify(request.tools)),
      maxOutputTokens: budget.maxOutputTokens,
    };
    const { result, requestedAt, admitted } = await this.send(scope, target, site, operation, size, () =>
      generateText(params),
    );

    // One step, whose usage keeps the raw cache counts that the summed `result.usage` drops.
    const [onlyStep] = result.steps;
    const extraction = extractUsage(result.steps.length === 1 && onlyStep ? onlyStep.usage : result.usage);
    const recordedReason = recordedFinishReason(result.finishReason);
    const cost = this.measuredCost(extraction, target, site, operation, requestedAt);

    const parsedCalls = parseToolCalls(result.toolCalls, request.tools);
    const invalidCallIds = new Set(parsedCalls.toolCalls.filter((c) => c.kind === "invalid").map((c) => c.toolCallId));
    const message = assistantMessageOf(result.response.messages, invalidCallIds);
    const issues = [
      ...(result.steps.length === 1 ? [] : [`expected exactly one step, got ${result.steps.length}`]),
      ...("issue" in message ? [message.issue] : []),
      ...parsedCalls.issues,
    ];
    if (issues.length > 0 || !("assistant" in message)) {
      const invalid = new TurnResponseInvalid({ provider: target.providerName, model: target.modelConfig.id, issues });
      await this.record(admitted, requestedAt, extraction, recordedReason, errorOutcome(invalid), invalid);
      throw invalid;
    }

    const finishReason = mapFinishReason(result.finishReason);
    const rawFinishReason = result.rawFinishReason ?? null;
    const outcome: LlmCallOutcome =
      finishReason === "provider_error"
        ? { kind: "error", errorKind: `FinishReason:${String(result.finishReason ?? "missing")}` }
        : OK;
    await this.record(admitted, requestedAt, extraction, recordedReason, outcome);

    return {
      assistant: message.assistant,
      text: result.text,
      toolCalls: parsedCalls.toolCalls,
      finishReason,
      rawFinishReason,
      usage: extraction.usage,
      cost,
      provider: target.providerName,
      model: target.modelConfig.id,
    };
  }

  private async structured<T>(request: StructuredRequest<T>, scope: CallScope): Promise<StructuredResponse<T>> {
    const resolved = this.registry.resolve(request.capability, [], request.site);
    return this.withFallback(
      request,
      resolved,
      (req, r) => this.executeStructuredCall(req, r, scope),
      "structured request",
      (error) =>
        error instanceof SchemaValidationError || isNeverRetried(error),
    );
  }

  private async executeStructuredCall<T>(
    request: StructuredRequest<T>,
    resolved: ResolvedProvider,
    scope: CallScope,
  ): Promise<StructuredResponse<T>> {
    if (this.providerSupportsStructuredOutput(resolved.providerType)) {
      return await this.executeGenerateObject(request, resolved, scope);
    }
    return await this.executeTextStructured(request, resolved, scope);
  }

  private providerSupportsStructuredOutput(providerType: ProviderType): boolean {
    return providerType === "anthropic" || providerType === "openai";
  }

  /**
   * Sends ONE provider request and returns its result with the instant it was
   * sent, which prices it. The recorder's pre-call check runs first, so a
   * refused call (an unpriced model, or a worst-case cost over a spend cap)
   * never reaches the network. A request that throws is recorded as an error
   * before the throw continues.
   */
  private async send<R>(
    scope: CallScope,
    resolved: CallTarget,
    site: string,
    operation: LlmCallOperation,
    size: RequestSize,
    request: () => Promise<R>,
  ): Promise<{ readonly result: R; readonly requestedAt: Date; readonly admitted: AdmittedCall }> {
    const admitted: AdmittedCall = scope
      ? {
          recorder: scope.recorder,
          pending: {
            callId: randomUUID(),
            context: scope.context,
            provider: resolved.providerName,
            model: resolved.modelConfig,
            operation,
            requestBytes: size.requestBytes,
            maxOutputTokens: size.maxOutputTokens,
          },
        }
      : null;
    if (admitted) await admitted.recorder.assertPriced(admitted.pending);
    const requestedAt = this.clock();
    try {
      return { result: await request(), requestedAt, admitted };
    } catch (error) {
      const usage = usageOfFailedRequest(error);
      if (usage) this.measuredCost(usage, resolved, site, operation, requestedAt);
      const failure = failureOfRequest(error);
      await this.record(admitted, requestedAt, usage, failure.finishReason, failure.outcome, error);
      throw error;
    }
  }

  /** Writes the one row for an admitted provider request. A failed write fails the call (Discipline A). */
  private async record(
    admitted: AdmittedCall,
    requestedAt: Date,
    usage: ExtractedUsage | null,
    finishReason: LlmFinishReason,
    outcome: LlmCallOutcome,
    providerError?: unknown,
  ): Promise<void> {
    if (!admitted) return;
    const { recorder, pending } = admitted;
    try {
      await recorder.record({ ...pending, requestedAt, usage, finishReason, outcome });
    } catch (writeError) {
      throw new LlmCallNotRecorded(
        {
          projectId: pending.context.projectId,
          callSite: pending.context.callSite,
          provider: pending.provider,
          model: pending.model.id,
          operation: pending.operation,
          callOutcome: outcome.kind === "ok" ? "ok" : `error (${outcome.errorKind})`,
          providerError,
        },
        { cause: writeError },
      );
    }
  }

  /**
   * One generateObject request. A response that does not parse or validate is
   * a failed ladder attempt (`SchemaValidationError`, or
   * `StructuredOutputTruncated` when it stopped at `maxTokens`), never a second
   * request: the ladder's own attempts are the only retries.
   */
  private async executeGenerateObject<T>(
    request: StructuredRequest<T>,
    resolved: ResolvedProvider,
    scope: CallScope,
  ): Promise<StructuredResponse<T>> {
    const operation: LlmCallOperation = "generateObject";
    const site = request.site ?? scope?.context.callSite;
    const requestBytes = utf8Bytes(request.prompt, request.systemPrompt, schemaText(request.schema));
    const { providerOptions, budget } = this.thinkingFor(resolved, site, request.maxTokens, requestBytes);
    const params: Parameters<typeof generateObject>[0] = {
      model: resolved.provider,
      schema: request.schema,
      prompt: request.prompt,
      system: request.systemPrompt,
      maxOutputTokens: budget.maxOutputTokens,
      maxRetries: 0,
      providerOptions,
    };
    const size: RequestSize = { requestBytes, maxOutputTokens: budget.maxOutputTokens };
    let sent: {
      readonly result: Awaited<ReturnType<typeof generateObject>>;
      readonly requestedAt: Date;
      readonly admitted: AdmittedCall;
    };
    try {
      sent = await this.send(scope, resolved, site ?? "unknown", operation, size, () => generateObject(params));
    } catch (error) {
      if (!NoObjectGeneratedError.isInstance(error)) throw error;
      throw structuredFailureOf(error, resolved, budget);
    }
    const { result, requestedAt, admitted } = sent;

    const extraction = extractUsage(result.usage);
    const cost = this.measuredCost(extraction, resolved, site ?? "unknown", operation, requestedAt);
    const finishReason = recordedFinishReason(result.finishReason);

    // An object the SDK parsed from output cut off at maxTokens is still cut
    // off: the text happened to close, the model did not finish.
    if (finishReason === "length") {
      await this.record(admitted, requestedAt, extraction, finishReason, TRUNCATED);
      throw new StructuredOutputTruncated({
        provider: resolved.providerName,
        model: resolved.modelConfig.id,
        maxTokens: budget.maxOutputTokens,
        reasoningAllowance: budget.reasoningAllowance,
        outputTokens: extraction.reported.outputTokens,
        reasoningTokens: extraction.reasoningTokens,
        // generateObject keeps no raw text on success; this is the parsed object re-serialized.
        text: JSON.stringify(result.object) ?? "",
      });
    }

    await this.record(admitted, requestedAt, extraction, finishReason, OK);

    return {
      data: result.object as T,
      usage: extraction.usage,
      cost,
      provider: resolved.providerName,
      model: resolved.modelConfig.id,
    };
  }

  /**
   * One generateText request whose JSON is extracted and validated here, for a
   * provider with no native structured output. A response that does not parse
   * or validate is a failed ladder attempt, never a second request.
   */
  private async executeTextStructured<T>(
    request: StructuredRequest<T>,
    resolved: ResolvedProvider,
    scope: CallScope,
  ): Promise<StructuredResponse<T>> {
    const operation: LlmCallOperation = "generateText:structured-fallback";
    const site = request.site ?? scope?.context.callSite;
    const prompt = request.prompt + "\n\nRespond with valid JSON only. No markdown, no explanation.";
    const requestBytes = utf8Bytes(prompt, request.systemPrompt);
    const { providerOptions, budget } = this.thinkingFor(resolved, site, request.maxTokens, requestBytes);
    const params: Parameters<typeof generateText>[0] = {
      model: resolved.provider,
      prompt,
      system: request.systemPrompt,
      maxOutputTokens: budget.maxOutputTokens,
      maxRetries: 0,
      providerOptions,
    };
    const size: RequestSize = { requestBytes, maxOutputTokens: budget.maxOutputTokens };
    const { result, requestedAt, admitted } = await this.send(scope, resolved, site ?? "unknown", operation, size, () =>
      generateText(params),
    );

    // `result.usage` sums the steps and drops each step's raw usage; with no
    // tools there is one step, whose usage keeps it.
    const [onlyStep] = result.steps;
    const extraction = extractUsage(result.steps.length === 1 && onlyStep ? onlyStep.usage : result.usage);
    const finishReason = recordedFinishReason(result.finishReason);
    const cost = this.measuredCost(extraction, resolved, site ?? "unknown", operation, requestedAt);

    // Checked before any parse: a value cut off at maxTokens is never parsed,
    // even when the text that arrived happens to be valid JSON.
    if (finishReason === "length") {
      await this.record(admitted, requestedAt, extraction, finishReason, TRUNCATED);
      throw new StructuredOutputTruncated({
        provider: resolved.providerName,
        model: resolved.modelConfig.id,
        maxTokens: budget.maxOutputTokens,
        reasoningAllowance: budget.reasoningAllowance,
        outputTokens: extraction.reported.outputTokens,
        reasoningTokens: extraction.reasoningTokens,
        text: result.text,
      });
    }

    const parsed = parseStructuredText(result.text, request.schema);
    if (parsed.ok) {
      await this.record(admitted, requestedAt, extraction, finishReason, OK);
      return {
        data: parsed.data,
        usage: extraction.usage,
        cost,
        provider: resolved.providerName,
        model: resolved.modelConfig.id,
      };
    }

    await this.record(admitted, requestedAt, extraction, finishReason, {
      kind: "error",
      errorKind: parsed.errorKind,
    });
    throw new SchemaValidationError([...parsed.errors, `Raw LLM response: ${result.text.slice(0, 500)}`], resolved.modelConfig.id);
  }

  resolveModel(capability: CapabilityLevel, site: KnownLLMSite): ResolvedModel {
    const resolved = this.registry.resolve(capability, [], site);
    return {
      model: resolved.provider,
      modelId: resolved.modelConfig.id,
      provider: resolved.providerName,
      modelConfig: resolved.modelConfig,
      effectiveCapability: resolved.modelConfig.capabilityLevel,
    };
  }
}

/** A pre-call refusal or a failed ledger write: a fallback model would hit the same wall. */
function isNeverRetried(error: unknown): boolean {
  return error instanceof PreCallRefusal || error instanceof LlmCallNotRecorded;
}

type ParsedStructuredText<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly errorKind: "InvalidJson" | "SchemaMismatch"; readonly errors: string[] };

function parseStructuredText<T>(text: string, schema: StructuredRequest<T>["schema"]): ParsedStructuredText<T> {
  const jsonText = extractJson(text);
  let json: unknown;
  try {
    json = JSON.parse(jsonText);
  } catch {
    return { ok: false, errorKind: "InvalidJson", errors: [`Invalid JSON: ${jsonText.slice(0, 100)}`] };
  }
  const validation = schema.safeParse(json);
  if (validation.success) return { ok: true, data: validation.data };
  return {
    ok: false,
    errorKind: "SchemaMismatch",
    errors: validation.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
  };
}

/**
 * The finish reason and outcome of a request that threw. A structured-output
 * failure carries the provider's finish reason, and one that stopped at
 * `maxTokens` is `truncated`; any other throw got no response.
 */
function failureOfRequest(error: unknown): { readonly finishReason: LlmFinishReason; readonly outcome: LlmCallOutcome } {
  if (NoObjectGeneratedError.isInstance(error) && error.finishReason !== undefined) {
    const finishReason = recordedFinishReason(error.finishReason);
    return { finishReason, outcome: finishReason === "length" ? TRUNCATED : errorOutcome(error) };
  }
  return { finishReason: "no-response", outcome: errorOutcome(error) };
}

/** A generateObject response that did not parse or validate, as the failed ladder attempt it is. */
function structuredFailureOf(
  error: NoObjectGeneratedError,
  resolved: CallTarget,
  budget: OutputBudget,
): SchemaValidationError {
  const text = error.text ?? "";
  if (error.finishReason === "length") {
    return new StructuredOutputTruncated(
      {
        provider: resolved.providerName,
        model: resolved.modelConfig.id,
        maxTokens: budget.maxOutputTokens,
        reasoningAllowance: budget.reasoningAllowance,
        outputTokens: error.usage?.outputTokens ?? null,
        reasoningTokens: error.usage ? extractUsage(error.usage).reasoningTokens : null,
        text,
      },
      { cause: error },
    );
  }
  return new SchemaValidationError([describeErrorChain(error), `Raw LLM response: ${text.slice(0, 500)}`], resolved.modelConfig.id, {
    cause: error,
  });
}

/** A structured-output failure still reports what the provider billed; any other throw reports nothing. */
function usageOfFailedRequest(error: unknown): ExtractedUsage | null {
  if (NoObjectGeneratedError.isInstance(error) && error.usage) {
    return extractUsage(error.usage);
  }
  return null;
}

/*
 * The provider's wire-format usage, which the AI SDK keeps as `usage.raw` on
 * one response (`asLanguageModelUsage`, ai 7.0.128) and drops when it sums
 * steps. Read by wire format, not by provider name, so every endpoint served
 * through `createOpenAI` reads the same way:
 * - Anthropic Messages: `cache_read_input_tokens`, `cache_creation_input_tokens`.
 * - DeepSeek chat: `prompt_cache_hit_tokens` (no cache-write class).
 * - OpenAI Chat Completions: `prompt_tokens_details.cached_tokens` / `.cache_write_tokens`.
 * - OpenAI Responses: `input_tokens_details.cached_tokens` / `.cache_write_tokens`.
 * The SDK's normalised `inputTokenDetails` cannot replace this: each installed
 * converter writes the cache-read count as `?? 0` (Anthropic the write count
 * too), so an unreported count arrives as 0 and would price as "no cache hit".
 */
const tokenCount = z.number().int().nonnegative().nullish();
const CacheDetailsSchema = z.looseObject({ cached_tokens: tokenCount, cache_write_tokens: tokenCount }).nullish();
const ReasoningDetailsSchema = z.looseObject({ reasoning_tokens: tokenCount }).nullish();
const RawUsageSchema = z.looseObject({
  completion_tokens_details: ReasoningDetailsSchema,
  output_tokens_details: ReasoningDetailsSchema,
  cache_read_input_tokens: tokenCount,
  cache_creation_input_tokens: tokenCount,
  prompt_cache_hit_tokens: tokenCount,
  prompt_tokens_details: CacheDetailsSchema,
  input_tokens_details: CacheDetailsSchema,
});

interface ReportedCache {
  readonly read: number | null;
  readonly write: number | null;
}

/**
 * Reasoning tokens the provider reported in its wire format: Chat Completions
 * (DeepSeek, OpenAI chat) `completion_tokens_details.reasoning_tokens`, OpenAI
 * Responses `output_tokens_details.reasoning_tokens`. Read raw because the
 * DeepSeek converter writes an unreported count as `?? 0`. Anthropic Messages
 * reports none, so its calls are `null`.
 */
function reportedReasoning(raw: unknown): number | null {
  const parsed = RawUsageSchema.safeParse(raw);
  if (!parsed.success) return null;
  return (
    parsed.data.completion_tokens_details?.reasoning_tokens ??
    parsed.data.output_tokens_details?.reasoning_tokens ??
    null
  );
}

/** Cache token counts the provider reported; `null` for each it did not, and both when `raw` is absent or malformed. */
function reportedCache(raw: unknown): ReportedCache {
  const parsed = RawUsageSchema.safeParse(raw);
  if (!parsed.success) return { read: null, write: null };
  const u = parsed.data;
  return {
    read:
      u.cache_read_input_tokens ??
      u.prompt_cache_hit_tokens ??
      u.prompt_tokens_details?.cached_tokens ??
      u.input_tokens_details?.cached_tokens ??
      null,
    write:
      u.cache_creation_input_tokens ??
      u.prompt_tokens_details?.cache_write_tokens ??
      u.input_tokens_details?.cache_write_tokens ??
      null,
  };
}

/**
 * Splits the SDK's usage into what the provider reported, `null` where it did
 * not, and a zero-filled copy for tallies. An absent usage object (unreachable
 * per the AI SDK's types, guarded across the trust boundary) reports nothing.
 * Never throws: a throw here was caught by `withFallback`, which discarded a
 * successful completion and paid for a second call. An unreported count leaves
 * the cost unmeasured, which `measureCost` names and every caller logs.
 * @testseam gateway.test.ts asserts the split directly
 */
export function extractUsage(
  sdkUsage: { inputTokens?: number; outputTokens?: number; raw?: unknown } | undefined,
): ExtractedUsage {
  const cache = reportedCache(sdkUsage?.raw);
  const reported = {
    inputTokens: sdkUsage?.inputTokens ?? null,
    outputTokens: sdkUsage?.outputTokens ?? null,
    cacheReadTokens: cache.read,
    cacheWriteTokens: cache.write,
  };
  // Zero-filled for tallies only; `reported` keeps every null, and only it prices a call.
  const usage: TokenUsage = {
    inputTokens: reported.inputTokens ?? 0,
    outputTokens: reported.outputTokens ?? 0,
    cacheReadTokens: reported.cacheReadTokens ?? 0,
    cacheWriteTokens: reported.cacheWriteTokens ?? 0,
  };
  return { usage, reported, reasoningTokens: reportedReasoning(sdkUsage?.raw) };
}
