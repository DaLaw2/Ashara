import { describeErrorChain } from "@ashara/shared";

export class GatewayError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GatewayError";
  }
}

export class ProviderError extends GatewayError {
  readonly provider: string;

  constructor(provider: string, message: string, options?: ErrorOptions) {
    super(`Provider "${provider}": ${message}`, options);
    this.name = "ProviderError";
    this.provider = provider;
  }
}

/**
 * Thrown when no enabled provider has a model at or above the requested
 * capability. There is no downgrade: a lower-tier model is never substituted.
 */
export class NoProviderAvailableError extends GatewayError {
  readonly capability: string;
  /** `id (capability)` of every model the enabled providers offered. */
  readonly availableModels: readonly string[];

  constructor(capability: string, availableModels: readonly string[]) {
    super(
      `No provider available for capability level "${capability}" or above ` +
        `(available models: ${availableModels.length > 0 ? availableModels.join(", ") : "none"})`,
    );
    this.name = "NoProviderAvailableError";
    this.capability = capability;
    this.availableModels = availableModels;
  }
}

/** A pinned model names a provider this gateway was not configured with. */
export class UnknownProvider extends GatewayError {
  readonly provider: string;
  readonly configuredProviders: readonly string[];

  constructor(provider: string, configuredProviders: readonly string[]) {
    super(
      `Provider "${provider}" is not configured in this gateway ` +
        `(configured: ${configuredProviders.length > 0 ? configuredProviders.join(", ") : "none"})`,
    );
    this.name = "UnknownProvider";
    this.provider = provider;
    this.configuredProviders = configuredProviders;
  }
}

export interface RoutingProfileUnresolvedContext {
  /** Enabled-provider combo whose profile was consulted, e.g. "anthropic+deepseek". */
  readonly combo: string;
  readonly site: string;
  readonly capability: string;
  /** Model the profile maps the site to; `null` when no entry covers the capability. */
  readonly mappedModel: string | null;
  /** Providers searched for `mappedModel` (enabled, minus any excluded by a fallback). */
  readonly searchedProviders: readonly string[];
}

/**
 * Thrown when a NON-EMPTY (curated) routing profile cannot resolve a request:
 * the site's table covers neither the requested capability nor `default`, or
 * the mapped model is on no searched provider. Falling through to capability
 * logic would silently land the call on a model the profile was written to
 * avoid, so the miss fails closed instead.
 */
export class RoutingProfileUnresolved extends GatewayError {
  readonly combo: string;
  readonly site: string;
  readonly capability: string;
  readonly mappedModel: string | null;
  readonly searchedProviders: readonly string[];

  constructor(context: RoutingProfileUnresolvedContext) {
    const reason =
      context.mappedModel === null
        ? `has no entry covering this site at this capability (and no "default")`
        : `maps it to model "${context.mappedModel}", which no searched provider ` +
          `(${context.searchedProviders.length > 0 ? context.searchedProviders.join(", ") : "none"}) offers`;
    super(
      `Routing profile "${context.combo}" cannot resolve site="${context.site}" ` +
        `(capability="${context.capability}"): the profile ${reason}`,
    );
    this.name = "RoutingProfileUnresolved";
    this.combo = context.combo;
    this.site = context.site;
    this.capability = context.capability;
    this.mappedModel = context.mappedModel;
    this.searchedProviders = context.searchedProviders;
  }
}

export class SchemaValidationError extends GatewayError {
  readonly errors: string[];

  constructor(errors: string[], options?: ErrorOptions) {
    super(`Schema validation failed: ${errors.join("; ")}`, options);
    this.name = "SchemaValidationError";
    this.errors = errors;
  }
}

/**
 * A structured request stopped at its `maxTokens` (finish reason `length`)
 * without a valid result. A failed attempt to the reliability ladder, like any
 * schema failure; its own class so the cause is not read as a malformed answer.
 */
export class StructuredOutputTruncated extends SchemaValidationError {
  readonly provider: string;
  readonly model: string;
  readonly maxTokens: number | null;
  readonly outputTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly textLength: number;

  constructor(
    context: {
      readonly provider: string;
      readonly model: string;
      readonly maxTokens: number | null;
      readonly outputTokens: number | null;
      readonly reasoningTokens: number | null;
      readonly text: string;
    },
    options?: ErrorOptions,
  ) {
    super(
      [
        `output truncated: ${context.provider}/${context.model} stopped at maxTokens=${context.maxTokens ?? "provider default"} ` +
          `(finish reason length; output tokens ${context.outputTokens ?? "unreported"}, of which reasoning ` +
          `${context.reasoningTokens ?? "unreported"}; text length ${context.text.length})`,
        `Raw LLM response: ${context.text.slice(0, 500)}`,
      ],
      options,
    );
    this.name = "StructuredOutputTruncated";
    this.provider = context.provider;
    this.model = context.model;
    this.maxTokens = context.maxTokens;
    this.outputTokens = context.outputTokens;
    this.reasoningTokens = context.reasoningTokens;
    this.textLength = context.text.length;
  }
}

/** Thrown by `loadThinkingPolicyFromToml` when a present `[thinking]` table fails validation. */
export class InvalidThinkingPolicy extends GatewayError {
  readonly configPath: string;
  readonly issues: readonly string[];

  constructor(configPath: string, issues: readonly string[]) {
    super(
      `Invalid [thinking] table in ${configPath}: ${issues.join("; ")}. ` +
        `Expected default = "off" | "on" and an optional [thinking.sites] table keyed by known LLM sites.`,
    );
    this.name = "InvalidThinkingPolicy";
    this.configPath = configPath;
    this.issues = issues;
  }
}

/**
 * Thrown by `buildGateway` when zero LLM providers are configured.
 *
 * Per ADR-030 (docs/decisions.md), this is the structural fix for the
 * "run silently executes on stubs" failure class — a mis-set provider
 * config must refuse to start, never fall back to a stub silently.
 */
export class NoLLMProvidersConfigured extends GatewayError {
  /** Config sources the caller checked before concluding zero providers were available. */
  readonly checkedSources: readonly string[];
  /** Actionable remediation surfaced to the operator. */
  readonly howToFix: string;

  constructor(checkedSources: readonly string[], howToFix: string) {
    super(
      `No LLM providers configured (checked: ${checkedSources.join(", ") || "none"}). ${howToFix}`,
    );
    this.name = "NoLLMProvidersConfigured";
    this.checkedSources = checkedSources;
    this.howToFix = howToFix;
  }
}

/**
 * Thrown when a catalog row (model_configs, provider_configs) cannot be turned
 * into gateway configuration. Carries the source table and a list of issues
 * for diagnosis (Discipline C).
 */
export class InvalidGatewayCatalog extends GatewayError {
  readonly source: string;
  readonly issues: readonly string[];

  constructor(source: string, issues: readonly string[]) {
    super(
      `Invalid gateway catalog at ${source}: ${issues.join("; ") || "unknown error"}`,
    );
    this.name = "InvalidGatewayCatalog";
    this.source = source;
    this.issues = issues;
  }
}

function quoteList(values: readonly string[]): string {
  return values.map((v) => `"${v}"`).join(", ") || "none";
}

export interface RoutingProfileIncompleteContext {
  /** Enabled-provider combo whose profile is short a site, e.g. "anthropic+deepseek". */
  readonly combo: string;
  /** `KNOWN_LLM_SITES` entries the profile fails to map. */
  readonly missingSites: readonly string[];
  /** Site keys the profile DOES map, so the operator sees the shape they are extending. */
  readonly mappedSites: readonly string[];
  /** models.toml path the profile was loaded from. */
  readonly configPath: string;
  readonly howToFix: string;
}

/**
 * Thrown by `buildGateway` when the deployment's enabled-provider combo has a
 * NON-EMPTY routing profile that fails to map every `KNOWN_LLM_SITES` entry.
 *
 * A non-empty profile is a curated allocation, so a hole in it is always a
 * bug: the unmapped site falls through to capability logic and silently lands
 * on whatever model that picks — which may be exactly the provider the
 * profile was written to reserve. Refuse-to-start makes that a boot failure
 * instead of a per-call surprise (ADR-030 refuse-to-start precedent).
 */
export class RoutingProfileIncomplete extends GatewayError {
  readonly combo: string;
  readonly missingSites: readonly string[];
  readonly mappedSites: readonly string[];
  readonly configPath: string;
  readonly howToFix: string;

  constructor(context: RoutingProfileIncompleteContext) {
    super(
      `Routing profile "${context.combo}" is incomplete: no model mapped for site(s) ` +
        `${quoteList(context.missingSites)}. Mapped sites: ${quoteList(context.mappedSites)}. ` +
        `Config: ${context.configPath}. ${context.howToFix}`,
    );
    this.name = "RoutingProfileIncomplete";
    this.combo = context.combo;
    this.missingSites = context.missingSites;
    this.mappedSites = context.mappedSites;
    this.configPath = context.configPath;
    this.howToFix = context.howToFix;
  }
}

export interface RoutingProfileModelMissingContext {
  /** Enabled-provider combo whose profile names the models. */
  readonly combo: string;
  /** `"<site>" -> "<model>"` for every mapping whose model no enabled provider offers. */
  readonly missing: readonly string[];
  /** Enabled providers searched. */
  readonly providers: readonly string[];
  /** models.toml path the profile was loaded from. */
  readonly configPath: string;
}

/**
 * Thrown by `buildGateway` when the deployment's routing profile names a model
 * no enabled provider offers: a model removed from model_configs, renamed, or
 * misspelled. Every request routed to it would fail; this fails the boot instead.
 */
export class RoutingProfileModelMissing extends GatewayError {
  readonly combo: string;
  readonly missing: readonly string[];
  readonly providers: readonly string[];
  readonly configPath: string;

  constructor(context: RoutingProfileModelMissingContext) {
    super(
      `Routing profile "${context.combo}" names model(s) no enabled provider offers: ` +
        `${context.missing.join(", ")}. Providers searched: ${quoteList(context.providers)}. ` +
        `Config: ${context.configPath}. Map the site(s) to a model present in model_configs, ` +
        "or add the model to model_configs in a migration.",
    );
    this.name = "RoutingProfileModelMissing";
    this.combo = context.combo;
    this.missing = context.missing;
    this.providers = context.providers;
    this.configPath = context.configPath;
  }
}

/**
 * Thrown by `loadRoutingProfilesFromToml` when a models.toml that IS present
 * and IS parseable carries a `[routing.profiles]` block that fails schema
 * validation — most often a site key that is not a `KNOWN_LLM_SITES` entry
 * (a typo, or a key left behind after the call site was deleted).
 *
 * Deliberately NOT degraded to "no profiles": dropping the whole block on a
 * one-key typo would send every site to capability routing, the same silent
 * mis-route the boot completeness check exists to prevent, and the stale key
 * would disappear without a trace. A missing or unparseable file still
 * degrades — that is a deployment shape, not an authoring error.
 */
/**
 * Thrown by `createLanguageModel` when an openai-compatible provider has no
 * `baseUrl`. The AI SDK defaults to `https://api.openai.com/v1` when
 * `baseURL` is absent, so a NULL value silently routes traffic to the wrong
 * vendor. Discipline A: absence must fail closed, not resolve to a default
 * that changes the destination.
 */
export class ProviderMissingBaseUrl extends GatewayError {
  readonly provider: string;
  readonly howToFix: string;

  constructor(provider: string) {
    const howToFix =
      `Set base_url for provider "${provider}" in the provider_configs table ` +
      `(e.g. UPDATE provider_configs SET base_url = 'https://...' WHERE name = '${provider}'), ` +
      `or disable the provider by removing its key (secret provider/${provider}/api_key).`;
    super(
      `Provider "${provider}" has no base_url configured. Without a base_url, ` +
        `the AI SDK defaults to https://api.openai.com/v1 — traffic would silently ` +
        `route to OpenAI instead of ${provider}. ${howToFix}`,
    );
    this.name = "ProviderMissingBaseUrl";
    this.provider = provider;
    this.howToFix = howToFix;
  }
}

export class InvalidRoutingProfiles extends GatewayError {
  readonly configPath: string;
  readonly issues: readonly string[];
  readonly howToFix: string;

  constructor(configPath: string, issues: readonly string[], howToFix: string) {
    super(
      `Invalid [routing.profiles] in ${configPath}: ${issues.join("; ") || "schema validation failed"}. ` +
        howToFix,
    );
    this.name = "InvalidRoutingProfiles";
    this.configPath = configPath;
    this.issues = issues;
    this.howToFix = howToFix;
  }
}

/**
 * Base for a refusal raised by the call recorder BEFORE a provider request
 * (Finance's UnpricedModel and BudgetExceeded). The gateway never retries one on
 * a fallback model: the request was never sent, and another model would meet the
 * same price list and the same cap.
 */
export class PreCallRefusal extends GatewayError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PreCallRefusal";
  }
}

/** A recorded gateway was called without a call context, so the call could not be attributed to a project. */
export class LlmCallContextMissing extends GatewayError {
  readonly operation: string;

  constructor(operation: string) {
    super(
      `LLMGateway.${operation} was called without a call context on a gateway that records every call. ` +
        `Call gateway.forCall({ projectId, taskId, callSite }).generateStructured(...) instead; ` +
        `a call with no project cannot be written to llm_calls and is refused.`,
    );
    this.name = "LlmCallContextMissing";
    this.operation = operation;
  }
}

/** `forCall` was used on a gateway built with `recording: { kind: "unrecorded" }`. */
export class LlmCallRecorderMissing extends GatewayError {
  readonly unrecordedReason: string;

  constructor(unrecordedReason: string) {
    super(
      `LLMGateway.forCall needs a call recorder, but this gateway was built unrecorded ` +
        `(reason given at construction: "${unrecordedReason}"). Build it with ` +
        `recording: { kind: "recorded", recorder } to attribute calls to a project.`,
    );
    this.name = "LlmCallRecorderMissing";
    this.unrecordedReason = unrecordedReason;
  }
}

export interface LlmCallNotRecordedContext {
  readonly projectId: string;
  readonly callSite: string;
  readonly provider: string;
  readonly model: string;
  readonly operation: string;
  /** The provider call's own outcome, which the failed write was recording. */
  readonly callOutcome: string;
  /** The provider call's error when it failed too; `undefined` for a successful call. */
  readonly providerError: unknown;
}

/**
 * The recorder could not write the row for a provider call. The call fails:
 * a spend that reached the provider but not the ledger must not be returned
 * as a success. The write error is `cause`; the provider's own error, when the
 * call failed as well, is `context.providerError`.
 */
export class LlmCallNotRecorded extends GatewayError {
  readonly context: LlmCallNotRecordedContext;

  constructor(context: LlmCallNotRecordedContext, options: ErrorOptions) {
    const writeError = describeErrorChain(options.cause);
    super(
      `llm_calls row not written for provider="${context.provider}" model="${context.model}" ` +
        `operation="${context.operation}" callSite="${context.callSite}" project=${context.projectId} ` +
        `(call outcome: ${context.callOutcome}): ${writeError}`,
      options,
    );
    this.name = "LlmCallNotRecorded";
    this.context = context;
  }
}

/**
 * A tool passed to `generateTurn` carries an `execute` function. The gateway
 * sends tool schemas only and never runs a tool: Z0 executes every tool call.
 * Raised before any provider request, so no llm_calls row is written.
 */
export class TurnToolExecutable extends GatewayError {
  readonly toolName: string;

  constructor(toolName: string) {
    super(
      `generateTurn received tool "${toolName}" with an execute function. Pass the tool's description and ` +
        `input schema only; the Workplace loop executes tool calls, the gateway never does.`,
    );
    this.name = "TurnToolExecutable";
    this.toolName = toolName;
  }
}

export interface TurnResponseInvalidContext {
  readonly provider: string;
  readonly model: string;
  readonly issues: readonly string[];
}

/** A turn's provider response did not validate: no single assistant message, or a malformed tool call. */
export class TurnResponseInvalid extends GatewayError {
  readonly context: TurnResponseInvalidContext;

  constructor(context: TurnResponseInvalidContext) {
    super(
      `generateTurn response from provider="${context.provider}" model="${context.model}" is invalid: ` +
        `${context.issues.join("; ") || "no issue reported"}`,
    );
    this.name = "TurnResponseInvalid";
    this.context = context;
  }
}
