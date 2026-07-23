import { join } from "node:path";
import type { CapabilityLevel } from "@ashara/shared";
import { loadModelsConfigPathEnvOverride } from "@ashara/shared";
import { resolveAsharaRoot } from "./paths.js";
import type { ModelConfig } from "./types.js";

export const ANTHROPIC_CACHE_READ_MULTIPLIER = 0.1;
export const ANTHROPIC_CACHE_WRITE_MULTIPLIER = 1.25;

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

export function calculateCost(
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
  model: ModelConfig,
): { inputCost: number; outputCost: number; cacheSavings: number; totalCost: number } {
  const standardInputTokens = inputTokens - cacheReadTokens - cacheWriteTokens;
  const inputCost = (standardInputTokens / 1_000_000) * model.inputCostPer1M;

  const cacheReadCost = model.supportsCaching
    ? (cacheReadTokens / 1_000_000) * model.inputCostPer1M * ANTHROPIC_CACHE_READ_MULTIPLIER
    : (cacheReadTokens / 1_000_000) * model.inputCostPer1M;

  const cacheWriteCost = model.supportsCaching
    ? (cacheWriteTokens / 1_000_000) * model.inputCostPer1M * ANTHROPIC_CACHE_WRITE_MULTIPLIER
    : (cacheWriteTokens / 1_000_000) * model.inputCostPer1M;

  const outputCost = (outputTokens / 1_000_000) * model.outputCostPer1M;

  const fullInputCost = inputCost + cacheReadCost + cacheWriteCost;

  const cacheSavings = model.supportsCaching
    ? ((cacheReadTokens / 1_000_000) * model.inputCostPer1M * (1 - ANTHROPIC_CACHE_READ_MULTIPLIER))
    : 0;

  return {
    inputCost: fullInputCost,
    outputCost,
    cacheSavings,
    totalCost: fullInputCost + outputCost,
  };
}
