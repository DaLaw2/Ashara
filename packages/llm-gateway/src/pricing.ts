import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import type { CapabilityLevel } from "@ashara/shared";
import { loadModelsConfigPathEnvOverride, parseCapabilityLevel } from "@ashara/shared";
import { resolveAsharaRoot } from "./paths.js";
import type { FormatGroup, ModelConfig } from "./types.js";

export const ANTHROPIC_CACHE_READ_MULTIPLIER = 0.1;
export const ANTHROPIC_CACHE_WRITE_MULTIPLIER = 1.25;

export const CAPABILITY_RANK: Record<CapabilityLevel, number> = {
  Light: 0,
  Medium: 1,
  Strong: 2,
  Frontier: 3,
};

interface TomlModelEntry {
  provider: string;
  capability: CapabilityLevel;
  format_group?: FormatGroup;
  strict_mode?: boolean;
  api_model_id?: string;
  input_cost_per_1m: number;
  output_cost_per_1m: number;
  max_context_tokens: number;
  supports_caching: boolean;
}

export function loadModelsFromToml(configPath: string): Record<string, ModelConfig> {
  const raw = readFileSync(configPath, "utf-8");
  const parsed = parse(raw) as { models?: Record<string, TomlModelEntry> };

  if (!parsed.models) {
    return {};
  }

  const result: Record<string, ModelConfig> = {};
  for (const [id, entry] of Object.entries(parsed.models)) {
    const capabilityLevel = parseCapabilityLevel(String(entry.capability));
    result[id] = {
      id,
      apiModelId: entry.api_model_id ?? id,
      provider: entry.provider,
      capabilityLevel,
      formatGroup: entry.format_group,
      strictMode: entry.strict_mode ?? false,
      inputCostPer1M: entry.input_cost_per_1m,
      outputCostPer1M: entry.output_cost_per_1m,
      maxContextTokens: entry.max_context_tokens,
      supportsCaching: entry.supports_caching,
    };
  }
  return result;
}

const FALLBACK_MODELS: Record<string, ModelConfig> = {
  "claude-sonnet-4-6": {
    id: "claude-sonnet-4-6",
    apiModelId: "claude-sonnet-4-6",
    provider: "anthropic",
    capabilityLevel: "Strong",
    inputCostPer1M: 3,
    outputCostPer1M: 15,
    maxContextTokens: 1_000_000,
    supportsCaching: true,
  },
  local: {
    id: "local",
    apiModelId: "local",
    provider: "local",
    capabilityLevel: "Light",
    inputCostPer1M: 0,
    outputCostPer1M: 0,
    maxContextTokens: 8_192,
    supportsCaching: false,
  },
};

/**
 * Resolves the models.toml path the same way for every reader of that file
 * (pricing, routing profiles). Precedence, highest first:
 *   1. an explicit `configPath` argument (test/caller override),
 *   2. the `ASHARA_MODELS_CONFIG` env var (operator override),
 *   3. the module-anchored repo default `<ashara-root>/config/models.toml`.
 * The default is anchored to the Ashara checkout via `resolveAsharaRoot()`, NOT
 * to process.cwd(): agent-runner subprocesses run with cwd = task worktree, so
 * a cwd-relative default silently fails to find the file there (rp-t2 — see
 * paths.ts). Shared so routing-profile loading looks at the exact same file
 * pricing does — one source of truth per config load.
 */
export function resolveModelsConfigPath(configPath?: string): string {
  return configPath
    ?? loadModelsConfigPathEnvOverride()
    ?? join(resolveAsharaRoot(), "config", "models.toml");
}

export function loadModelsWithFallback(configPath?: string): Record<string, ModelConfig> {
  const resolvedPath = resolveModelsConfigPath(configPath);

  try {
    return loadModelsFromToml(resolvedPath);
  } catch (err) {
    console.warn(`[Pricing] model config load failed (${resolvedPath}), using fallback:`, err instanceof Error ? err.message : err);
    return { ...FALLBACK_MODELS };
  }
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
