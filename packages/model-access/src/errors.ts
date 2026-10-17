import { describeErrorChain } from "@ashara/shared";
import type { CapabilityLevel } from "./capability-level.js";
import type { ModelIdentity, SecondOpinion } from "./types.js";

export class GatewayError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GatewayError";
  }
}

/**
 * Whose failure a provider request that failed with no fallback left was, read from what it threw:
 * - "provider": the provider failed the request: a 5xx status, a timeout (408) or throttling (429)
 *   status, no answer at all (connection refused or reset, name resolution), or a response body that
 *   was empty or not in the API's shape. Not the model's answer: none was read.
 * - "ashara": anything else: a rejection of Ashara's configuration (401, 402, 403, 404), any other
 *   4xx rejection of the request Ashara built (400, 413, 422, ...), and Ashara's own code. An error
 *   the gateway does not recognise as the provider's is Ashara's to look into. When a request and its
 *   fallback both failed, Ashara's fault on either is Ashara's.
 */
export type ProviderFailure = "provider" | "ashara";

/**
 * A provider request failed: a structured request on its provider and on any fallback, or an agent
 * turn on its pinned model; `failure` says whose failure it was.
 */
export class ProviderError extends GatewayError {
  readonly provider: string;
  readonly failure: ProviderFailure;

  constructor(provider: string, message: string, failure: ProviderFailure, options?: ErrorOptions) {
    super(`Provider "${provider}": ${message} (${failure === "provider" ? "the provider failed the request" : "a fault on Ashara's side"})`, options);
    this.name = "ProviderError";
    this.provider = provider;
    this.failure = failure;
  }
}

/**
 * Thrown when no enabled provider has a model at or above the requested
 * capability. There is no downgrade: a lower-tier model is never substituted.
 */
export class NoProviderAvailableError extends GatewayError {
  readonly capability: CapabilityLevel;
  /** `id (capability)` of every model the enabled providers offered. */
  readonly availableModels: readonly string[];

  constructor(capability: CapabilityLevel, availableModels: readonly string[]) {
    super(
      `No provider available for capability level "${capability}" or above: no enabled provider offers a model ` +
        `graded at that level or higher, and no lower model is substituted ` +
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

interface RoutingProfileUnresolvedContext {
  /** Enabled-provider combo whose profile was consulted, e.g. "anthropic+deepseek". */
  readonly combo: string;
  readonly site: string;
  readonly capability: CapabilityLevel;
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
  readonly capability: CapabilityLevel;
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
  /**
   * The model whose answer failed (its config id, as llm_calls records it), so a failed ladder
   * attempt names the model that was called; null when no model answered.
   */
  readonly model: string | null;

  constructor(errors: string[], model: string | null, options?: ErrorOptions) {
    super(`Schema validation failed: ${errors.join("; ")}`, options);
    this.name = "SchemaValidationError";
    this.errors = errors;
    this.model = model;
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
  /** The part of `maxTokens` the gateway added for reasoning; 0 when the request was not sent with thinking on. */
  readonly reasoningAllowance: number;
  readonly textLength: number;

  constructor(
    context: {
      readonly provider: string;
      readonly model: string;
      /** The bound the request was sent with, reasoning allowance included. */
      readonly maxTokens: number | null;
      readonly reasoningAllowance: number;
      readonly outputTokens: number | null;
      readonly reasoningTokens: number | null;
      readonly text: string;
    },
    options?: ErrorOptions,
  ) {
    const allReasoning =
      context.text.length === 0 && context.reasoningTokens !== null && context.reasoningTokens === context.outputTokens;
    super(
      [
        `output truncated: ${context.provider}/${context.model} stopped at maxTokens=${context.maxTokens ?? "provider default"} ` +
          `(of which reasoning allowance ${context.reasoningAllowance}; finish reason length; output tokens ` +
          `${context.outputTokens ?? "unreported"}, of which reasoning ${context.reasoningTokens ?? "unreported"}; ` +
          `text length ${context.text.length})` +
          (allReasoning ? ": the whole bound went to reasoning and no answer text was produced" : ""),
        `Raw LLM response: ${context.text.slice(0, 500)}`,
      ],
      context.model,
      options,
    );
    this.name = "StructuredOutputTruncated";
    this.provider = context.provider;
    this.model = context.model;
    this.maxTokens = context.maxTokens;
    this.reasoningAllowance = context.reasoningAllowance;
    this.outputTokens = context.outputTokens;
    this.reasoningTokens = context.reasoningTokens;
    this.textLength = context.text.length;
  }
}

/**
 * Thrown by `resolveAsharaRoot` when no ancestor of the module's directory carries the monorepo
 * signature. The process's cwd is not a substitute: it is wherever the process was started.
 */
export class AsharaRootNotFound extends GatewayError {
  /** Every directory checked, nearest first. */
  readonly searched: readonly string[];

  constructor(searched: readonly string[]) {
    super(
      `No Ashara root found: none of ${searched.join(", ")} holds both config/models.toml and packages/. ` +
        `Set ASHARA_MODELS_CONFIG to the models.toml path, or run from an Ashara checkout.`,
    );
    this.name = "AsharaRootNotFound";
    this.searched = searched;
  }
}

/**
 * Thrown when models.toml cannot be read or is not TOML. Its routing profiles and thinking policy
 * are deployment configuration, so an unreadable file is not "none configured".
 */
export class ModelsConfigUnreadable extends GatewayError {
  readonly configPath: string;
  /** Which table the reader was loading, e.g. "[routing.profiles]". */
  readonly table: string;

  constructor(configPath: string, table: string, cause: unknown) {
    super(`Cannot load ${table} from ${configPath}: ${describeErrorChain(cause)}`, { cause });
    this.name = "ModelsConfigUnreadable";
    this.configPath = configPath;
    this.table = table;
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
 * Per ADR-030 (docs/decisions/ADR-030-llm-boundary-reliability.md), this is the structural fix for the
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

interface RoutingProfileIncompleteContext {
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

interface RoutingProfileModelMissingContext {
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
 * Thrown by `createLanguageModel` when a `deepseek`, `local` or
 * `openai-compatible` provider has no `baseUrl`. The AI SDK falls back to its
 * own default endpoint when `baseURL` is absent, so a NULL value silently
 * routes traffic to an endpoint the deployment did not name. Discipline A:
 * absence must fail closed, not resolve to a default that changes the
 * destination.
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

/**
 * Thrown by `loadRoutingProfilesFromToml` when a models.toml that IS present
 * and IS parseable carries a `[routing.profiles]` block that fails schema
 * validation — most often a site key that is not a `KNOWN_LLM_SITES` entry
 * (a typo, or a key left behind after the call site was deleted).
 *
 * Deliberately NOT degraded to "no profiles": dropping the whole block on a
 * one-key typo would send every site to capability routing, the same silent
 * mis-route the boot completeness check exists to prevent, and the stale key
 * would disappear without a trace. A missing or unparseable file is
 * `ModelsConfigUnreadable`, a broken deployment.
 */
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
 * The provider rejected a request for how Ashara is configured to reach it: credentials
 * refused (401, 403), the account unable to pay (402), or no such endpoint or model (404).
 * The request's content was not judged. A fallback provider has its own configuration, so
 * the gateway still tries one; the provider's own error is `cause`.
 */
export class ProviderConfigurationRejected extends GatewayError {
  readonly provider: string;
  readonly model: string;
  readonly statusCode: number;

  constructor(provider: string, model: string, statusCode: number, options: ErrorOptions) {
    super(
      `Provider "${provider}" rejected model="${model}" with HTTP ${statusCode}, a rejection of Ashara's ` +
        `configuration (credentials, account, endpoint or model id): ${describeErrorChain(options.cause)}`,
      options,
    );
    this.name = "ProviderConfigurationRejected";
    this.provider = provider;
    this.model = model;
    this.statusCode = statusCode;
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

interface TurnResponseInvalidContext {
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

/**
 * Why an agent turn's input does not fit its model's context window:
 * - `preflight`: the gateway's projection of the request (context-window.ts), made before the
 *   request is admitted, exceeds the window less the output reserve; nothing was sent or spent.
 * - `provider`: the provider rejected the request it was sent as longer than the model's context,
 *   as its error data states (contextOverflowOf); `providerMessage` is the provider's own wording.
 */
type ContextBudgetBreach =
  | { readonly source: "preflight"; readonly projectedInputTokens: number; readonly basis: string }
  | { readonly source: "provider"; readonly providerMessage: string };

interface ContextBudgetExceededContext {
  readonly provider: string;
  readonly model: string;
  /** The model's catalogued context window (model_configs.max_context_tokens). */
  readonly windowTokens: number;
  /** Output tokens the request asks the window to hold besides its input. */
  readonly outputReserveTokens: number;
  readonly breach: ContextBudgetBreach;
}

/**
 * An agent turn whose input would not fit, or did not fit, its model's context window. The attempt
 * ends on it as `context_budget_exceeded`: there is no reduction and retry while compaction is
 * deferred (architecture §13.6).
 */
export class ContextBudgetExceeded extends GatewayError {
  readonly context: ContextBudgetExceededContext;

  constructor(context: ContextBudgetExceededContext, options?: ErrorOptions) {
    const where = `${context.provider}/${context.model} (window ${context.windowTokens} tokens, output reserve ${context.outputReserveTokens})`;
    const breach = context.breach;
    super(
      breach.source === "preflight"
        ? `context_budget_exceeded: the turn's projected input of ${breach.projectedInputTokens} tokens (${breach.basis}) exceeds ` +
            `${context.windowTokens - context.outputReserveTokens} tokens, the window of ${where} less its output reserve; the request was not sent`
        : `context_budget_exceeded: ${where} rejected the turn as longer than its context: ${breach.providerMessage}`,
      options,
    );
    this.name = "ContextBudgetExceeded";
    this.context = context;
  }
}

/**
 * A second opinion (StructuredRequest.secondOpinion) of one strength got no answer: the model the
 * catalog offered for it failed, and so did every failover an other-family opinion may take, none of
 * which is of the avoided provider. Never answered by a model of another strength instead.
 */
export class SecondOpinionUnanswered extends GatewayError {
  readonly opinion: SecondOpinion;
  /** The provider and model the request was routed to first. */
  readonly routedTo: ModelIdentity;

  constructor(opinion: SecondOpinion, routedTo: ModelIdentity, options: { readonly cause: unknown }) {
    super(
      `a ${opinion.strength} second opinion on ${opinion.avoid.provider}/${opinion.avoid.model} got no answer: routed to ` +
        `${routedTo.provider}/${routedTo.model}` +
        `${opinion.strength === "other-family" ? `, and no failover went to ${opinion.avoid.provider}` : ", with no failover to a model of another strength"}: ` +
        describeErrorChain(options.cause),
      options,
    );
    this.name = "SecondOpinionUnanswered";
    this.opinion = opinion;
    this.routedTo = routedTo;
  }
}

/**
 * The catalog offers no model for a second opinion of this strength at this capability: nothing was
 * sent. A NoProviderAvailableError, so a ladder's escalation tier reads it as a tier it cannot serve.
 */
export class SecondOpinionUnavailable extends NoProviderAvailableError {
  readonly opinion: SecondOpinion;

  constructor(opinion: SecondOpinion, capability: CapabilityLevel, availableModels: readonly string[]) {
    super(capability, availableModels);
    this.message =
      `no model serves a ${opinion.strength} second opinion on ${opinion.avoid.provider}/${opinion.avoid.model} at capability ` +
      `"${capability}" or above (${SECOND_OPINION_RULE[opinion.strength]}; enabled models: ${availableModels.length > 0 ? availableModels.join(", ") : "none"})`;
    this.name = "SecondOpinionUnavailable";
    this.opinion = opinion;
  }
}

/** Which models each strength may go to, as SecondOpinionUnavailable states it. */
const SECOND_OPINION_RULE: Readonly<Record<SecondOpinion["strength"], string>> = {
  "other-family": "it goes only to an enabled provider other than the avoided one",
  "same-family-other-model": "it goes only to another model of the avoided provider",
  "same-model": "it goes only to the avoided model itself, and only when no other model serves the capability",
};
