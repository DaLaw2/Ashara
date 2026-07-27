import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { CapabilityLevel } from "@ashara/shared";
import {
  loadProviderKeys,
  loadProviderBaseUrls,
  loadBudgetEnv,
  parseCapabilityLevel,
} from "@ashara/shared";
import { resolveModelsConfigPath } from "./pricing.js";
import { loadRoutingProfilesFromToml } from "./routing-profiles.js";
import { InvalidGatewayCatalog } from "./errors.js";
import type { FormatGroup, GatewayConfig, ModelConfig, ModelPreferences, ProviderConfig, RoutingProfiles } from "./types.js";

/**
 * Build a {@link GatewayConfig} from an already-loaded model catalog and
 * routing profiles. Pure function: reads env vars for API keys and budget
 * but performs no file I/O for model data.
 *
 * The server passes models loaded from the DB (seeded by migration 002).
 * Routing profiles are deployment-specific config that still lives in TOML.
 */
export function buildGatewayConfig(
  allModels: Record<string, ModelConfig>,
  routingProfiles: RoutingProfiles,
): GatewayConfig {
  const keys = loadProviderKeys();
  const urls = loadProviderBaseUrls();
  const budget = loadBudgetEnv();

  const modelsByProvider: Record<string, Record<string, ModelConfig>> = {};
  for (const [id, model] of Object.entries(allModels)) {
    if (!modelsByProvider[model.provider]) {
      modelsByProvider[model.provider] = {};
    }
    modelsByProvider[model.provider][id] = model;
  }

  const providers: ProviderConfig[] = [];

  if (keys.anthropicApiKey && modelsByProvider["anthropic"]) {
    providers.push({
      name: "anthropic",
      apiKey: keys.anthropicApiKey,
      models: Object.values(modelsByProvider["anthropic"]),
      enabled: true,
    });
  }

  if (keys.openaiApiKey && modelsByProvider["openai"]) {
    providers.push({
      name: "openai",
      apiKey: keys.openaiApiKey,
      models: Object.values(modelsByProvider["openai"]),
      enabled: true,
    });
  }

  if (keys.localLlmUrl && modelsByProvider["local"]) {
    providers.push({
      name: "local",
      baseUrl: keys.localLlmUrl,
      models: Object.values(modelsByProvider["local"]),
      enabled: true,
    });
  }

  const oaiCompatProviders: ReadonlyArray<{ name: string; key: string | undefined; url: string }> = [
    { name: "deepseek", key: keys.deepseekApiKey, url: urls.deepseekBaseUrl },
    { name: "mistral", key: keys.mistralApiKey, url: urls.mistralBaseUrl },
    { name: "xai", key: keys.xaiApiKey, url: urls.xaiBaseUrl },
    { name: "google", key: keys.googleApiKey, url: urls.googleBaseUrl },
  ];

  for (const cfg of oaiCompatProviders) {
    if (cfg.key && modelsByProvider[cfg.name]) {
      providers.push({
        name: cfg.name,
        apiKey: cfg.key,
        baseUrl: cfg.url,
        models: Object.values(modelsByProvider[cfg.name]),
        enabled: true,
      });
    }
  }

  const defaultProvider = keys.anthropicApiKey
    ? "anthropic"
    : keys.openaiApiKey
      ? "openai"
      : "local";

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
 * Legacy convenience wrapper: builds a {@link GatewayConfig} from env-var
 * API keys and TOML routing profiles, with an EMPTY model catalog.
 *
 * After migration 002 the authoritative model catalog lives in the database.
 * This function is retained as a backward-compatible fallback for call sites
 * that cannot reach the DB (agent-runner TOML fallback, CLI standalone).
 * With no models, the resulting config will have zero providers, causing
 * {@link buildGateway} to signal `NoLLMProvidersConfigured` -- which is the
 * correct behavior when the server (and its DB) is unreachable.
 */
export function loadGatewayConfig(): GatewayConfig {
  const routingProfiles = loadRoutingProfilesFromToml(resolveModelsConfigPath());
  return buildGatewayConfig({}, routingProfiles);
}

// ---------------------------------------------------------------------------
// Gateway catalog — one schema, one converter, two transports (file, HTTP)
// ---------------------------------------------------------------------------

const FORMAT_GROUP_VALUES = new Set<FormatGroup>(["native-fc", "code-fence", "text-patch"]);

export function parseFormatGroup(raw: string): FormatGroup | undefined {
  return FORMAT_GROUP_VALUES.has(raw as FormatGroup) ? (raw as FormatGroup) : undefined;
}

const CatalogModelSchema = z.object({
  modelId: z.string().min(1),
  providerName: z.string().min(1),
  apiModelId: z.string().nullable(),
  capability: z.string().min(1),
  formatGroup: z.string().min(1),
  strictMode: z.boolean(),
  inputCostPer1m: z.number(),
  outputCostPer1m: z.number(),
  maxContextTokens: z.number().int().positive(),
  supportsCaching: z.boolean(),
});

const CatalogProviderSchema = z.object({
  name: z.string().min(1),
  providerType: z.string().min(1),
  baseUrl: z.string().nullable(),
});

export const GatewayCatalogSchema = z.object({
  models: z.array(CatalogModelSchema).min(1),
  providers: z.array(CatalogProviderSchema).min(1),
  settings: z.record(z.string(), z.string()).default({}),
});

export type GatewayCatalog = z.infer<typeof GatewayCatalogSchema>;

const CAPABILITY_LEVELS: readonly string[] = ["Frontier", "Strong", "Medium", "Light"];

function buildPreferencesFromSettings(
  settings: Record<string, string>,
): ModelPreferences | undefined {
  const preferredProvider = settings["preferred_provider"];

  const preferredModels: Partial<Record<CapabilityLevel, string>> = {};
  let hasPreferredModel = false;
  for (const cap of CAPABILITY_LEVELS) {
    const value = settings[`preferred_model.${cap}`];
    if (value) {
      preferredModels[cap as CapabilityLevel] = value;
      hasPreferredModel = true;
    }
  }

  if (!preferredProvider && !hasPreferredModel) return undefined;

  return {
    preferredProvider,
    preferredModels: hasPreferredModel ? preferredModels : undefined,
  };
}

/**
 * Shared converter: turns a validated {@link GatewayCatalog} into a
 * {@link GatewayConfig}. Both transports (file and HTTP) call this after
 * schema validation. API keys and budget come from the process's own
 * environment, routing profiles from the local TOML.
 */
function buildConfigFromCatalog(catalog: GatewayCatalog): GatewayConfig {
  const modelsByProvider = new Map<string, ModelConfig[]>();
  for (const m of catalog.models) {
    const model: ModelConfig = {
      id: m.modelId,
      apiModelId: m.apiModelId ?? m.modelId,
      provider: m.providerName,
      capabilityLevel: parseCapabilityLevel(m.capability),
      formatGroup: parseFormatGroup(m.formatGroup),
      strictMode: m.strictMode,
      inputCostPer1M: m.inputCostPer1m,
      outputCostPer1M: m.outputCostPer1m,
      maxContextTokens: m.maxContextTokens,
      supportsCaching: m.supportsCaching,
    };
    const list = modelsByProvider.get(m.providerName);
    if (list) list.push(model);
    else modelsByProvider.set(m.providerName, [model]);
  }

  const keys = loadProviderKeys();
  const keysByProvider: Record<string, string | undefined> = {
    anthropic: keys.anthropicApiKey,
    openai: keys.openaiApiKey,
    deepseek: keys.deepseekApiKey,
    mistral: keys.mistralApiKey,
    xai: keys.xaiApiKey,
    google: keys.googleApiKey,
  };

  const providers: ProviderConfig[] = [];
  for (const p of catalog.providers) {
    const models = modelsByProvider.get(p.name);
    if (!models || models.length === 0) continue;
    const envKey = keysByProvider[p.name];
    const hasCredentials =
      envKey !== undefined ||
      (p.name === "local" && (keys.localLlmUrl ?? p.baseUrl) != null);
    if (!hasCredentials) continue;
    providers.push({
      name: p.name,
      apiKey: envKey,
      baseUrl:
        p.name === "local"
          ? (keys.localLlmUrl ?? p.baseUrl ?? undefined)
          : (p.baseUrl ?? undefined),
      models,
      enabled: true,
    });
  }

  const budget = loadBudgetEnv();
  const defaultProvider = providers.length > 0 ? providers[0].name : "local";
  const preferences = buildPreferencesFromSettings(catalog.settings);
  const routingProfiles = loadRoutingProfilesFromToml(resolveModelsConfigPath());

  return {
    providers,
    defaultProvider,
    budget: {
      maxCostTotal: budget.total,
      maxCostPerProvider: budget.perProvider,
    },
    preferences,
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

  return buildConfigFromCatalog(validateCatalog(filePath, json));
}

/**
 * HTTP transport: fetch model/provider/settings from the server API,
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

  const [modelsResp, providersResp, settingsResp] = await Promise.all([
    fetch(`${serverUrl}/config/models`, { headers }),
    fetch(`${serverUrl}/config/providers`, { headers }),
    fetch(`${serverUrl}/config/settings`, { headers }),
  ]);

  if (!modelsResp.ok) {
    throw new InvalidGatewayCatalog(serverUrl, [`/config/models returned ${modelsResp.status}`]);
  }
  if (!providersResp.ok) {
    throw new InvalidGatewayCatalog(serverUrl, [`/config/providers returned ${providersResp.status}`]);
  }
  if (!settingsResp.ok) {
    throw new InvalidGatewayCatalog(serverUrl, [`/config/settings returned ${settingsResp.status}`]);
  }

  const rawCatalog = {
    models: await modelsResp.json(),
    providers: await providersResp.json(),
    settings: await settingsResp.json(),
  };

  return buildConfigFromCatalog(validateCatalog(serverUrl, rawCatalog));
}
