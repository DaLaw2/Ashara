export class GatewayError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GatewayError";
  }
}

export interface BudgetExceededContext {
  /** Provider name the cap applies to (set for per-provider budget checks). */
  provider?: string;
  /** Cost of the call that tripped the check, estimated pre-call. */
  estimatedCost?: number;
}

export class BudgetExceededError extends GatewayError {
  readonly limit: string;
  readonly spent: number;
  readonly budget: number;
  readonly provider?: string;
  readonly estimatedCost?: number;

  constructor(
    limit: string,
    spent: number,
    budget: number,
    context?: BudgetExceededContext,
  ) {
    const providerPart = context?.provider ? `, provider="${context.provider}"` : "";
    const estimatePart =
      context?.estimatedCost !== undefined
        ? `, estimatedCost=$${context.estimatedCost.toFixed(4)}`
        : "";
    super(
      `Budget exceeded: ${limit} limit of $${budget.toFixed(4)} reached (spent $${spent.toFixed(4)}${estimatePart}${providerPart})`,
    );
    this.name = "BudgetExceededError";
    this.limit = limit;
    this.spent = spent;
    this.budget = budget;
    this.provider = context?.provider;
    this.estimatedCost = context?.estimatedCost;
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
 * Thrown when the gateway catalog — from a file or an HTTP response — is
 * absent, unparseable, or structurally invalid. Carries the source (file
 * path or URL) and a list of issues for diagnosis (Discipline C).
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

export interface TemperatureNotHonoredContext {
  /** Temperature the caller explicitly asked for — the promise that was broken. */
  readonly requestedTemperature: number;
  /** Catalog model id the request resolved to. */
  readonly model: string;
  /** Provider that served the call. */
  readonly provider: string;
  /** `KNOWN_LLM_SITES` tag of the call, or "unknown" when the caller sent none. */
  readonly site: string;
  /** SDK entry point that produced the warning (generateText/streamText/generateObject/...). */
  readonly operation: string;
  /** The provider's own explanation, copied verbatim from the SDK warning. */
  readonly details: string | undefined;
  readonly howToFix: string;
}

/**
 * Thrown when a call explicitly requested a temperature and the provider
 * reported — via the AI SDK's structured `warnings` — that it dropped the
 * parameter and sampled however it liked.
 *
 * Discipline A names `temperature: 0` as the mechanism for deterministic
 * operations (decomposition, classification, stack derivation).
 * Sending the parameter is not the guarantee; the provider HONORING it is.
 * Anthropic models with `rejectsSamplingParameters` and OpenAI reasoning
 * models silently ignore it, so without this check the determinism guarantee
 * evaporates into an SDK log line and a non-deterministic result is accepted
 * as if it were deterministic — the exact "continue as if success" shape
 * Discipline A forbids.
 *
 * Deliberately NOT a per-model catalog flag: Anthropic also drops temperature
 * whenever extended thinking is enabled, a per-CALL runtime condition no
 * static capability table can predict. The warning is the only signal that
 * reflects what actually happened.
 */
export class TemperatureNotHonored extends GatewayError {
  readonly requestedTemperature: number;
  readonly model: string;
  readonly provider: string;
  readonly site: string;
  readonly operation: string;
  readonly details: string | undefined;
  readonly howToFix: string;

  constructor(context: TemperatureNotHonoredContext) {
    super(
      `Temperature not honored: requested temperature=${context.requestedTemperature} for model ` +
        `"${context.model}" (provider="${context.provider}", site="${context.site}", ` +
        `operation="${context.operation}"), but the provider reported it unsupported and ignored it ` +
        `— the result is NOT deterministic. Provider detail: ${context.details ?? "none reported"}. ` +
        context.howToFix,
    );
    this.name = "TemperatureNotHonored";
    this.requestedTemperature = context.requestedTemperature;
    this.model = context.model;
    this.provider = context.provider;
    this.site = context.site;
    this.operation = context.operation;
    this.details = context.details;
    this.howToFix = context.howToFix;
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
      `or disable the provider by removing its api_key.`;
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
