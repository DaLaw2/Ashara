import { PreCallRefusal } from "@ashara/llm-gateway";

interface UnpricedModelContext {
  readonly provider: string;
  readonly model: string;
  readonly inputCostPer1M: number;
  readonly outputCostPer1M: number;
}

const PRICE_SOURCE =
  "model_configs.input_cost_per_1m / output_cost_per_1m (the server's catalog, read at boot by " +
  "ConfigRepository.listModelConfigs; both columns are NOT NULL DEFAULT 0, so 0 is how an unset price reads)";

/**
 * A provider request was refused before it was sent: the model has no price,
 * so its cost could only ever be recorded as unknown. Raised by the ledger's
 * pre-call check; the gateway never retries it on a fallback model.
 */
export class UnpricedModel extends PreCallRefusal {
  readonly provider: string;
  readonly model: string;
  readonly inputCostPer1M: number;
  readonly outputCostPer1M: number;
  readonly priceSource: string;
  readonly howToFix: string;

  constructor(context: UnpricedModelContext) {
    const howToFix =
      `Set both prices for "${context.model}" (UPDATE model_configs SET input_cost_per_1m = <usd>, ` +
      `output_cost_per_1m = <usd> WHERE model_id = '${context.model}') and restart the server, ` +
      `or route the call to a priced model.`;
    super(
      `Model "${context.model}" (provider "${context.provider}") is unpriced: input_cost_per_1m=` +
        `${context.inputCostPer1M}, output_cost_per_1m=${context.outputCostPer1M}; both must be a ` +
        `positive number. The request was not sent. Prices come from ${PRICE_SOURCE}. ${howToFix}`,
    );
    this.name = "UnpricedModel";
    this.provider = context.provider;
    this.model = context.model;
    this.inputCostPer1M = context.inputCostPer1M;
    this.outputCostPer1M = context.outputCostPer1M;
    this.priceSource = PRICE_SOURCE;
    this.howToFix = howToFix;
  }
}

/** Which cap a refused call would have crossed. */
export type SpendCapScope =
  | { readonly kind: "project"; readonly projectId: string }
  | { readonly kind: "deployment" };

interface BudgetExceededContext {
  readonly scope: SpendCapScope;
  readonly provider: string;
  readonly model: string;
  readonly capUsd: number;
  /** Summed from llm_calls: each call's cost, or its pre-call estimate when unmeasured. */
  readonly spentUsd: number;
  /** Estimates of calls this process admitted and has not recorded yet. */
  readonly inFlightUsd: number;
  /** This call's worst-case cost. */
  readonly estimatedCostUsd: number;
}

function usd(value: number): string {
  return `$${value.toFixed(6)}`;
}

/**
 * A provider request was refused before it was sent: its worst-case cost on top
 * of the recorded spend would cross a spend cap. A project refusal has already
 * blocked the project (source budget_cap); a deployment refusal stops the loop.
 */
export class BudgetExceeded extends PreCallRefusal {
  readonly scope: SpendCapScope;
  readonly provider: string;
  readonly model: string;
  readonly capUsd: number;
  readonly spentUsd: number;
  readonly inFlightUsd: number;
  readonly estimatedCostUsd: number;
  readonly howToFix: string;

  constructor(context: BudgetExceededContext) {
    const subject =
      context.scope.kind === "project" ? `project ${context.scope.projectId}` : "the deployment (every project)";
    const howToFix =
      context.scope.kind === "project"
        ? `Raise ASHARA_PROJECT_BUDGET_LIMIT_USD and restart the server, then return the project to work ` +
          `(UPDATE projects SET status = 'active', blocked_error_class = NULL, blocked_reason = NULL ` +
          `WHERE id = '${context.scope.projectId}').`
        : `Raise ASHARA_BUDGET_LIMIT_USD and restart the server.`;
    super(
      `budget_cap: the spend cap of ${subject} is ${usd(context.capUsd)}, and this call would cross it: ` +
        `${usd(context.spentUsd)} spent (llm_calls) + ${usd(context.inFlightUsd)} in flight + ` +
        `${usd(context.estimatedCostUsd)} worst case for this call (provider "${context.provider}", ` +
        `model "${context.model}"). The request was not sent. ${howToFix}`,
    );
    this.name = "BudgetExceeded";
    this.scope = context.scope;
    this.provider = context.provider;
    this.model = context.model;
    this.capUsd = context.capUsd;
    this.spentUsd = context.spentUsd;
    this.inFlightUsd = context.inFlightUsd;
    this.estimatedCostUsd = context.estimatedCostUsd;
    this.howToFix = howToFix;
  }
}

/** A call's worst-case cost could not be computed, so no cap can admit it. */
export class SpendEstimateInvalid extends PreCallRefusal {
  readonly model: string;
  readonly requestBytes: number;
  readonly maxOutputTokens: number;
  readonly estimatedCostUsd: number;

  constructor(context: {
    readonly model: string;
    readonly requestBytes: number;
    readonly maxOutputTokens: number;
    readonly estimatedCostUsd: number;
  }) {
    super(
      `cannot estimate the worst-case cost of a call to "${context.model}": requestBytes=${context.requestBytes}, ` +
        `maxOutputTokens=${context.maxOutputTokens} gave ${context.estimatedCostUsd}; requestBytes must be a ` +
        `non-negative integer and maxOutputTokens a positive one. The request was not sent.`,
    );
    this.name = "SpendEstimateInvalid";
    this.model = context.model;
    this.requestBytes = context.requestBytes;
    this.maxOutputTokens = context.maxOutputTokens;
    this.estimatedCostUsd = context.estimatedCostUsd;
  }
}

/** The configured caps are not positive amounts, or the project cap exceeds the deployment cap. */
export class SpendCapsInvalid extends Error {
  readonly deploymentUsd: number;
  readonly perProjectUsd: number;

  constructor(caps: { readonly deploymentUsd: number; readonly perProjectUsd: number }) {
    super(
      `spend caps are invalid: deployment=${caps.deploymentUsd}, perProject=${caps.perProjectUsd}; both must be ` +
        `positive finite USD amounts and the project cap must not exceed the deployment cap ` +
        `(ASHARA_BUDGET_LIMIT_USD, ASHARA_PROJECT_BUDGET_LIMIT_USD)`,
    );
    this.name = "SpendCapsInvalid";
    this.deploymentUsd = caps.deploymentUsd;
    this.perProjectUsd = caps.perProjectUsd;
  }
}
