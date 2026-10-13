import { join } from "node:path";
import type { CapabilityLevel } from "@ashara/shared";
import { loadModelsConfigPathEnvOverride } from "@ashara/shared";
import { resolveAsharaRoot } from "./paths.js";
import type { ModelConfig, TokenRates } from "./types.js";

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
 * to process.cwd(): agent-runner subprocesses run with cwd = task worktree, so
 * a cwd-relative default silently fails to find the file there (rp-t2 -- see
 * paths.ts). Shared so routing-profile loading looks at the exact same file
 * pricing does -- one source of truth per config load.
 */
export function resolveModelsConfigPath(configPath?: string): string {
  return configPath
    ?? loadModelsConfigPathEnvOverride()
    ?? join(resolveAsharaRoot(), "config", "models.toml");
}

/** The rates in force at `at`: the price window covering it, else the model's base rates. */
function ratesAt(model: ModelConfig, at: Date): TokenRates {
  const isoWeekday = at.getUTCDay() === 0 ? 7 : at.getUTCDay();
  const minute = at.getUTCHours() * 60 + at.getUTCMinutes();
  const window = model.priceWindows.find(
    (w) => w.isoWeekday === isoWeekday && minute >= w.utcStartMinute && minute < w.utcEndMinute,
  );
  return window ? window.rates : model;
}

/** The rate for `tokens` of one cache class; `null` when there are tokens but the model bills no such class. */
function cacheRate(tokens: number, rate: number | null): number | null {
  if (tokens === 0) return 0;
  return rate;
}

/**
 * The USD cost of one call made at `at`, or `null` when a reported cache
 * class has no rate for this model. `inputTokens` includes both cache classes.
 * The caller supplies `at`: the rate depends on it, and this function reads no clock.
 */
export function calculateCost(
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
  model: ModelConfig,
  at: Date,
): { inputCost: number; outputCost: number; cacheSavings: number; totalCost: number } | null {
  const rates = ratesAt(model, at);
  const readRate = cacheRate(cacheReadTokens, rates.cacheReadCostPer1M);
  const writeRate = cacheRate(cacheWriteTokens, rates.cacheWriteCostPer1M);
  if (readRate === null || writeRate === null) return null;

  const standardInputTokens = inputTokens - cacheReadTokens - cacheWriteTokens;
  const inputCost =
    (standardInputTokens * rates.inputCostPer1M + cacheReadTokens * readRate + cacheWriteTokens * writeRate) /
    1_000_000;
  const outputCost = (outputTokens / 1_000_000) * rates.outputCostPer1M;
  const cacheSavings = (cacheReadTokens / 1_000_000) * (rates.inputCostPer1M - readRate);

  return { inputCost, outputCost, cacheSavings, totalCost: inputCost + outputCost };
}
