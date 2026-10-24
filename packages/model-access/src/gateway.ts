import { randomUUID } from "node:crypto";
import {
  APICallError,
  EmptyResponseBodyError,
  InvalidResponseDataError,
  NoObjectGeneratedError,
  generateObject,
  generateText,
  isStepCount,
} from "ai";
import type { GenerateObjectResult, LanguageModel } from "ai";
import { z } from "zod";
import { JsonParseFailed, describeErrorChain, parseJson } from "@ashara/shared";
import { extractJson } from "./json-utils.js";
import type { CapabilityLevel } from "./capability-level.js";
import { judgeRelation } from "./capability-rank.js";
import { contextOverflowOf, contextPreflight, describeProjection, projectTurnInput } from "./context-window.js";
import {
  ContextBudgetExceeded,
  ModelCallAborted,
  ProviderConfigurationRejected,
  ProviderError,
  SchemaValidationError,
  SecondOpinionUnanswered,
  SecondOpinionUnavailable,
  StructuredOutputTruncated,
  TurnResponseInvalid,
} from "./errors.js";
import type { ProviderFailure } from "./errors.js";
import type { ResolvedJudge, ResolvedProvider } from "./provider-registry.js";
import { ProviderRegistry } from "./provider-registry.js";
import type { LanguageModelFactory } from "./provider-registry.js";
import type { StructuredProvider } from "./reliability-ladder.js";
import { describeEqualJudge } from "./routing-rules.js";
import type { RoutingRules } from "./routing-rules.js";
import { SchemaUnacceptable, refuseUnacceptableSchema, sendsStructuredSchema, wireSchemaOf } from "./schema-acceptance.js";
import { outputBudget, thinkingModeFor, thinkingProviderOptions, turnOutputBudget } from "./thinking.js";
import type { OutputBudget } from "./thinking.js";
import { SdkFinishReasonSchema, assistantMessageOf, cachedTurnPrompt, mapFinishReason, parseToolCalls, toSdkTools } from "./turn.js";
import type { TurnLlm, TurnRequest, TurnResult } from "./turn.js";
import type {
  ExtractedUsage,
  ContextOverflowSignatures,
  GatewayConfig,
  KnownLLMSite,
  LlmCallOperation,
  LlmFinishReason,
  LlmCallOutcome,
  ModelConfig,
  ProviderRequest,
  ProviderRequestGate,
  StructuredRequest,
  StructuredResponse,
  ThinkingPolicy,
  TierAsk,
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

/**
 * HTTP statuses in the 4xx range that say nothing against the request Ashara sent: the provider
 * timed out waiting for it (408) or throttled it (429). Every other 4xx rejects the request itself.
 */
const NOT_A_REQUEST_REJECTION: ReadonlySet<number> = new Set([408, 429]);

/** A provider's 4xx rejection of the request as Ashara built it (its size, its shape, its parameters). */
function isRequestRejection(error: APICallError): boolean {
  const status = error.statusCode;
  return status !== undefined && status >= 400 && status < 500 && !NOT_A_REQUEST_REJECTION.has(status);
}

/**
 * Whose failure a failed provider request was (ProviderFailure), from its cause chain. A rejection
 * of Ashara's configuration is checked first: it carries the provider's own HTTP error as its cause.
 * A 4xx rejection of the request (400, 413, 422 and the rest but 408 and 429) is Ashara's: the
 * provider refused what Ashara sent.
 * @testseam exported for the integration fault-classifiers.test.ts; LLMGateway is its production caller
 */
export function providerFailureOf(error: unknown): ProviderFailure {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if (current instanceof ProviderConfigurationRejected) return "ashara";
  }
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if (APICallError.isInstance(current)) return isRequestRejection(current) ? "ashara" : "provider";
    if (EmptyResponseBodyError.isInstance(current) || InvalidResponseDataError.isInstance(current)) return "provider";
  }
  return "ashara";
}

/** The error kind of a structured call that stopped at `maxTokens` without a valid result. */
const TRUNCATED: LlmCallOutcome = { kind: "error", errorKind: "truncated" };

/** The error kind of a request its caller's abort signal cancelled in flight: neither a success nor anyone's failure. */
const ABORTED: LlmCallOutcome = { kind: "error", errorKind: "aborted" };

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
  private readonly contextOverflow: ContextOverflowSignatures;

  constructor(config: GatewayConfig, clock: () => Date, models: LanguageModelFactory, rules: RoutingRules) {
    this.registry = new ProviderRegistry(config, models, rules);
    this.clock = clock;
    this.thinking = config.thinking;
    this.contextOverflow = config.contextOverflow;
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
   * one fallback provider, never `resolved`'s own nor any of `excluded`, and
   * retry once. A failure with no fallback left
   * (none available, or the fallback failed too) throws a ProviderError whose
   * `failure` says whose it was. `shouldRethrow` lets a caller opt an error class out of
   * the fallback retry and propagate it immediately instead —
   * SchemaValidationError and whatever the gate throws.
   */
  private async withFallback<TRequest extends TierAsk & { site?: KnownLLMSite }, TResult>({
    request,
    resolved,
    execute,
    label,
    shouldRethrow,
    excluded,
  }: {
    readonly request: TRequest;
    readonly resolved: ResolvedProvider;
    readonly execute: (request: TRequest, resolved: ResolvedProvider) => Promise<TResult>;
    readonly label: string;
    readonly shouldRethrow: (error: unknown) => boolean;
    readonly excluded: readonly string[];
  }): Promise<TResult> {
    try {
      return await execute(request, resolved);
    } catch (error) {
      if (shouldRethrow(error)) throw error;

      let fallback: ResolvedProvider | null;
      try {
        fallback = this.fallbackFor(request, [resolved.providerName, ...excluded]);
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
          providerFailureOf(error),
          { cause: error },
        );
      }

      console.warn(
        `[LLMGateway] ${label} on provider=${resolved.providerName} model=${resolved.modelConfig.id} failed ` +
          `(${describeErrorChain(error)}); ` +
          `one failover request to provider=${fallback.providerName} model=${fallback.modelConfig.id} ` +
          `for site=${request.site ?? "none"}`,
      );
      try {
        return await execute(request, fallback);
      } catch (fallbackError) {
        if (shouldRethrow(fallbackError)) throw fallbackError;
        // Whose failure it was is read from both requests: Ashara's fault on either side is Ashara's,
        // whichever request failed last.
        const failure: ProviderFailure =
          providerFailureOf(error) === "ashara" || providerFailureOf(fallbackError) === "ashara" ? "ashara" : "provider";
        throw new ProviderError(
          fallback.providerName,
          `${label} failed on provider=${resolved.providerName} (${describeErrorChain(error)}) and on its fallback ` +
            `(${describeErrorChain(fallbackError)})`,
          failure,
          { cause: fallbackError },
        );
      }
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
   * nothing loops. The model is the caller's pinned resolution:
   * no re-routing, no fallback, and no SDK
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
    refuseUnacceptableTools(request, target, scope.site);
    const tools = toSdkTools(request.tools);
    const mode = thinkingModeFor(this.thinking, scope.site);
    const providerOptions = thinkingProviderOptions(target.providerType, mode);
    // The same reserve the catalog's boot check compares every window with (config.ts).
    const budget = turnOutputBudget(target.providerType, mode);
    refuseOverflowingTurn(request, target, budget.maxOutputTokens);
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
    const { result, requestedAt, admitted } = await this.send({ scope, resolved: target, operation, size, abortSignal: request.abortSignal, request: () => generateText(params) }).catch(
      (error: unknown) => {
        throw this.turnRequestFailure(error, target, budget.maxOutputTokens);
      },
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
      await this.settle(admitted, { requestedAt, usage: extraction, finishReason: recordedReason, outcome: errorOutcome(invalid), providerError: invalid });
      // A response not in the API's shape is the provider's failure, as for a structured request.
      throw new ProviderError(target.providerName, `turn response on model=${target.modelConfig.id} unreadable`, "provider", { cause: invalid });
    }

    const finishReason = mapFinishReason(result.finishReason);
    const rawFinishReason = result.rawFinishReason ?? null;
    const outcome: LlmCallOutcome =
      finishReason === "provider_error"
        ? { kind: "error", errorKind: `FinishReason:${String(result.finishReason ?? "missing")}` }
        : OK;
    await this.settle(admitted, { requestedAt, usage: extraction, finishReason: recordedReason, outcome });

    return {
      assistant: message.assistant,
      text: result.text,
      toolCalls: parsedCalls.toolCalls,
      finishReason,
      rawFinishReason,
      usage: extraction.usage,
      reportedOutputTokens: extraction.reported.outputTokens,
      reportedInputTokens: extraction.reported.inputTokens,
      provider: target.providerName,
      model: target.modelConfig.id,
    };
  }

  /** What a turn request that failed is thrown as: a gate's throw and an abort as they are, an overflow as the window's breach. */
  private turnRequestFailure(error: unknown, target: CallTarget, outputReserveTokens: number): Error {
    if (error instanceof GateThrew || error instanceof ModelCallAborted) return error;
    const overflow = contextOverflowOf(error, this.contextOverflow);
    if (overflow !== null) {
      return new ContextBudgetExceeded(
        {
          provider: target.providerName,
          model: target.modelConfig.id,
          windowTokens: target.modelConfig.maxContextTokens,
          outputReserveTokens,
          breach: { source: "provider", providerMessage: overflow },
        },
        { cause: error },
      );
    }
    // Whose failure it was travels with it, as for a structured request: no turn has a fallback.
    return new ProviderError(
      target.providerName,
      `turn request on model=${target.modelConfig.id} failed (${describeErrorChain(error)})`,
      providerFailureOf(error),
      { cause: error },
    );
  }

  private async structured<T>(request: StructuredRequest<T>, scope: CallScope): Promise<StructuredResponse<T>> {
    // A malformed answer is a ladder attempt's failure, a gate refusal the caller's, a schema the
    // provider refuses Ashara's defect, and an aborted call its caller's stop: none is retried on
    // another provider, where it would only be hidden or outlive the stop.
    const rethrown = (error: unknown): boolean =>
      error instanceof SchemaValidationError || error instanceof GateThrew || error instanceof SchemaUnacceptable || error instanceof ModelCallAborted;
    const execute = (req: StructuredRequest<T>, r: ResolvedProvider) => this.executeStructuredCall(req, r, scope);
    const opinion = request.secondOpinion;
    if (opinion === undefined) {
      const routed = request.judges === undefined ? this.registry.resolve(request.capability, [], request.site) : this.judge(request.judges, [], request.site);
      return this.withFallback({ request, resolved: routed, execute, label: "structured request", shouldRethrow: rethrown, excluded: [] });
    }
    // A second opinion goes only to a model of the strength it asks for: the catalog has one or the
    // request is refused unsent, and its failover is only what its strength's rule allows. Moving to
    // a weaker strength is the caller's explicit step, never a failover here.
    const { rules } = this.registry;
    const resolved = this.registry.resolveSecondOpinion(request, opinion, request.site);
    if (resolved === null) throw new SecondOpinionUnavailable(opinion, request, this.registry.enabledModels(request.site), rules);
    // A floor-held opinion at the judged tier is its rule, not a judge rule that found nothing above.
    if (request.judges !== undefined && rules.secondOpinion[opinion.strength].judging.kind === "judge-rule") {
      this.reportEqualJudge(request.judges, { ...resolved, relation: judgeRelation(request.judges, this.registry.gradeAt(resolved.modelConfig, request.site)) }, request.site);
    }
    try {
      return rules.secondOpinion[opinion.strength].failover === "other-providers"
        ? await this.withFallback({ request, resolved, execute, label: "structured request", shouldRethrow: rethrown, excluded: [opinion.avoid.provider] })
        : await this.pinned(request, resolved, execute, "structured request", rethrown);
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      throw new SecondOpinionUnanswered(opinion, { provider: resolved.providerName, model: resolved.modelConfig.id }, rules, { cause: error });
    }
  }

  /** The judge of work at `judges` under the judge rule, else JudgeUnavailable. */
  private judge(judges: CapabilityLevel, excluded: readonly string[], site: KnownLLMSite | undefined): ResolvedProvider {
    const resolved = this.registry.resolveJudge(judges, excluded, site);
    this.reportEqualJudge(judges, resolved, site);
    return resolved;
  }

  /** A failover for `request` that avoids `excluded`, asked at the same tier: a judging request's is a judge too. */
  private fallbackFor(request: TierAsk & { site?: KnownLLMSite }, excluded: readonly string[]): ResolvedProvider | null {
    if (request.judges === undefined) return this.registry.resolveFallback(request.capability, excluded, request.site);
    const fallback = this.registry.resolveJudgeFallback(request.judges, excluded, request.site);
    if (fallback !== null) this.reportEqualJudge(request.judges, fallback, request.site);
    return fallback;
  }

  /** A judge no stronger than the work it judges is named, with why the judge rule found none above it. */
  private reportEqualJudge(judges: CapabilityLevel, resolved: ResolvedJudge, site: KnownLLMSite | undefined): void {
    if (resolved.relation !== "equal") return;
    console.warn(
      `[LLMGateway] the judge of work at ${judges} (site=${site ?? "none"}) is ${resolved.providerName}/${resolved.modelConfig.id}, ` +
        `graded ${this.registry.gradeAt(resolved.modelConfig, site)} as called there: no stronger than the work, since ${describeEqualJudge(this.registry.rules.judge)}`,
    );
  }

  /** One request to `resolved` with no fallback; a failure not opted out by `shouldRethrow` is a ProviderError naming whose it was. */
  private async pinned<TRequest, TResult>(
    request: TRequest,
    resolved: ResolvedProvider,
    execute: (request: TRequest, resolved: ResolvedProvider) => Promise<TResult>,
    label: string,
    shouldRethrow: (error: unknown) => boolean,
  ): Promise<TResult> {
    try {
      return await execute(request, resolved);
    } catch (error) {
      if (shouldRethrow(error)) throw error;
      throw new ProviderError(
        resolved.providerName,
        `${label} on model=${resolved.modelConfig.id} failed (${describeErrorChain(error)}); it is pinned to that model, with no fallback`,
        providerFailureOf(error),
        { cause: error },
      );
    }
  }

  private async executeStructuredCall<T>(
    request: StructuredRequest<T>,
    resolved: ResolvedProvider,
    scope: CallScope,
  ): Promise<StructuredResponse<T>> {
    if (sendsStructuredSchema(resolved.providerType)) {
      return await this.executeGenerateObject(request, resolved, scope);
    }
    return await this.executeTextStructured(request, resolved, scope);
  }

  /**
   * Sends ONE provider request and returns its result with the instant it was
   * sent, which prices it. The gate admits it first, so a refused request (an
   * unpriced model, or a worst-case cost over a spend cap) never reaches the
   * network. A request that throws is settled as an error before the throw
   * continues; one that `abortSignal` cancelled is settled as `aborted` and
   * throws ModelCallAborted. Once `abortSignal` has aborted, nothing is admitted or sent.
   */
  private async send<R>({ scope, resolved, operation, size, abortSignal, request }: {
    readonly scope: CallScope;
    readonly resolved: CallTarget;
    readonly operation: LlmCallOperation;
    readonly size: RequestSize;
    readonly abortSignal: AbortSignal;
    readonly request: () => Promise<R>;
  }): Promise<{ readonly result: R; readonly requestedAt: Date; readonly admitted: AdmittedCall }> {
    if (abortSignal.aborted) throw new ModelCallAborted({ stage: "before-send" }, abortSignal.reason);
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
      if (abortSignal.aborted) {
        await this.settle(admitted, { requestedAt, usage, finishReason: "no-response", outcome: ABORTED, providerError: error });
        throw new ModelCallAborted(
          { stage: "in-flight", provider: resolved.providerName, model: resolved.modelConfig.id, callId: admitted.request.callId },
          abortSignal.reason,
          { cause: error },
        );
      }
      const failure = failureOfRequest(error);
      await this.settle(admitted, { requestedAt, usage, finishReason: failure.finishReason, outcome: failure.outcome, providerError: error });
      throw configurationRejectionOf(error, resolved) ?? error;
    }
  }

  /** Settles an admitted provider request through its gate. A throw from the gate fails the call (Discipline A). */
  private async settle(
    admitted: AdmittedCall,
    { requestedAt, usage, finishReason, outcome, providerError }: {
      readonly requestedAt: Date;
      readonly usage: ExtractedUsage | null;
      readonly finishReason: LlmFinishReason;
      readonly outcome: LlmCallOutcome;
      readonly providerError?: unknown;
    },
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
    // Judged before the gate admits the request: a schema the provider refuses is never sent or spent on.
    refuseUnacceptableSchema(
      { site, provider: resolved.providerName, providerType: resolved.providerType, model: resolved.modelConfig.id, sentAs: "structured output" },
      "structured-output",
      await wireSchemaOf(request.schema),
    );
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
        abortSignal: request.abortSignal,
      });
    let sent: {
      readonly result: GenerateObjectResult<T>;
      readonly requestedAt: Date;
      readonly admitted: AdmittedCall;
    };
    try {
      sent = await this.send({ scope, resolved, operation, size, abortSignal: request.abortSignal, request: call });
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
      await this.settle(admitted, { requestedAt, usage: extraction, finishReason, outcome: TRUNCATED });
      throw new StructuredOutputTruncated({
        provider: resolved.providerName,
        model: resolved.modelConfig.id,
        maxTokens: budget.maxOutputTokens,
        reasoningAllowance: budget.reasoningAllowance,
        outputTokens: extraction.reported.outputTokens,
        reasoningTokens: extraction.reasoningTokens,
        // generateObject keeps no raw text on success; this is the parsed object re-serialized.
        // eslint-disable-next-line no-restricted-syntax -- policy default: diagnostic text of an over-budget success; JSON.stringify returns undefined only for an undefined object
        text: JSON.stringify(result.object) ?? "",
      });
    }

    await this.settle(admitted, { requestedAt, usage: extraction, finishReason, outcome: OK });

    return {
      data: result.object,
      usage: extraction.usage,
      provider: resolved.providerName,
      model: resolved.modelConfig.id,
      grade: this.registry.gradeAt(resolved.modelConfig, site),
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
    // A provider answering in text never receives the schema as a request parameter, so the schema
    // the answer is validated against travels in the prompt: a required field the caller's own prose
    // leaves implicit is still stated.
    const prompt = textStructuredPrompt(request.prompt, request.schema);
    const requestBytes = utf8Bytes(prompt, request.systemPrompt);
    const { providerOptions, budget } = this.thinkingFor(resolved, site, request.maxTokens, requestBytes);
    const params: Parameters<typeof generateText>[0] = {
      model: resolved.provider,
      prompt,
      system: request.systemPrompt,
      maxOutputTokens: budget.maxOutputTokens,
      maxRetries: 0,
      providerOptions,
      abortSignal: request.abortSignal,
    };
    const size: RequestSize = { requestBytes, maxOutputTokens: budget.maxOutputTokens };
    const { result, requestedAt, admitted } = await this.send({
      scope,
      resolved,
      operation,
      size,
      abortSignal: request.abortSignal,
      request: () => generateText(params),
    });

    // `result.usage` sums the steps and drops each step's raw usage; with no
    // tools there is one step, whose usage keeps it.
    const [onlyStep] = result.steps;
    const extraction = extractUsage(result.steps.length === 1 && onlyStep ? onlyStep.usage : result.usage);
    const finishReason = recordedFinishReason(result.finishReason);

    // Checked before any parse: a value cut off at maxTokens is never parsed,
    // even when the text that arrived happens to be valid JSON.
    if (finishReason === "length") {
      await this.settle(admitted, { requestedAt, usage: extraction, finishReason, outcome: TRUNCATED });
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
      await this.settle(admitted, { requestedAt, usage: extraction, finishReason, outcome: OK });
      return {
        data: parsed.data,
        usage: extraction.usage,
        provider: resolved.providerName,
        model: resolved.modelConfig.id,
        grade: this.registry.gradeAt(resolved.modelConfig, site),
      };
    }

    await this.settle(admitted, {
      requestedAt,
      usage: extraction,
      finishReason,
      outcome: { kind: "error", errorKind: parsed.errorKind },
    });
    throw new SchemaValidationError([...parsed.errors, `Raw LLM response: ${result.text.slice(0, 500)}`], resolved.modelConfig.id);
  }

  resolveModel(capability: CapabilityLevel, site: KnownLLMSite): ResolvedModel {
    return this.resolvedModelOf(this.registry.resolve(capability, [], site), site);
  }

  /**
   * The model `resolveModel` gives `capability` at `site` when its context window is larger than
   * `windowTokens`, else the cheapest enabled model graded at or above `capability` whose window
   * is; null when the catalog offers none. What a task whose attempt overflowed a window of
   * `windowTokens` is dispatched on next: never that model again, nor one no larger.
   */
  resolveModelWithWindowAbove(capability: CapabilityLevel, site: KnownLLMSite, windowTokens: number): ResolvedModel | null {
    const routed = this.registry.resolve(capability, [], site);
    if (routed.modelConfig.maxContextTokens > windowTokens) return this.resolvedModelOf(routed, site);
    const wider = this.registry.resolveWithWindowAbove(capability, windowTokens, site);
    return wider === null ? null : this.resolvedModelOf(wider, site);
  }

  private resolvedModelOf(resolved: ResolvedProvider, site: KnownLLMSite): ResolvedModel {
    return {
      model: resolved.provider,
      modelId: resolved.modelConfig.id,
      provider: resolved.providerName,
      modelConfig: resolved.modelConfig,
      effectiveCapability: this.registry.gradeAt(resolved.modelConfig, site),
    };
  }
}

/**
 * HTTP statuses with which a provider rejects a request as Ashara configured it (its
 * credentials, its account, its endpoint or model id) rather than for what the request said.
 */
const CONFIGURATION_REJECTION_STATUSES: ReadonlySet<number> = new Set([401, 402, 403, 404]);

/** A provider's rejection of Ashara's configuration, as its own class; `null` for any other request failure. */
/** Judged before the gate admits a turn: a tool schema the provider refuses is never sent or spent on. */
function refuseUnacceptableTools(request: TurnRequest, target: CallTarget, site: KnownLLMSite): void {
  for (const [name, tool] of Object.entries(request.tools)) {
    refuseUnacceptableSchema(
      { site, provider: target.providerName, providerType: target.providerType, model: target.modelConfig.id, sentAs: `tool "${name}" input` },
      "tool-input",
      tool.inputSchema,
    );
  }
}

/**
 * Judged before the gate admits a turn: a request whose projected input cannot fit the window beside
 * the output reserve is never sent or spent on.
 */
function refuseOverflowingTurn(request: TurnRequest, target: CallTarget, outputReserveTokens: number): void {
  const window = target.modelConfig.maxContextTokens;
  const projection = projectTurnInput(request.priorInputTokens, request);
  const preflight = contextPreflight(projection, window, outputReserveTokens);
  if (preflight.kind === "context_budget_exceeded") {
    throw new ContextBudgetExceeded({
      provider: target.providerName,
      model: target.modelConfig.id,
      windowTokens: window,
      outputReserveTokens,
      breach: { source: "preflight", projectedInputTokens: preflight.projectedInputTokens, basis: describeProjection(projection) },
    });
  }
}

function configurationRejectionOf(error: unknown, resolved: CallTarget): ProviderConfigurationRejected | null {
  if (!APICallError.isInstance(error) || error.statusCode === undefined) return null;
  if (!CONFIGURATION_REJECTION_STATUSES.has(error.statusCode)) return null;
  return new ProviderConfigurationRejected(resolved.providerName, resolved.modelConfig.id, error.statusCode, { cause: error });
}

/**
 * The prompt of a structured request to a provider that answers in text: the caller's prompt, then
 * the JSON Schema the answer is validated against, whole.
 * @testseam gateway.test.ts asserts the schema it carries; executeTextStructured is its production caller
 */
export function textStructuredPrompt(prompt: string, schema: StructuredRequest<unknown>["schema"]): string {
  return (
    `${prompt}\n\nRespond with valid JSON only. No markdown, no explanation. The JSON must validate against this JSON Schema: ` +
    `every property it lists as required is present, with the type it names, and no property it does not list:\n${schemaText(schema)}`
  );
}

type ParsedStructuredText<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly errorKind: "InvalidJson" | "SchemaMismatch"; readonly errors: string[] };

/** Characters of an unparseable answer shown on each side of where the parser stopped. */
const SYNTAX_CONTEXT_CHARS = 120;

/**
 * Where a text that is not JSON stopped parsing, as the parser said it, with the text around that
 * point: the error a re-ask names, so a model is told what to correct, not only that it failed.
 */
function syntaxError(detail: string, jsonText: string): string {
  const at = /position (\d+)/.exec(detail);
  const position = at?.[1] === undefined ? null : Number(at[1]);
  if (position === null || !Number.isSafeInteger(position)) {
    return `Invalid JSON (${detail}); it is ${jsonText.length} characters and ends ${JSON.stringify(jsonText.slice(-SYNTAX_CONTEXT_CHARS))}`;
  }
  const before = jsonText.slice(Math.max(0, position - SYNTAX_CONTEXT_CHARS), position);
  const after = jsonText.slice(position, position + SYNTAX_CONTEXT_CHARS);
  return `Invalid JSON (${detail}): the text before that point is ${JSON.stringify(before)} and from it ${JSON.stringify(after)}`;
}

/** @testseam gateway.test.ts asserts the errors a re-ask names; executeTextStructured is its production caller */
export function parseStructuredText<T>(text: string, schema: StructuredRequest<T>["schema"]): ParsedStructuredText<T> {
  const jsonText = extractJson(text);
  try {
    return { ok: true, data: parseJson(schema, jsonText, "structured output text") };
  } catch (err) {
    if (!(err instanceof JsonParseFailed)) throw err;
    if (err.stage === "syntax") return { ok: false, errorKind: "InvalidJson", errors: [syntaxError(err.detail, jsonText)] };
    return { ok: false, errorKind: "SchemaMismatch", errors: [...err.issues] };
  }
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
  // eslint-disable-next-line no-restricted-syntax -- policy default: diagnostic text of a response already classed as a failure
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
 * one response (`asLanguageModelUsage` in the pinned `ai`) and drops when it sums
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
    // eslint-disable-next-line no-restricted-syntax -- policy default: tallies for the attempt record only; `reported` keeps every null and alone prices a call (measureCost)
    inputTokens: reported.inputTokens ?? 0,
    // eslint-disable-next-line no-restricted-syntax -- policy default: tallies for the attempt record only; `reported` keeps every null and alone prices a call (measureCost)
    outputTokens: reported.outputTokens ?? 0,
    // eslint-disable-next-line no-restricted-syntax -- policy default: tallies for the attempt record only; `reported` keeps every null and alone prices a call (measureCost)
    cacheReadTokens: reported.cacheReadTokens ?? 0,
    // eslint-disable-next-line no-restricted-syntax -- policy default: tallies for the attempt record only; `reported` keeps every null and alone prices a call (measureCost)
    cacheWriteTokens: reported.cacheWriteTokens ?? 0,
  };
  return { usage, reported, reasoningTokens: reportedReasoning(sdkUsage?.raw) };
}
