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
import type { GatewayConfig, ModelConfig, ProviderConfig, RoutingProfiles, TokenRates } from "./types.js";

/**
 * A provider's credentials for gateway configuration. Decoupled from the
 * source: the server resolves keys from its secret store.
 */
export interface ProviderCredential {
  readonly name: string;
  readonly apiKey?: string | null;
  readonly baseUrl?: string | null;
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
    const providerModels = modelsByProvider[cred.name];
    if (!providerModels) continue;

    const hasCredentials =
      (cred.apiKey != null && cred.apiKey !== "") ||
      (cred.name === "local" && cred.baseUrl != null);
    if (!hasCredentials) continue;

    providers.push({
      name: cred.name,
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
// Gateway catalog — one schema, one converter, two transports (file, HTTP)
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
 * {@link GatewayConfig}. Both transports (file and HTTP) call this after
 * schema validation. API keys and budget come from the process's own
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
    const models = modelsByProvider.get(p.name);
    if (!models || models.length === 0) continue;
    const resolvedKey = envKeysByProvider[p.name];
    const hasCredentials =
      resolvedKey !== undefined ||
      (p.name === "local" && (envKeys.localLlmUrl ?? p.baseUrl) != null);
    if (!hasCredentials) continue;
    providers.push({
      name: p.name,
      apiKey: resolvedKey,
      baseUrl:
        p.name === "local"
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

/**
 * HTTP transport: fetch models and providers from the server API,
 * validate the combined payload with the same {@link GatewayCatalogSchema},
 * and convert to {@link GatewayConfig}. Used by the CLI
 * (`packages/cli/src/commands/vision.ts`).
 *
 * A malformed response now throws {@link InvalidGatewayCatalog} with the
 * server URL and Zod issue details instead of the previous unvalidated
 * `as` cast that would produce a confusing downstream crash.
 */
export async function loadGatewayConfigFromApi(
  serverUrl: string,
  apiToken: string,
): Promise<GatewayConfig> {
  const headers = { Authorization: `Bearer ${apiToken}` };

  const [modelsResp, providersResp] = await Promise.all([
    fetch(`${serverUrl}/config/models`, { headers }),
    fetch(`${serverUrl}/config/providers`, { headers }),
  ]);

  if (!modelsResp.ok) {
    throw new InvalidGatewayCatalog(serverUrl, [`/config/models returned ${modelsResp.status}`]);
  }
  if (!providersResp.ok) {
    throw new InvalidGatewayCatalog(serverUrl, [`/config/providers returned ${providersResp.status}`]);
  }

  const rawCatalog = {
    models: await modelsResp.json(),
    providers: await providersResp.json(),
  };

  return buildConfigFromCatalog(serverUrl, validateCatalog(serverUrl, rawCatalog));
}
