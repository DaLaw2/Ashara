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

export class NoProviderAvailableError extends GatewayError {
  readonly capability: string;

  constructor(capability: string) {
    super(
      `No provider available for capability level "${capability}"`,
    );
    this.name = "NoProviderAvailableError";
    this.capability = capability;
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
 * Thrown by `buildGateway` when zero LLM providers are configured and the
 * explicit `ASHARA_TEST_STUB_LLM=1` test escape hatch is not set.
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
