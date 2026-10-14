import { join } from "node:path";
import type { CapabilityLevel } from "@ashara/shared";
import { loadModelsConfigPathEnvOverride } from "@ashara/shared";
import { resolveAsharaRoot } from "./paths.js";
import type { CostMeasurement, ModelConfig, PricedTokenClass, ReportedTokens, TokenRates } from "./types.js";

export const CAPABILITY_RANK: Record<CapabilityLevel, number> = {
  Light: 0,
  Medium: 1,
  Strong: 2,
  Frontier: 3,
};

/**
 * Resolves the models.toml path the same way for every reader of that file
 * (routing profiles). Precedence, highest first:
 *   1. an explicit `configPath` argument (test/caller override),
 *   2. the `ASHARA_MODELS_CONFIG` env var (operator override),
 *   3. the module-anchored repo default `<ashara-root>/config/models.toml`.
 * The default is anchored to the Ashara checkout via `resolveAsharaRoot()`, NOT
 * to process.cwd(): a process whose cwd is elsewhere silently fails to find a
 * cwd-relative default (rp-t2 -- see paths.ts). Shared so routing-profile loading looks at the exact same file
 * pricing does -- one source of truth per config load.
 */
export function resolveModelsConfigPath(configPath?: string): string {
  return configPath
    ?? loadModelsConfigPathEnvOverride()
    ?? join(resolveAsharaRoot(), "config", "models.toml");
}

/**
 * The rates a call is billed at: the highest prompt-length tier its input
 * count reaches, else the price window covering `at`, else the model's base
 * rates. The catalog refuses a model with both tiers and windows
 * (`toModelConfig`), so the two never combine.
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
  return window ? window.rates : model;
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
