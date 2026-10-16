import { randomUUID } from "node:crypto";
import { APICallError, NoObjectGeneratedError, generateObject, generateText, isStepCount } from "ai";
import type { GenerateObjectResult, LanguageModel } from "ai";
import { z } from "zod";
import { describeErrorChain } from "@ashara/shared";
import { extractJson } from "./json-utils.js";
import type { CapabilityLevel } from "./capability-level.js";
import {
  ProviderConfigurationRejected,
  ProviderError,
  SchemaValidationError,
  StructuredOutputTruncated,
  TurnResponseInvalid,
} from "./errors.js";
import type { ResolvedProvider } from "./provider-registry.js";
import { ProviderRegistry } from "./provider-registry.js";
import type { LanguageModelFactory } from "./provider-registry.js";
import type { StructuredProvider } from "./reliability-ladder.js";
import { outputBudget, thinkingModeFor, thinkingProviderOptions } from "./thinking.js";
import type { OutputBudget } from "./thinking.js";
import { SdkFinishReasonSchema, assistantMessageOf, cachedTurnPrompt, mapFinishReason, parseToolCalls, toSdkTools } from "./turn.js";
import type { TurnLlm, TurnRequest, TurnResult } from "./turn.js";
import type {
  ExtractedUsage,
  GatewayConfig,
  KnownLLMSite,
  LlmCallOperation,
  LlmFinishReason,
  LlmCallOutcome,
  ModelConfig,
  ProviderRequest,
  ProviderRequestGate,
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

/** The gate every provider request of one call passes through, and the routing site the call serves. */
interface CallScope {
  readonly gate: ProviderRequestGate;
  readonly site: KnownLLMSite;
}

/** A provider request the gate admitted, to be settled under the same id. */
interface AdmittedCall {
  readonly gate: ProviderRequestGate;
  readonly request: ProviderRequest;
}

/**
 * Carries whatever the gate threw past the fallback path, which never retries
 * it, and is unwrapped before the call returns, so the caller sees the gate's
 * own throw.
 */
class GateThrew extends Error {
  readonly thrown: unknown;

  constructor(thrown: unknown) {
    super(`the provider request gate threw: ${describeErrorChain(thrown)}`, { cause: thrown });
    this.name = "GateThrew";
    this.thrown = thrown;
  }
}

function unwrapGateThrow(error: unknown): unknown {
  return error instanceof GateThrew ? error.thrown : error;
}

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

/** The SDK's finish reason as recorded; total over every input, so an undocumented value is kept, never folded. */
function recordedFinishReason(sdkFinishReason: unknown): LlmFinishReason {
  const parsed = SdkFinishReasonSchema.safeParse(sdkFinishReason);
  return parsed.success ? parsed.data : `unrecognized:${String(sdkFinishReason)}`;
}

export class LLMGateway {
  private readonly registry: ProviderRegistry;
  /** Read once per provider request, before it is sent: that instant prices the call. */
  private readonly clock: () => Date;
  private readonly thinking: ThinkingPolicy | undefined;

  constructor(config: GatewayConfig, clock: () => Date, models: LanguageModelFactory) {
    this.registry = new ProviderRegistry(config, models);
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
   * Shared "resolve → try → catch → fallback → retry once" shape for
   * structured calls: run `execute` against `resolved`; on failure, resolve
   * one fallback provider and retry once, or throw a typed ProviderError if
   * none is available. `shouldRethrow` lets a caller opt an error class out of
   * the fallback retry and propagate it immediately instead —
   * SchemaValidationError and whatever the gate throws.
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

      let fallback: ResolvedProvider | null;
      try {
        fallback = this.registry.resolveFallback(request.capability, resolved.providerName, request.site);
      } catch (resolutionError) {
        // The configuration fault propagates; the call failure that led here is not lost.
        console.error(
          `[LLMGateway] ${label} on provider=${resolved.providerName} model=${resolved.modelConfig.id} failed ` +
            `(${describeErrorChain(error)}), and resolving a fallback failed: ${describeErrorChain(resolutionError)}`,
        );
        throw resolutionError;
      }
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
   * The only entry point: every provider request made through the returned
   * ports passes through `gate`, and `site` is the routing site they serve.
   * Finance's guarded port is its production caller.
   */
  gated(site: KnownLLMSite, gate: ProviderRequestGate): StructuredProvider & TurnLlm {
    const scope: CallScope = { gate, site };
    return {
      generateStructured: async <T>(request: StructuredRequest<T>) => {
        try {
          return await this.structured(request, scope);
        } catch (error) {
          throw unwrapGateThrow(error);
        }
      },
      generateTurn: async (request: TurnRequest) => {
        try {
          return await this.turn(request, scope);
        } catch (error) {
          throw unwrapGateThrow(error);
        }
      },
    };
  }

  /**
   * One agent turn: exactly one provider request, one step, one settlement through the gate.
   * Tools go out as schemas and come back as calls; nothing is executed and
   * nothing loops (ADR-074 d7). The model is the caller's pinned resolution:
   * no re-routing, no fallback (ADR-074 d44), and no SDK
   * retry, so every provider request is the one the gate settles.
   *
   * Called through Finance's guarded port by @ashara/workplace runAttempt.
   */
  private async turn(request: TurnRequest, scope: CallScope): Promise<TurnResult> {
    const operation: LlmCallOperation = "generateText:turn";
    const target: CallTarget = {
      providerName: request.model.provider,
      modelConfig: request.model.modelConfig,
      providerType: this.registry.providerTypeOf(request.model.provider),
    };
    const site = scope.site;
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
    const { result, requestedAt, admitted } = await this.send(scope, target, operation, size, () =>
      generateText(params),
    );

    // One step, whose usage keeps the raw cache counts that the summed `result.usage` drops.
    const [onlyStep] = result.steps;
    const extraction = extractUsage(result.steps.length === 1 && onlyStep ? onlyStep.usage : result.usage);
    const recordedReason = recordedFinishReason(result.finishReason);

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
      await this.settle(admitted, requestedAt, extraction, recordedReason, errorOutcome(invalid), invalid);
      throw invalid;
    }

    const finishReason = mapFinishReason(result.finishReason);
    const rawFinishReason = result.rawFinishReason ?? null;
    const outcome: LlmCallOutcome =
      finishReason === "provider_error"
        ? { kind: "error", errorKind: `FinishReason:${String(result.finishReason ?? "missing")}` }
        : OK;
    await this.settle(admitted, requestedAt, extraction, recordedReason, outcome);

    return {
      assistant: message.assistant,
      text: result.text,
      toolCalls: parsedCalls.toolCalls,
      finishReason,
      rawFinishReason,
      usage: extraction.usage,
      reportedOutputTokens: extraction.reported.outputTokens,
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
      (error) => error instanceof SchemaValidationError || error instanceof GateThrew,
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
   * sent, which prices it. The gate admits it first, so a refused request (an
   * unpriced model, or a worst-case cost over a spend cap) never reaches the
   * network. A request that throws is settled as an error before the throw
   * continues.
   */
  private async send<R>(
    scope: CallScope,
    resolved: CallTarget,
    operation: LlmCallOperation,
    size: RequestSize,
    request: () => Promise<R>,
  ): Promise<{ readonly result: R; readonly requestedAt: Date; readonly admitted: AdmittedCall }> {
    const admitted: AdmittedCall = {
      gate: scope.gate,
      request: {
        callId: randomUUID(),
        provider: resolved.providerName,
        model: resolved.modelConfig,
        operation,
        requestBytes: size.requestBytes,
        maxOutputTokens: size.maxOutputTokens,
      },
    };
    try {
      await admitted.gate.admit(admitted.request);
    } catch (error) {
      throw new GateThrew(error);
    }
    const requestedAt = this.clock();
    try {
      return { result: await request(), requestedAt, admitted };
    } catch (error) {
      const usage = usageOfFailedRequest(error);
      const failure = failureOfRequest(error);
      await this.settle(admitted, requestedAt, usage, failure.finishReason, failure.outcome, error);
      throw configurationRejectionOf(error, resolved) ?? error;
    }
  }

  /** Settles an admitted provider request through its gate. A throw from the gate fails the call (Discipline A). */
  private async settle(
    admitted: AdmittedCall,
    requestedAt: Date,
    usage: ExtractedUsage | null,
    finishReason: LlmFinishReason,
    outcome: LlmCallOutcome,
    providerError?: unknown,
  ): Promise<void> {
    try {
      await admitted.gate.settle({ ...admitted.request, requestedAt, usage, finishReason, outcome, providerError });
    } catch (error) {
      throw new GateThrew(error);
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
    const site = request.site ?? scope.site;
    const requestBytes = utf8Bytes(request.prompt, request.systemPrompt, schemaText(request.schema));
    const { providerOptions, budget } = this.thinkingFor(resolved, site, request.maxTokens, requestBytes);
    const size: RequestSize = { requestBytes, maxOutputTokens: budget.maxOutputTokens };
    // The SDK validates the response against request.schema once and types the object by it.
    const call = (): Promise<GenerateObjectResult<T>> =>
      generateObject({
        model: resolved.provider,
        schema: request.schema,
        prompt: request.prompt,
        system: request.systemPrompt,
        maxOutputTokens: budget.maxOutputTokens,
        maxRetries: 0,
        providerOptions,
      });
    let sent: {
      readonly result: GenerateObjectResult<T>;
      readonly requestedAt: Date;
      readonly admitted: AdmittedCall;
    };
    try {
      sent = await this.send(scope, resolved, operation, size, call);
    } catch (error) {
      if (!NoObjectGeneratedError.isInstance(error)) throw error;
      throw structuredFailureOf(error, resolved, budget);
    }
    const { result, requestedAt, admitted } = sent;

    const extraction = extractUsage(result.usage);
    const finishReason = recordedFinishReason(result.finishReason);

    // An object the SDK parsed from output cut off at maxTokens is still cut
    // off: the text happened to close, the model did not finish.
    if (finishReason === "length") {
      await this.settle(admitted, requestedAt, extraction, finishReason, TRUNCATED);
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

    await this.settle(admitted, requestedAt, extraction, finishReason, OK);

    return {
      data: result.object,
      usage: extraction.usage,
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
    const site = request.site ?? scope.site;
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
    const { result, requestedAt, admitted } = await this.send(scope, resolved, operation, size, () =>
      generateText(params),
    );

    // `result.usage` sums the steps and drops each step's raw usage; with no
    // tools there is one step, whose usage keeps it.
    const [onlyStep] = result.steps;
    const extraction = extractUsage(result.steps.length === 1 && onlyStep ? onlyStep.usage : result.usage);
    const finishReason = recordedFinishReason(result.finishReason);

    // Checked before any parse: a value cut off at maxTokens is never parsed,
    // even when the text that arrived happens to be valid JSON.
    if (finishReason === "length") {
      await this.settle(admitted, requestedAt, extraction, finishReason, TRUNCATED);
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
      await this.settle(admitted, requestedAt, extraction, finishReason, OK);
      return {
        data: parsed.data,
        usage: extraction.usage,
        provider: resolved.providerName,
        model: resolved.modelConfig.id,
      };
    }

    await this.settle(admitted, requestedAt, extraction, finishReason, {
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

/**
 * HTTP statuses with which a provider rejects a request as Ashara configured it (its
 * credentials, its account, its endpoint or model id) rather than for what the request said.
 */
const CONFIGURATION_REJECTION_STATUSES: ReadonlySet<number> = new Set([401, 402, 403, 404]);

/** A provider's rejection of Ashara's configuration, as its own class; `null` for any other request failure. */
function configurationRejectionOf(error: unknown, resolved: CallTarget): ProviderConfigurationRejected | null {
  if (!APICallError.isInstance(error) || error.statusCode === undefined) return null;
  if (!CONFIGURATION_REJECTION_STATUSES.has(error.statusCode)) return null;
  return new ProviderConfigurationRejected(resolved.providerName, resolved.modelConfig.id, error.statusCode, { cause: error });
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
 * the cost unmeasured, which Finance names and logs.
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
