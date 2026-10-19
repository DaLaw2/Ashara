import type { ModelConfig, ReportedTokens, TokenRates } from "@ashara/model-access";

/** A token class that enters a call's price. */
type PricedTokenClass = keyof ReportedTokens;

/**
 * A call's cost in USD, or why it is unmeasured: the classes whose count the
 * provider did not report though the model bills them, and the classes with
 * reported tokens the model has no rate for. An unmeasured cost carries no
 * number, so no consumer can read it as 0.
 */
export type CostMeasurement =
  | {
      readonly measured: true;
      readonly inputCost: number;
      readonly outputCost: number;
      readonly cacheSavings: number;
      readonly totalCost: number;
    }
  | {
      readonly measured: false;
      readonly missingCounts: readonly PricedTokenClass[];
      readonly missingRates: readonly PricedTokenClass[];
    };

/**
 * The base rates in force at `at`: the dated price with the latest
 * `effectiveFrom` not after `at`, else the model's undated base rates.
 */
function baseRatesAt(model: ModelConfig, at: Date): TokenRates {
  const instant = at.getTime();
  const inForce = model.datedPrices
    .filter((p) => p.effectiveFrom.getTime() <= instant)
    .reduce<ModelConfig["datedPrices"][number] | undefined>(
      (latest, p) => (latest === undefined || p.effectiveFrom.getTime() > latest.effectiveFrom.getTime() ? p : latest),
      undefined,
    );
  return inForce ? inForce.rates : model;
}

/**
 * The rates a call is billed at: the highest prompt-length tier its input
 * count reaches, else the price window covering `at`, else the base rates in
 * force at `at`. The catalog refuses a model with both tiers and windows, or
 * with dated prices beside either (`toModelConfig`), so none of them combine.
 */
function ratesFor(model: ModelConfig, at: Date, inputTokens: number | null): TokenRates {
  // An unreported input count leaves the call unmeasured (measureCost), so no tier is ever chosen for it.
  const tier = model.priceTiers
    .filter((t) => inputTokens !== null && inputTokens >= t.minInputTokens)
    .reduce<ModelConfig["priceTiers"][number] | undefined>(
      (best, t) => (best === undefined || t.minInputTokens > best.minInputTokens ? t : best),
      undefined,
    );
  if (tier) return tier.rates;
  const isoWeekday = at.getUTCDay() === 0 ? 7 : at.getUTCDay();
  const minute = at.getUTCHours() * 60 + at.getUTCMinutes();
  const window = model.priceWindows.find(
    (w) => w.isoWeekday === isoWeekday && minute >= w.utcStartMinute && minute < w.utcEndMinute,
  );
  return window ? window.rates : baseRatesAt(model, at);
}

type CachePrice = { readonly tokens: number; readonly rate: number } | "missing-count" | "missing-rate";

/**
 * One cache class's tokens and rate. A class the model bills must be reported:
 * unreported, its split from plain input is unknown. A class the model does
 * not bill is plain input when unreported, and unpriceable when reported.
 */
function cachePrice(reported: number | null, rate: number | null): CachePrice {
  if (reported === null) return rate === null ? { tokens: 0, rate: 0 } : "missing-count";
  if (reported === 0) return { tokens: 0, rate: 0 };
  return rate === null ? "missing-rate" : { tokens: reported, rate };
}

/**
 * The USD cost of one call made at `at` from the counts its provider reported,
 * or the classes that leave it unmeasured. `inputTokens` includes both cache
 * classes, and it alone selects a prompt-length tier, whose rates then apply to
 * every token of the call. The caller supplies `at`: the rate depends on it,
 * and this function reads no clock.
 */
export function measureCost(reported: ReportedTokens, model: ModelConfig, at: Date): CostMeasurement {
  const rates = ratesFor(model, at, reported.inputTokens);
  const missingCounts: PricedTokenClass[] = [];
  const missingRates: PricedTokenClass[] = [];
  if (reported.inputTokens === null) missingCounts.push("inputTokens");
  if (reported.outputTokens === null) missingCounts.push("outputTokens");
  const read = cachePrice(reported.cacheReadTokens, rates.cacheReadCostPer1M);
  const write = cachePrice(reported.cacheWriteTokens, rates.cacheWriteCostPer1M);
  if (read === "missing-count") missingCounts.push("cacheReadTokens");
  if (read === "missing-rate") missingRates.push("cacheReadTokens");
  if (write === "missing-count") missingCounts.push("cacheWriteTokens");
  if (write === "missing-rate") missingRates.push("cacheWriteTokens");
  if (
    reported.inputTokens === null ||
    reported.outputTokens === null ||
    typeof read === "string" ||
    typeof write === "string"
  ) {
    return { measured: false, missingCounts, missingRates };
  }

  const standardInputTokens = reported.inputTokens - read.tokens - write.tokens;
  const inputCost =
    (standardInputTokens * rates.inputCostPer1M + read.tokens * read.rate + write.tokens * write.rate) / 1_000_000;
  const outputCost = (reported.outputTokens / 1_000_000) * rates.outputCostPer1M;
  const cacheSavings = (read.tokens / 1_000_000) * (rates.inputCostPer1M - read.rate);

  return { measured: true, inputCost, outputCost, cacheSavings, totalCost: inputCost + outputCost };
}

/** The `warn` line for a call whose cost is unmeasured: which classes lack a count and which lack a rate. */
export function describeUnmeasuredCost(
  cost: Extract<CostMeasurement, { measured: false }>,
  provider: string,
  model: string,
): string {
  return (
    `cost unmeasured: provider=${provider}, model=${model}, ` +
    `unreported counts=[${cost.missingCounts.join(", ")}], ` +
    `reported tokens with no rate=[${cost.missingRates.join(", ")}]`
  );
}
