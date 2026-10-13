import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import type { CapabilityLevel } from "@ashara/shared";
import { NoProviderAvailableError, ProviderMissingBaseUrl } from "./errors.js";
import { CAPABILITY_RANK } from "./pricing.js";
import { computeProviderCombo } from "./routing-profiles.js";
import type { GatewayConfig, KnownLLMSite, ModelConfig, ProviderConfig, RoutingProfiles } from "./types.js";

export interface ResolvedProvider {
  provider: LanguageModel;
  modelConfig: ModelConfig;
  providerName: string;
}

function createLanguageModel(
  providerConfig: ProviderConfig,
  modelConfig: ModelConfig,
): LanguageModel {
  switch (providerConfig.name) {
    case "anthropic": {
      const anthropic = createAnthropic({ apiKey: providerConfig.apiKey });
      return anthropic(modelConfig.apiModelId);
    }
    case "openai": {
      const openai = createOpenAI({ apiKey: providerConfig.apiKey });
      return openai(modelConfig.apiModelId);
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
    default: {
      if (!providerConfig.baseUrl) {
        throw new ProviderMissingBaseUrl(providerConfig.name);
      }
      const provider = createOpenAI({
        baseURL: providerConfig.baseUrl,
        apiKey: providerConfig.apiKey,
      });
      return provider.chat(modelConfig.apiModelId);
    }
  }
}

function findBestModel(
  models: ModelConfig[],
  capability: CapabilityLevel,
): ModelConfig | undefined {
  const targetRank = CAPABILITY_RANK[capability];
  const eligible = models
    .filter((m) => CAPABILITY_RANK[m.capabilityLevel] >= targetRank)
    .sort(
      (a, b) =>
        CAPABILITY_RANK[a.capabilityLevel] - CAPABILITY_RANK[b.capabilityLevel],
    );
  if (eligible.length > 0) return eligible[0];

  const downgraded = [...models].sort(
    (a, b) =>
      CAPABILITY_RANK[b.capabilityLevel] - CAPABILITY_RANK[a.capabilityLevel],
  );
  if (downgraded.length > 0) {
    console.warn(
      `[ProviderRegistry] no model at capability=${capability}, downgrading to ${downgraded[0].id} (${downgraded[0].capabilityLevel})`,
    );
    return downgraded[0];
  }
  return undefined;
}

// TODO: capability → model routing should migrate to Compute domain (Phase 25)
export class ProviderRegistry {
  private readonly config: GatewayConfig;
  private readonly routingProfiles: RoutingProfiles | undefined;
  /**
   * The deployment's enabled-provider combo (routing-profiles story), fixed
   * at construction: it names WHICH providers are turned on for this
   * deployment, not which are excluded for a particular resolve() call
   * (fallback/degrade only narrows the search for the profile-mapped model —
   * see resolveFromProfile — it never changes which playbook applies).
   */
  private readonly enabledCombo: string;

  constructor(config: GatewayConfig) {
    this.config = config;
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
      const fromProfile = this.resolveFromProfile(enabledProviders, site, capability);
      if (fromProfile) return fromProfile;
    }

    // Fallback: default provider first, then cheapest
    return this.resolveDefault(enabledProviders, capability);
  }

  resolveFallback(
    capability: CapabilityLevel,
    failedProvider: string,
    site?: KnownLLMSite,
  ): ResolvedProvider | null {
    try {
      return this.resolve(capability, [failedProvider], site);
    } catch (err) {
      console.warn(`[ProviderRegistry] no fallback for ${capability} (excluding ${failedProvider}):`, err instanceof Error ? err.message : err);
      return null;
    }
  }

  /**
   * Static per-site routing lookup (routing-profiles story). Returns `null` —
   * never throws — on any miss, so the caller falls through to capability
   * logic: no profile registered for this deployment's enabled-provider
   * combo, the matched profile doesn't map this site, the site's table has
   * no entry for the REQUESTED capability and no `default` (a site whose
   * requests vary in capability — see `RoutingProfileCapabilityTable` — must
   * pick per-call, not once per site), or the mapped model isn't among
   * `enabledProviders` (excluded by a caller's fallback/degrade retry, or
   * simply removed from the deployment). Each miss is logged (Discipline C)
   * — a routing gap should be visible, not silent.
   *
   * The unmapped-site miss stays fail-soft HERE because it is the intended
   * behavior of an explicitly empty profile (`[routing.profiles."deepseek"]`),
   * which is truthy but maps nothing. The case that used to hide a bug — a
   * site missing from a NON-empty, curated profile — can no longer reach this
   * point: `buildGateway` refuses to start on it (`RoutingProfileIncomplete`).
   *
   * Deliberately does NOT enforce "the mapped model must meet or exceed
   * `capability`" — a flat string entry (e.g. escalation -> claude-sonnet-4-6)
   * is an intentional PINNED override that wins regardless of the nominal
   * capability the caller asked for; only a table entry consults `capability`
   * at all, and only to pick WHICH pinned model applies.
   */
  private resolveFromProfile(
    enabledProviders: ProviderConfig[],
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
      console.warn(
        `[ProviderRegistry] routing profile "${this.enabledCombo}" has no mapping for site="${site}" ` +
          `— falling through to capability logic`,
      );
      return null;
    }

    const modelId = typeof entry === "string" ? entry : entry[capability] ?? entry.default;
    if (!modelId) {
      console.warn(
        `[ProviderRegistry] routing profile "${this.enabledCombo}" site="${site}" has no entry for ` +
          `capability="${capability}" and no "default" — falling through to capability logic`,
      );
      return null;
    }

    for (const providerConfig of enabledProviders) {
      const model = providerConfig.models.find((m) => m.id === modelId);
      if (model) {
        return {
          provider: createLanguageModel(providerConfig, model),
          modelConfig: model,
          providerName: providerConfig.name,
        };
      }
    }

    console.warn(
      `[ProviderRegistry] routing profile "${this.enabledCombo}" maps site="${site}" (capability="${capability}") ` +
        `to model "${modelId}", but no enabled/available provider has it — falling through to capability logic`,
    );
    return null;
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
          provider: createLanguageModel(providerConfig, modelConfig),
          modelConfig,
          providerName: providerConfig.name,
        };
      }
    }

    throw new NoProviderAvailableError(capability);
  }
}
