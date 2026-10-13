import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  loadProviderKeys,
  loadBudgetEnv,
  parseCapabilityLevel,
} from "@ashara/shared";
import { resolveModelsConfigPath } from "./pricing.js";
import { loadRoutingProfilesFromToml } from "./routing-profiles.js";
import { InvalidGatewayCatalog } from "./errors.js";
import { PROVIDER_TYPES } from "./types.js";
import type {
  GatewayConfig,
  ModelConfig,
  ProviderConfig,
  ProviderType,
  RoutingProfiles,
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
 * its secret store (`provider/<name>/api_key`). Budget config is still read
 * from env (it is deployment tuning, not a secret).
 */
export function buildGatewayConfig(
  allModels: Record<string, ModelConfig>,
  routingProfiles: RoutingProfiles,
  credentials: readonly ProviderCredential[],
): GatewayConfig {
  const budget = loadBudgetEnv();

  const modelsByProvider: Record<string, Record<string, ModelConfig>> = {};
  for (const [id, model] of Object.entries(allModels)) {
    if (!modelsByProvider[model.provider]) {
      modelsByProvider[model.provider] = {};
    }
    modelsByProvider[model.provider][id] = model;
  }

  const providers: ProviderConfig[] = [];
  for (const cred of credentials) {
    const providerType = parseProviderType("provider_configs", cred.name, cred.providerType);
    const providerModels = modelsByProvider[cred.name];
    if (!providerModels) continue;

    const hasCredentials =
      (cred.apiKey != null && cred.apiKey !== "") ||
      (providerType === "local" && cred.baseUrl != null);
    if (!hasCredentials) continue;

    providers.push({
      name: cred.name,
      providerType,
      apiKey: cred.apiKey ?? undefined,
      baseUrl: cred.baseUrl ?? undefined,
      models: Object.values(providerModels),
      enabled: true,
    });
  }

  const defaultProvider = providers.length > 0 ? providers[0].name : "local";

  return {
    providers,
    defaultProvider,
    budget: {
      maxCostTotal: budget.total,
      maxCostPerProvider: budget.perProvider,
    },
    routingProfiles,
  };
}

// ---------------------------------------------------------------------------
// Gateway catalog — one schema, one converter, one transport (file)
// ---------------------------------------------------------------------------

const RateSchema = z.number().nonnegative();
const CacheRateSchema = RateSchema.nullable();

const CatalogPriceWindowSchema = z.object({
  isoWeekday: z.number().int().min(1).max(7),
  utcStartMinute: z.number().int().min(0).max(1439),
  utcEndMinute: z.number().int().min(1).max(1440),
  inputCostPer1m: RateSchema,
  outputCostPer1m: RateSchema,
  cacheReadCostPer1m: CacheRateSchema,
  cacheWriteCostPer1m: CacheRateSchema,
});

const CatalogModelSchema = z.object({
  modelId: z.string().min(1),
  providerName: z.string().min(1),
  apiModelId: z.string().nullable(),
  capability: z.string().min(1),
  inputCostPer1m: z.number(),
  outputCostPer1m: z.number(),
  cacheReadCostPer1m: CacheRateSchema,
  cacheWriteCostPer1m: CacheRateSchema,
  maxContextTokens: z.number().int().positive(),
  priceWindows: z.array(CatalogPriceWindowSchema),
});

type CatalogModel = z.infer<typeof CatalogModelSchema>;
type CatalogPriceWindow = z.infer<typeof CatalogPriceWindowSchema>;

const CatalogProviderSchema = z.object({
  name: z.string().min(1),
  // Parsed by `parseProviderType` in the converter, so the server builds a catalog from raw rows.
  providerType: z.string().min(1),
  baseUrl: z.string().nullable(),
});

const GatewayCatalogSchema = z.object({
  models: z.array(CatalogModelSchema).min(1),
  providers: z.array(CatalogProviderSchema).min(1),
});

export type GatewayCatalog = z.infer<typeof GatewayCatalogSchema>;

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

function toTokenRates(rates: CatalogPriceWindow | CatalogModel): TokenRates {
  return {
    inputCostPer1M: rates.inputCostPer1m,
    outputCostPer1M: rates.outputCostPer1m,
    cacheReadCostPer1M: rates.cacheReadCostPer1m,
    cacheWriteCostPer1M: rates.cacheWriteCostPer1m,
  };
}

/**
 * One catalog model (a model_configs row with its model_price_windows) as the
 * gateway's {@link ModelConfig}. Throws {@link InvalidGatewayCatalog} naming
 * `source` when its price windows cannot be applied unambiguously.
 */
export function toModelConfig(source: string, m: CatalogModel): ModelConfig {
  const issues = priceWindowIssues(m);
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
  };
}

/**
 * Shared converter: turns a validated {@link GatewayCatalog} into a
 * {@link GatewayConfig}, called after schema validation. API keys and budget come from the process's own
 * environment, routing profiles from the local TOML.
 */
function buildConfigFromCatalog(source: string, catalog: GatewayCatalog): GatewayConfig {
  const modelsByProvider = new Map<string, ModelConfig[]>();
  for (const m of catalog.models) {
    const model = toModelConfig(source, m);
    const list = modelsByProvider.get(m.providerName);
    if (list) list.push(model);
    else modelsByProvider.set(m.providerName, [model]);
  }

  // Provider credentials come from this process's environment only: a catalog
  // never carries a key (ADR-075 C2). The agent-runner subprocess's env is
  // filled from the server's secret store; story s-isolated-worker-m1 removes
  // that path.
  const envKeys = loadProviderKeys();
  const envKeysByProvider: Record<string, string | undefined> = {
    anthropic: envKeys.anthropicApiKey,
    openai: envKeys.openaiApiKey,
    deepseek: envKeys.deepseekApiKey,
    mistral: envKeys.mistralApiKey,
    xai: envKeys.xaiApiKey,
    google: envKeys.googleApiKey,
  };

  const providers: ProviderConfig[] = [];
  for (const p of catalog.providers) {
    const providerType = parseProviderType(source, p.name, p.providerType);
    const models = modelsByProvider.get(p.name);
    if (!models || models.length === 0) continue;
    const resolvedKey = envKeysByProvider[p.name];
    const hasCredentials =
      resolvedKey !== undefined ||
      (providerType === "local" && (envKeys.localLlmUrl ?? p.baseUrl) != null);
    if (!hasCredentials) continue;
    providers.push({
      name: p.name,
      providerType,
      apiKey: resolvedKey,
      baseUrl:
        providerType === "local"
          ? (envKeys.localLlmUrl ?? p.baseUrl ?? undefined)
          : (p.baseUrl ?? undefined),
      models,
      enabled: true,
    });
  }

  const budget = loadBudgetEnv();
  const defaultProvider = providers.length > 0 ? providers[0].name : "local";
  const routingProfiles = loadRoutingProfilesFromToml(resolveModelsConfigPath());

  return {
    providers,
    defaultProvider,
    budget: {
      maxCostTotal: budget.total,
      maxCostPerProvider: budget.perProvider,
    },
    routingProfiles,
  };
}

/**
 * Validate a raw object against the catalog schema, returning the typed
 * catalog or throwing {@link InvalidGatewayCatalog} with the source and
 * Zod issue details.
 */
function validateCatalog(source: string, raw: unknown): GatewayCatalog {
  const parsed = GatewayCatalogSchema.safeParse(raw);
  if (!parsed.success) {
    throw new InvalidGatewayCatalog(
      source,
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    );
  }
  return parsed.data;
}

/**
 * File transport: read a catalog file, validate with Zod, convert to
 * {@link GatewayConfig}. Fail-closed on absent file, invalid JSON, or
 * schema failure.
 */
export async function loadGatewayCatalogFromFile(
  filePath: string,
): Promise<GatewayConfig> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (err) {
    throw new InvalidGatewayCatalog(filePath, [
      `file not readable: ${err instanceof Error ? err.message : String(err)}`,
    ]);
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new InvalidGatewayCatalog(filePath, [
      `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    ]);
  }

  return buildConfigFromCatalog(filePath, validateCatalog(filePath, json));
}
