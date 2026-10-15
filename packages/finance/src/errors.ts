import { describeErrorChain } from "@ashara/shared";

/**
 * Base for a refusal Finance raises BEFORE a provider request (UnpricedModel,
 * BudgetExceeded, SpendEstimateInvalid). Model Access never retries one on a
 * fallback model: the request was never sent, and another model would meet the
 * same price list and the same cap.
 */
export class PreCallRefusal extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PreCallRefusal";
  }
}

interface LlmCallNotRecordedContext {
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
export class LlmCallNotRecorded extends Error {
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

interface LlmCallNotAdmittedContext {
  readonly projectId: string;
  readonly callSite: string;
  readonly provider: string;
  readonly model: string;
  readonly operation: string;
}

/**
 * The recorder's pre-call check broke instead of answering: its spend read or its
 * pending-row write failed. That is not a refusal (`PreCallRefusal`), and the request was
 * never sent. A fallback model would meet the same ledger, so it is never retried; the
 * recorder's own error is `cause`.
 */
export class LlmCallNotAdmitted extends Error {
  readonly context: LlmCallNotAdmittedContext;

  constructor(context: LlmCallNotAdmittedContext, options: ErrorOptions) {
    super(
      `llm_calls admission failed before any request for provider="${context.provider}" model="${context.model}" ` +
        `operation="${context.operation}" callSite="${context.callSite}" project=${context.projectId}: ` +
        describeErrorChain(options.cause),
      options,
    );
    this.name = "LlmCallNotAdmitted";
    this.context = context;
  }
}

interface LlmCallCostMissingContext {
  readonly projectId: string;
  readonly callSite: string;
  readonly provider: string;
  readonly model: string;
  /** How many costs the turn's gate recorded; exactly one is expected. */
  readonly recorded: number;
}

/**
 * A turn returned without exactly one recorded cost. A turn is one provider
 * request, so its gate records once; any other count means a request went
 * unrecorded or was recorded twice, and the turn is not returned as a success.
 */
export class LlmCallCostMissing extends Error {
  readonly context: LlmCallCostMissingContext;

  constructor(context: LlmCallCostMissingContext) {
    super(
      `a turn for provider="${context.provider}" model="${context.model}" callSite="${context.callSite}" ` +
        `project=${context.projectId} returned with ${context.recorded} recorded cost(s); exactly one is expected`,
    );
    this.name = "LlmCallCostMissing";
    this.context = context;
  }
}

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
  /** Summed from llm_calls rows no longer pending: each call's cost, or its pre-call estimate when unmeasured. */
  readonly spentUsd: number;
  /** Estimates of calls admitted and not recorded yet: llm_calls rows in state 'pending' (migration 053). */
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
          `(npx tsx scripts/project.ts unblock ${context.scope.projectId} --reason <why the cap is cleared>).`
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
