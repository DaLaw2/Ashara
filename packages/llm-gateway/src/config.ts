import type { CapabilityLevel } from "@ashara/shared";
import {
  loadProviderKeys,
  loadProviderBaseUrls,
  loadBudgetEnv,
  parseCapabilityLevel,
} from "@ashara/shared";
import { loadModelsWithFallback, resolveModelsConfigPath } from "./pricing.js";
import { loadRoutingProfilesFromToml } from "./routing-profiles.js";
import type { FormatGroup, GatewayConfig, ModelConfig, ModelPreferences, ProviderConfig } from "./types.js";

export function loadGatewayConfig(): GatewayConfig {
  const allModels = loadModelsWithFallback();
  const keys = loadProviderKeys();
  const urls = loadProviderBaseUrls();
  const budget = loadBudgetEnv();
  const routingProfiles = loadRoutingProfilesFromToml(resolveModelsConfigPath());

  const modelsByProvider: Record<string, typeof allModels> = {};
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

// ---------------------------------------------------------------------------
// API-based config loading — used by agent-runner subprocesses
// ---------------------------------------------------------------------------

interface ApiModelEntry {
  modelId: string;
  providerName: string;
  apiModelId: string | null;
  capability: string;
  formatGroup: string;
  strictMode: boolean;
  inputCostPer1m: number;
  outputCostPer1m: number;
  maxContextTokens: number;
  supportsCaching: boolean;
}

interface ApiProviderEntry {
  name: string;
  providerType: string;
  apiKey: string | null;
  baseUrl: string | null;
}

const FORMAT_GROUP_VALUES = new Set<FormatGroup>(["native-fc", "code-fence", "text-patch"]);

function parseFormatGroup(raw: string): FormatGroup | undefined {
  return FORMAT_GROUP_VALUES.has(raw as FormatGroup) ? (raw as FormatGroup) : undefined;
}

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
    throw new Error(`/config/models returned ${modelsResp.status}`);
  }
  if (!providersResp.ok) {
    throw new Error(`/config/providers returned ${providersResp.status}`);
  }

  const apiModels = (await modelsResp.json()) as ApiModelEntry[];
  const apiProviders = (await providersResp.json()) as ApiProviderEntry[];
  const settings = settingsResp.ok
    ? ((await settingsResp.json()) as Record<string, string>)
    : {};

  const modelsByProvider = new Map<string, ModelConfig[]>();
  for (const m of apiModels) {
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
    if (list) {
      list.push(model);
    } else {
      modelsByProvider.set(m.providerName, [model]);
    }
  }

  const providers: ProviderConfig[] = [];
  for (const p of apiProviders) {
    const models = modelsByProvider.get(p.name);
    if (!models || models.length === 0) continue;
    providers.push({
      name: p.name,
      apiKey: p.apiKey ?? undefined,
      baseUrl: p.baseUrl ?? undefined,
      models,
      enabled: true,
    });
  }

  const budget = loadBudgetEnv();
  const defaultProvider = providers.length > 0 ? providers[0].name : "local";

  const preferences = buildPreferencesFromSettings(settings);
  // Routing profiles are static template config, not runtime/DB state, so
  // this API-config path reads the SAME local models.toml the file path does
  // (via ASHARA_MODELS_CONFIG / the repo-relative default — resolveModelsConfigPath
  // is worktree-CWD-safe) rather than requiring a dedicated server endpoint.
  // Closes the routing half of the documented Gap-1 asymmetry: preferences
  // only ever reached this path before, leaving the file path's consumers
  // (CLI/brainstorm/northstar) unrouted.
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
