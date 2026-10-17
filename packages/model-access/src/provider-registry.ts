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
  SecondOpinion,
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
  return models.filter((m) => CAPABILITY_RANK[m.capabilityLevel] >= targetRank).sort(cheaperFirst)[0];
}

/** Base input rate, then base output rate, then id: an order that never depends on catalog order. */
function cheaperFirst(a: ModelConfig, b: ModelConfig): number {
  return a.inputCostPer1M - b.inputCostPer1M || a.outputCostPer1M - b.outputCostPer1M || a.id.localeCompare(b.id);
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
   * The model a second opinion of `opinion.strength` goes to at `capability` and `site`, chosen from
   * the catalog by provider and graded capability alone; null when the catalog offers none:
   * - other-family: another provider's model, by the same routing as any request at `site`;
   * - same-family-other-model: the cheapest other model of the avoided provider graded at or above
   *   `capability`;
   * - same-model: the avoided model itself, graded at or above `capability`, and only when no other
   *   enabled model is: a deployment that offers another model never re-asks the same one.
   */
  resolveSecondOpinion(capability: CapabilityLevel, opinion: SecondOpinion, site?: KnownLLMSite): ResolvedProvider | null {
    const { avoid } = opinion;
    if (opinion.strength === "other-family") return this.resolveFallback(capability, [avoid.provider], site);
    const same = this.config.providers.find((p) => p.enabled && p.name === avoid.provider);
    if (!same) return null;
    const targetRank = CAPABILITY_RANK[capability];
    let modelConfig: ModelConfig | undefined;
    if (opinion.strength === "same-family-other-model") {
      modelConfig = findBestModel(same.models.filter((m) => m.id !== avoid.model), capability);
    } else {
      const others = this.config.providers
        .filter((p) => p.enabled)
        .flatMap((p) => p.models.filter((m) => !(p.name === avoid.provider && m.id === avoid.model)))
        .filter((m) => CAPABILITY_RANK[m.capabilityLevel] >= targetRank);
      const itself = same.models.find((m) => m.id === avoid.model);
      modelConfig = others.length === 0 && itself !== undefined && CAPABILITY_RANK[itself.capabilityLevel] >= targetRank ? itself : undefined;
    }
    if (!modelConfig) return null;
    return {
      provider: this.createLanguageModel(same, modelConfig),
      modelConfig,
      providerName: same.name,
      providerType: same.providerType,
    };
  }

  /**
   * The cheapest model of an enabled provider graded at or above `capability` whose context window
   * is larger than `windowTokens`, by capability logic alone (a routing profile pins one model per
   * site, which is the one whose window was too small); null when the catalog offers none.
   */
  resolveWithWindowAbove(capability: CapabilityLevel, windowTokens: number): ResolvedProvider | null {
    const targetRank = CAPABILITY_RANK[capability];
    const [best] = this.config.providers
      .filter((p) => p.enabled)
      .flatMap((provider) => provider.models.map((model) => ({ provider, model })))
      .filter(({ model }) => model.maxContextTokens > windowTokens && CAPABILITY_RANK[model.capabilityLevel] >= targetRank)
      .sort((a, b) => cheaperFirst(a.model, b.model));
    if (best === undefined) return null;
    return {
      provider: this.createLanguageModel(best.provider, best.model),
      modelConfig: best.model,
      providerName: best.provider.name,
      providerType: best.provider.providerType,
    };
  }

  /** `id (capability)` of every model the enabled providers offer, for a refusal's message. */
  enabledModels(): string[] {
    return this.config.providers.filter((p) => p.enabled).flatMap((p) => p.models.map((m) => `${p.name}/${m.id} (${m.capabilityLevel})`));
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
