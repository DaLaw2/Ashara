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
