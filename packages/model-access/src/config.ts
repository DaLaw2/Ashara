import { z } from "zod";
import { parseCapabilityLevel } from "./capability-level.js";
import { InvalidGatewayCatalog } from "./errors.js";
import { widestTurnOutputReserve } from "./thinking.js";
import { PROVIDER_TYPES } from "./types.js";
import type {
  ContextOverflowSignatures,
  GatewayConfig,
  ModelConfig,
  ProviderConfig,
  ProviderType,
  RoutingProfiles,
  ThinkingPolicy,
  TokenRates,
} from "./types.js";

/**
 * A provider's credentials for gateway configuration. Decoupled from the
 * source: the server resolves keys from its secret store.
 */
export interface ProviderCredential {
  readonly name: string;
  /** The provider_configs row's `provider_type`, unvalidated; parsed against {@link PROVIDER_TYPES} here. */
  readonly providerType: string;
  readonly apiKey?: string | null;
  readonly baseUrl?: string | null;
}

const ProviderTypeSchema = z.enum(PROVIDER_TYPES);

/** Fails closed on a provider_type no SDK adapter serves, naming the row. */
function parseProviderType(source: string, providerName: string, raw: string): ProviderType {
  const parsed = ProviderTypeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new InvalidGatewayCatalog(source, [
      `provider "${providerName}": provider_type "${raw}" is not one of ${PROVIDER_TYPES.join(", ")}`,
    ]);
  }
  return parsed.data;
}

/**
 * Build a {@link GatewayConfig} from an already-loaded model catalog,
 * routing profiles, and provider credentials.
 *
 * The caller owns the credential source: the server resolves each key from
 * its secret store (`provider/<name>/api_key`). The spend cap is Finance's,
 * applied by its guarded port before every request.
 *
 * A row with no catalog model, or with no key (no base URL for a local one),
 * is left out: storing a key is how the owner enables a provider (policy). It
 * is logged at warn, since leaving one out changes the enabled-provider combo
 * and so the routing profile that applies. Zero providers leaves
 * `defaultProvider` null, which `buildGateway` refuses.
 *
 * Throws {@link InvalidGatewayCatalog} when a provider row's model has a window no larger than the
 * output a turn reserves in it at some site under `thinking` (reserveIssues).
 */
export function buildGatewayConfig(
  allModels: Record<string, ModelConfig>,
  routingProfiles: RoutingProfiles,
  credentials: readonly ProviderCredential[],
  contextOverflow: ContextOverflowSignatures,
  thinking: ThinkingPolicy,
): GatewayConfig {
  const modelsByProvider: Record<string, Record<string, ModelConfig>> = {};
  for (const [id, model] of Object.entries(allModels)) {
    if (!modelsByProvider[model.provider]) {
      modelsByProvider[model.provider] = {};
    }
    modelsByProvider[model.provider][id] = model;
  }

  const providers: ProviderConfig[] = [];
  const reserve: string[] = [];
  for (const cred of credentials) {
    const providerType = parseProviderType("provider_configs", cred.name, cred.providerType);
    const providerModels = modelsByProvider[cred.name];
    if (!providerModels) {
      console.warn(`[GatewayConfig] provider "${cred.name}" left out: no model_configs row names it`);
      continue;
    }
    reserve.push(...reserveIssues(Object.values(providerModels), providerType, thinking));

    const hasCredentials =
      (cred.apiKey != null && cred.apiKey !== "") ||
      (providerType === "local" && cred.baseUrl != null);
    if (!hasCredentials) {
      console.warn(
        `[GatewayConfig] provider "${cred.name}" left out: no API key` +
          (providerType === "local" ? " and no base URL" : ""),
      );
      continue;
    }

    providers.push({
      name: cred.name,
      providerType,
      apiKey: cred.apiKey ?? undefined,
      baseUrl: cred.baseUrl ?? undefined,
      models: Object.values(providerModels),
      enabled: true,
    });
  }
  if (reserve.length > 0) throw new InvalidGatewayCatalog("model_configs", reserve);

  return {
    providers,
    defaultProvider: providers.length > 0 ? providers[0].name : null,
    routingProfiles,
    contextOverflow,
    thinking,
  };
}

/**
 * Why a provider's models cannot serve a turn: a window no larger than the output a turn reserves
 * in it at some site (thinking.ts widestTurnOutputReserve, the reserve the gateway's preflight
 * takes), so no turn's input would fit there and every turn at that site would be refused. Judged
 * at boot rather than at the first attempt.
 */
function reserveIssues(models: readonly ModelConfig[], providerType: ProviderType, thinking: ThinkingPolicy): string[] {
  const widest = widestTurnOutputReserve(providerType, thinking);
  return models
    .filter((model) => model.maxContextTokens <= widest.tokens)
    .map(
      (model) =>
        `${model.id}: maxContextTokens ${model.maxContextTokens} is not larger than the ${widest.tokens} output tokens a turn ` +
        `reserves in it (provider type ${providerType}, site ${widest.site}), so no turn's input would fit`,
    );
}

// ---------------------------------------------------------------------------
// Catalog model rows (model_configs with their model_price_windows and model_price_tiers)
// ---------------------------------------------------------------------------

interface CatalogPriceWindow {
  readonly isoWeekday: number;
  readonly utcStartMinute: number;
  readonly utcEndMinute: number;
  readonly inputCostPer1m: number;
  readonly outputCostPer1m: number;
  readonly cacheReadCostPer1m: number | null;
  readonly cacheWriteCostPer1m: number | null;
}

interface CatalogPriceTier {
  readonly minInputTokens: number;
  readonly inputCostPer1m: number;
  readonly outputCostPer1m: number;
  readonly cacheReadCostPer1m: number | null;
  readonly cacheWriteCostPer1m: number | null;
}

interface CatalogModel {
  readonly modelId: string;
  readonly providerName: string;
  readonly apiModelId: string | null;
  readonly capability: string;
  readonly inputCostPer1m: number;
  readonly outputCostPer1m: number;
  readonly cacheReadCostPer1m: number | null;
  readonly cacheWriteCostPer1m: number | null;
  readonly maxContextTokens: number;
  readonly priceWindows: readonly CatalogPriceWindow[];
  readonly priceTiers: readonly CatalogPriceTier[];
}

/**
 * Why a model's price windows cannot be applied: two windows of one weekday
 * overlap (the rate at an instant would be ambiguous), or a window bills a
 * cache class the base rates do not, or the reverse.
 */
function priceWindowIssues(model: CatalogModel): string[] {
  const issues: string[] = [];
  const windows = model.priceWindows;
  for (const [i, w] of windows.entries()) {
    const where = `${model.modelId}.priceWindows[${i}]`;
    if (w.utcStartMinute >= w.utcEndMinute) issues.push(`${where}: start ${w.utcStartMinute} >= end ${w.utcEndMinute}`);
    if ((w.cacheReadCostPer1m === null) !== (model.cacheReadCostPer1m === null)) {
      issues.push(`${where}: cache read rate ${w.cacheReadCostPer1m} vs base ${model.cacheReadCostPer1m}`);
    }
    if ((w.cacheWriteCostPer1m === null) !== (model.cacheWriteCostPer1m === null)) {
      issues.push(`${where}: cache write rate ${w.cacheWriteCostPer1m} vs base ${model.cacheWriteCostPer1m}`);
    }
    for (const [j, other] of windows.entries()) {
      if (j <= i || other.isoWeekday !== w.isoWeekday) continue;
      if (w.utcStartMinute < other.utcEndMinute && other.utcStartMinute < w.utcEndMinute) {
        issues.push(`${where} overlaps priceWindows[${j}] on ISO weekday ${w.isoWeekday}`);
      }
    }
  }
  return issues;
}

/**
 * Why a model's prompt-length tiers cannot be applied: a threshold that is not
 * a positive integer, two tiers at one threshold, a tier that bills a cache
 * class the base rates do not (or the reverse), or tiers together with price
 * windows, which no catalog model has and no rule combines.
 */
function priceTierIssues(model: CatalogModel): string[] {
  const issues: string[] = [];
  const tiers = model.priceTiers;
  if (tiers.length > 0 && model.priceWindows.length > 0) {
    issues.push(`${model.modelId}: has both priceTiers and priceWindows; no rule combines a prompt-length tier with a time window`);
  }
  for (const [i, t] of tiers.entries()) {
    const where = `${model.modelId}.priceTiers[${i}]`;
    if (!Number.isInteger(t.minInputTokens) || t.minInputTokens <= 0) {
      issues.push(`${where}: minInputTokens ${t.minInputTokens} is not a positive integer`);
    }
    if ((t.cacheReadCostPer1m === null) !== (model.cacheReadCostPer1m === null)) {
      issues.push(`${where}: cache read rate ${t.cacheReadCostPer1m} vs base ${model.cacheReadCostPer1m}`);
    }
    if ((t.cacheWriteCostPer1m === null) !== (model.cacheWriteCostPer1m === null)) {
      issues.push(`${where}: cache write rate ${t.cacheWriteCostPer1m} vs base ${model.cacheWriteCostPer1m}`);
    }
    for (const [j, other] of tiers.entries()) {
      if (j > i && other.minInputTokens === t.minInputTokens) {
        issues.push(`${where} and priceTiers[${j}] share the threshold ${t.minInputTokens}`);
      }
    }
  }
  return issues;
}

/**
 * Why a model's context window cannot be used: it is not a positive integer. The window has no
 * default anywhere (migration 054): a model whose window is unknown cannot have its turns guarded
 * (context-window.ts), so it fails the catalog at boot rather than at the first attempt. Whether
 * the window holds input beside a turn's output reserve depends on the provider type and the
 * thinking policy, so buildGatewayConfig judges that (reserveIssues).
 */
function windowIssues(model: CatalogModel): string[] {
  const window: unknown = model.maxContextTokens;
  if (typeof window !== "number" || !Number.isInteger(window) || window <= 0) {
    return [`${model.modelId}: maxContextTokens ${String(window)} is not a positive integer; the model's context window must be catalogued`];
  }
  return [];
}

function toTokenRates(rates: CatalogPriceWindow | CatalogPriceTier | CatalogModel): TokenRates {
  return {
    inputCostPer1M: rates.inputCostPer1m,
    outputCostPer1M: rates.outputCostPer1m,
    cacheReadCostPer1M: rates.cacheReadCostPer1m,
    cacheWriteCostPer1M: rates.cacheWriteCostPer1m,
  };
}

/**
 * One catalog model (a model_configs row with its model_price_windows and
 * model_price_tiers) as the gateway's {@link ModelConfig}. Throws
 * {@link InvalidGatewayCatalog} naming `source` and the model when its context
 * window is not a positive integer, or its price windows or tiers cannot be
 * applied unambiguously.
 */
export function toModelConfig(source: string, m: CatalogModel): ModelConfig {
  const issues = [...windowIssues(m), ...priceWindowIssues(m), ...priceTierIssues(m)];
  if (issues.length > 0) throw new InvalidGatewayCatalog(source, issues);
  return {
    id: m.modelId,
    apiModelId: m.apiModelId ?? m.modelId,
    provider: m.providerName,
    capabilityLevel: parseCapabilityLevel(m.capability),
    maxContextTokens: m.maxContextTokens,
    ...toTokenRates(m),
    priceWindows: m.priceWindows.map((w) => ({
      isoWeekday: w.isoWeekday,
      utcStartMinute: w.utcStartMinute,
      utcEndMinute: w.utcEndMinute,
      rates: toTokenRates(w),
    })),
    priceTiers: m.priceTiers.map((t) => ({ minInputTokens: t.minInputTokens, rates: toTokenRates(t) })),
  };
}
