import { createAnthropic } from "@ai-sdk/anthropic";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { describeErrorChain } from "@ashara/shared";
import type { CapabilityLevel } from "./capability-level.js";
import {
  InvalidGatewayCatalog,
  NoProviderAvailableError,
  ProviderMissingBaseUrl,
  RoutingProfileUnresolved,
  UnknownProvider,
} from "./errors.js";
import { CAPABILITY_RANK } from "./capability-rank.js";
import { computeProviderCombo } from "./routing-profiles.js";
import type {
  GatewayConfig,
  KnownLLMSite,
  ModelConfig,
  ProviderConfig,
  ProviderType,
  RoutingProfiles,
} from "./types.js";

export interface ResolvedProvider {
  provider: LanguageModel;
  modelConfig: ModelConfig;
  providerName: string;
  providerType: ProviderType;
}

/** Makes the model a resolved route sends its requests to; the composition root chooses it. */
export type LanguageModelFactory = (providerConfig: ProviderConfig, modelConfig: ModelConfig) => LanguageModel;

/** The policy default: the AI SDK adapter of the row's provider type; its name is identity only. */
export const sdkLanguageModels: LanguageModelFactory = (providerConfig, modelConfig) => {
  const type = providerConfig.providerType;
  switch (type) {
    case "anthropic": {
      const anthropic = createAnthropic({ apiKey: providerConfig.apiKey });
      return anthropic(modelConfig.apiModelId);
    }
    case "openai": {
      const openai = createOpenAI({ apiKey: providerConfig.apiKey });
      return openai(modelConfig.apiModelId);
    }
    case "deepseek": {
      if (!providerConfig.baseUrl) {
        throw new ProviderMissingBaseUrl(providerConfig.name);
      }
      const deepseek = createDeepSeek({
        baseURL: providerConfig.baseUrl,
        apiKey: providerConfig.apiKey,
      });
      return deepseek(modelConfig.apiModelId);
    }
    case "local": {
      if (!providerConfig.baseUrl) {
        throw new ProviderMissingBaseUrl(providerConfig.name);
      }
      const local = createOpenAI({
        baseURL: providerConfig.baseUrl,
        apiKey: "not-needed",
      });
      return local.chat(modelConfig.apiModelId);
    }
    case "openai-compatible": {
      if (!providerConfig.baseUrl) {
        throw new ProviderMissingBaseUrl(providerConfig.name);
      }
      const provider = createOpenAI({
        baseURL: providerConfig.baseUrl,
        apiKey: providerConfig.apiKey,
      });
      return provider.chat(modelConfig.apiModelId);
    }
    default: {
      const unhandled: never = type;
      throw new InvalidGatewayCatalog("provider_configs", [
        `provider "${providerConfig.name}": no SDK adapter for provider_type "${String(unhandled)}"`,
      ]);
    }
  }
};

/**
 * The cheapest model graded at or above `capability`: base input rate, then
 * base output rate, then id, so the choice never depends on catalog order.
 * Picking the lowest qualifying level would send a Light request to a dearer,
 * weaker model whenever a cheaper one is graded higher
 * (docs/investigations/model-catalog-2026-10-14.md §7 flag 2).
 */
function findBestModel(
  models: ModelConfig[],
  capability: CapabilityLevel,
): ModelConfig | undefined {
  const targetRank = CAPABILITY_RANK[capability];
  const eligible = models
    .filter((m) => CAPABILITY_RANK[m.capabilityLevel] >= targetRank)
    .sort(
      (a, b) =>
        a.inputCostPer1M - b.inputCostPer1M ||
        a.outputCostPer1M - b.outputCostPer1M ||
        a.id.localeCompare(b.id),
    );
  return eligible[0];
}

export class ProviderRegistry {
  private readonly config: GatewayConfig;
  private readonly routingProfiles: RoutingProfiles | undefined;
  /**
   * The deployment's enabled-provider combo (routing-profiles story), fixed
   * at construction: it names WHICH providers are turned on for this
   * deployment, not which are excluded for a particular resolve() call
   * (fallback/degrade never changes which playbook applies; when it excludes
   * the provider of the profile-mapped model, that one call uses capability
   * logic over the remaining providers — see resolveFromProfile).
   */
  private readonly enabledCombo: string;
  private readonly createLanguageModel: LanguageModelFactory;

  constructor(config: GatewayConfig, models: LanguageModelFactory) {
    this.config = config;
    this.createLanguageModel = models;
    this.routingProfiles = config.routingProfiles;
    this.enabledCombo = computeProviderCombo(
      config.providers.filter((p) => p.enabled).map((p) => p.name),
    );
  }

  resolve(
    capability: CapabilityLevel,
    excludeProviders: string[] = [],
    site?: KnownLLMSite,
  ): ResolvedProvider {
    const enabledProviders = this.config.providers.filter(
      (p) => p.enabled && !excludeProviders.includes(p.name),
    );

    // 0. Routing profile (site playbook, routing-profiles story): a static
    // per-site override that PRECEDES capability logic entirely. Only
    // consulted when the caller tagged the request with a site — a site-less
    // request is the documented exception that always uses capability logic.
    if (site) {
      const fromProfile = this.resolveFromProfile(enabledProviders, excludeProviders, site, capability);
      if (fromProfile) return fromProfile;
    }

    // Fallback: default provider first, then cheapest
    return this.resolveDefault(enabledProviders, capability);
  }

  /** The adapter type of a configured provider, by name. */
  providerTypeOf(providerName: string): ProviderType {
    const provider = this.config.providers.find((p) => p.name === providerName);
    if (!provider) {
      throw new UnknownProvider(providerName, this.config.providers.map((p) => p.name));
    }
    return provider.providerType;
  }

  /** A provider other than every one of `excluded` that serves `capability` at `site`; null when none does. */
  resolveFallback(
    capability: CapabilityLevel,
    excluded: readonly string[],
    site?: KnownLLMSite,
  ): ResolvedProvider | null {
    try {
      return this.resolve(capability, [...excluded], site);
    } catch (err) {
      // Only "no other provider serves this" means no fallback; any other error is a
      // configuration fault (e.g. RoutingProfileUnresolved) and must not read as one.
      if (!(err instanceof NoProviderAvailableError)) throw err;
      console.warn(`[ProviderRegistry] no fallback for ${capability} (excluding ${excluded.join(", ")}):`, describeErrorChain(err));
      return null;
    }
  }

  /**
   * A model other than `avoid` that serves `capability` at `site`, for a second opinion: another
   * provider's first, by the same routing as any request; else another model of `avoid`'s provider
   * graded at or above `capability`, the cheapest. Null when the catalog has no other.
   */
  resolveOther(capability: CapabilityLevel, avoid: { readonly provider: string; readonly model: string }, site?: KnownLLMSite): ResolvedProvider | null {
    const elsewhere = this.resolveFallback(capability, [avoid.provider], site);
    if (elsewhere !== null) return elsewhere;
    const same = this.config.providers.find((p) => p.enabled && p.name === avoid.provider);
    if (!same) return null;
    const modelConfig = findBestModel(
      same.models.filter((m) => m.id !== avoid.model),
      capability,
    );
    if (!modelConfig) return null;
    return {
      provider: this.createLanguageModel(same, modelConfig),
      modelConfig,
      providerName: same.name,
      providerType: same.providerType,
    };
  }

  /**
   * Static per-site routing lookup (routing-profiles story). Returns `null`,
   * so the caller uses capability logic, in exactly three cases: no profile
   * registered for the enabled-provider combo; an explicitly empty profile
   * (`[routing.profiles."deepseek"]`), which maps no site; or the mapped model
   * is offered only by a provider the CALLER excluded (the provider-error
   * fallback in gateway.ts), which is logged. Every other miss in a NON-EMPTY, curated profile throws
   * `RoutingProfileUnresolved`: the site's table has no entry for the
   * requested capability and no `default`, or no enabled provider offers the
   * mapped model at all. A site missing from a non-empty profile cannot reach
   * this point: `buildGateway` refuses to start on it
   * (`RoutingProfileIncomplete`).
   *
   * Deliberately does NOT enforce "the mapped model must meet or exceed
   * `capability`" — a flat string entry (e.g. escalation -> claude-sonnet-5-5)
   * is an intentional PINNED override that wins regardless of the nominal
   * capability the caller asked for; only a table entry consults `capability`
   * at all, and only to pick WHICH pinned model applies.
   */
  private resolveFromProfile(
    enabledProviders: ProviderConfig[],
    excludeProviders: readonly string[],
    site: KnownLLMSite,
    capability: CapabilityLevel,
  ): ResolvedProvider | null {
    const profile = this.routingProfiles?.[this.enabledCombo];
    if (!profile) {
      console.warn(
        `[ProviderRegistry] no routing profile for enabled-provider combo "${this.enabledCombo}" ` +
          `(site="${site}") — falling through to capability logic`,
      );
      return null;
    }

    const entry = profile[site];
    if (!entry) {
      if (Object.keys(profile).length > 0) {
        throw new RoutingProfileUnresolved({
          combo: this.enabledCombo,
          site,
          capability,
          mappedModel: null,
          searchedProviders: enabledProviders.map((p) => p.name),
        });
      }
      console.warn(
        `[ProviderRegistry] routing profile "${this.enabledCombo}" is empty (site="${site}") ` +
          `— using capability logic`,
      );
      return null;
    }

    const modelId = typeof entry === "string" ? entry : entry[capability] ?? entry.default;
    if (!modelId) {
      throw new RoutingProfileUnresolved({
        combo: this.enabledCombo,
        site,
        capability,
        mappedModel: null,
        searchedProviders: enabledProviders.map((p) => p.name),
      });
    }

    for (const providerConfig of enabledProviders) {
      const model = providerConfig.models.find((m) => m.id === modelId);
      if (model) {
        return {
          provider: this.createLanguageModel(providerConfig, model),
          modelConfig: model,
          providerName: providerConfig.name,
          providerType: providerConfig.providerType,
        };
      }
    }

    const excludedHolder = this.config.providers.find(
      (p) => p.enabled && excludeProviders.includes(p.name) && p.models.some((m) => m.id === modelId),
    );
    if (excludedHolder) {
      console.warn(
        `[ProviderRegistry] routing profile "${this.enabledCombo}" maps site="${site}" (capability="${capability}") ` +
          `to model "${modelId}" on excluded provider "${excludedHolder.name}" — using capability logic ` +
          `over [${enabledProviders.map((p) => p.name).join(", ")}] for this fallback/degrade`,
      );
      return null;
    }

    throw new RoutingProfileUnresolved({
      combo: this.enabledCombo,
      site,
      capability,
      mappedModel: modelId,
      searchedProviders: enabledProviders.map((p) => p.name),
    });
  }

  private resolveDefault(
    enabledProviders: ProviderConfig[],
    capability: CapabilityLevel,
  ): ResolvedProvider {
    const defaultFirst = [...enabledProviders].sort((a, b) => {
      if (a.name === this.config.defaultProvider) return -1;
      if (b.name === this.config.defaultProvider) return 1;
      return 0;
    });

    for (const providerConfig of defaultFirst) {
      const modelConfig = findBestModel(providerConfig.models, capability);
      if (modelConfig) {
        return {
          provider: this.createLanguageModel(providerConfig, modelConfig),
          modelConfig,
          providerName: providerConfig.name,
          providerType: providerConfig.providerType,
        };
      }
    }

    throw new NoProviderAvailableError(
      capability,
      enabledProviders.flatMap((p) => p.models.map((m) => `${m.id} (${m.capabilityLevel})`)),
    );
  }
}
