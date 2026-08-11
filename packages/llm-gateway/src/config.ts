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
 * A provider's credentials for gateway configuration. Decoupled from the
 * source: the server passes DB-sourced data; the CLI and agent-runner pass
 * env-sourced data.
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
 * The caller owns the credential source: the server reads from the database
 * (`provider_configs.api_key`), while the CLI and agent-runner read from
 * the process environment. Budget config is still read from env (it is
 * deployment tuning, not a secret).
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
  apiKey: z.string().nullable().optional(),
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

  // Provider credentials: prefer catalog-supplied keys (from DB via API),
  // fall back to env vars for standalone CLI / agent-runner subprocess.
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
    const catalogKey = (p.apiKey != null && p.apiKey !== "") ? p.apiKey : undefined;
    const envKey = envKeysByProvider[p.name];
    const resolvedKey = catalogKey ?? envKey;
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
