import { createAnthropic } from "@ai-sdk/anthropic";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { describeErrorChain } from "@ashara/shared";
import type { CapabilityLevel } from "./capability-level.js";
import {
  InvalidGatewayCatalog,
  JudgeUnavailable,
  NoProviderAvailableError,
  ProviderMissingBaseUrl,
  RoutingProfileUnresolved,
  UnknownProvider,
} from "./errors.js";
import { CAPABILITY_RANK, gradeAsCalled, judgeRelation, nextCapability } from "./capability-rank.js";
import { computeProviderCombo } from "./routing-profiles.js";
import { thinkingModeFor } from "./thinking.js";
import type {
  GatewayConfig,
  JudgeRelation,
  KnownLLMSite,
  ModelConfig,
  ProviderConfig,
  ProviderType,
  RoutingProfiles,
  SecondOpinion,
  TierAsk,
} from "./types.js";

export interface ResolvedProvider {
  provider: LanguageModel;
  modelConfig: ModelConfig;
  providerName: string;
  providerType: ProviderType;
}

/** A judge as resolved, with how its grade stands to the tier of the work it judges. */
export interface ResolvedJudge extends ResolvedProvider {
  readonly relation: JudgeRelation;
}

/** A model of a provider that a request is routed to, before its language model is made. */
interface Route {
  readonly providerConfig: ProviderConfig;
  readonly model: ModelConfig;
}

/** The tiers a judge of work at `judged` is asked at, strongest first: one above it, then it. */
function judgeTiers(judged: CapabilityLevel): CapabilityLevel[] {
  const above = nextCapability(judged);
  return above === null ? [judged] : [above, judged];
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

/** A model's catalog grade as a request at one site calls it. */
type GradeOf = (model: ModelConfig) => CapabilityLevel;

/**
 * The cheapest model graded at or above `capability`: base input rate, then
 * base output rate, then id, so the choice never depends on catalog order.
 * Picking the lowest qualifying level would send a Light request to a dearer,
 * weaker model whenever a cheaper one is graded higher.
 */
function findBestModel(
  models: ModelConfig[],
  capability: CapabilityLevel,
  gradeOf: GradeOf,
): ModelConfig | undefined {
  const targetRank = CAPABILITY_RANK[capability];
  return models.filter((m) => CAPABILITY_RANK[gradeOf(m)] >= targetRank).sort(cheaperFirst)[0];
}

/** Base input rate, then base output rate, then id: an order that never depends on catalog order. */
function cheaperFirst(a: ModelConfig, b: ModelConfig): number {
  return a.inputCostPer1M - b.inputCostPer1M || a.outputCostPer1M - b.outputCostPer1M || a.id.localeCompare(b.id);
}

export class ProviderRegistry {
  private readonly config: GatewayConfig;
  private readonly routingProfiles: RoutingProfiles | undefined;
  /**
   * The deployment's enabled-provider combo, fixed
   * at construction: it names WHICH providers are turned on for this
   * deployment, not which are excluded for a particular resolve() call
   * (fallback/degrade never changes which playbook applies; when it excludes
   * the provider of the profile-mapped model, that one call uses capability
   * logic over the remaining providers — see routeFromProfile).
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

    // 0. Routing profile (site playbook): a static
    // per-site override that PRECEDES capability logic entirely. Only
    // consulted when the caller tagged the request with a site — a site-less
    // request is the documented exception that always uses capability logic.
    if (site) {
      const fromProfile = this.routeFromProfile(enabledProviders, excludeProviders, site, capability);
      if (fromProfile) return this.resolvedOf(fromProfile);
    }

    // Fallback: default provider first, then cheapest
    const route = this.defaultRoute(enabledProviders, capability, site);
    if (route === null) {
      const gradeOf = this.gradesAt(site);
      throw new NoProviderAvailableError(
        capability,
        enabledProviders.flatMap((p) => p.models.map((m) => `${m.id} (${gradeOf(m)})`)),
      );
    }
    return this.resolvedOf(route);
  }

  /**
   * A model's catalog grade as a request at `site` calls it: in the thinking mode the deployment's
   * policy sets there. Every comparison of a model with a tier reads it, so a model called without
   * the reasoning it is graded for is never taken for that grade.
   */
  gradeAt(model: ModelConfig, site: KnownLLMSite | undefined): CapabilityLevel {
    return gradeAsCalled(model, thinkingModeFor(this.config.thinking, site));
  }

  private gradesAt(site: KnownLLMSite | undefined): GradeOf {
    return (model) => this.gradeAt(model, site);
  }

  private resolvedOf(route: Route): ResolvedProvider {
    return {
      provider: this.createLanguageModel(route.providerConfig, route.model),
      modelConfig: route.model,
      providerName: route.providerConfig.name,
      providerType: route.providerConfig.providerType,
    };
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
   * The judge of work at `judges` at `site`: a model graded one tier above it, else one graded at
   * it, by the same routing as any request at `site` asked at that tier. A routing profile's entry
   * is held to the tier it is asked at like any candidate: one graded below it is passed over, never
   * used. Throws JudgeUnavailable, naming the judged tier and the candidates, when neither tier finds
   * a model: no weaker one is substituted.
   */
  resolveJudge(judges: CapabilityLevel, excludeProviders: readonly string[] = [], site?: KnownLLMSite): ResolvedJudge {
    const enabledProviders = this.config.providers.filter((p) => p.enabled && !excludeProviders.includes(p.name));
    const steps: string[] = [];
    for (const tier of judgeTiers(judges)) {
      const route = this.judgeRouteAt(enabledProviders, excludeProviders, site, tier);
      if ("refused" in route) {
        steps.push(`at ${tier}: ${route.refused}`);
        continue;
      }
      return { ...this.resolvedOf(route), relation: judgeRelation(judges, this.gradeAt(route.model, site)) };
    }
    throw new JudgeUnavailable({
      judgedTier: judges,
      site: site ?? null,
      candidates: enabledProviders.flatMap((p) => p.models.map((m) => `${p.name}/${m.id} (${this.gradeAt(m, site)})`)),
      steps,
    });
  }

  /** A judge of work at `judges` on a provider other than every one of `excluded`; null when none may judge it. */
  resolveJudgeFallback(judges: CapabilityLevel, excluded: readonly string[], site?: KnownLLMSite): ResolvedJudge | null {
    try {
      return this.resolveJudge(judges, excluded, site);
    } catch (err) {
      if (!(err instanceof JudgeUnavailable)) throw err;
      console.warn(`[ProviderRegistry] no fallback judge for work at ${judges} (excluding ${excluded.join(", ")}):`, describeErrorChain(err));
      return null;
    }
  }

  /**
   * The model `site` routes a request at `tier` to, held to `tier`: a profile's entry graded below
   * it is refused, and so is a table with no entry covering it. Capability logic applies only where
   * the profile does not (routeFromProfile's null).
   */
  private judgeRouteAt(
    enabledProviders: ProviderConfig[],
    excludeProviders: readonly string[],
    site: KnownLLMSite | undefined,
    tier: CapabilityLevel,
  ): Route | { readonly refused: string } {
    let route: Route | null = null;
    if (site) {
      try {
        route = this.routeFromProfile(enabledProviders, excludeProviders, site, tier);
      } catch (err) {
        // A table with no entry for this tier offers no judge at it; a mapped model no provider offers is a configuration fault.
        if (!(err instanceof RoutingProfileUnresolved) || err.mappedModel !== null) throw err;
        return { refused: `routing profile "${this.enabledCombo}" maps site="${site}" at no model for it` };
      }
      if (route !== null && CAPABILITY_RANK[this.gradeAt(route.model, site)] < CAPABILITY_RANK[tier]) {
        return {
          refused: `routing profile "${this.enabledCombo}" maps site="${site}" to ${route.providerConfig.name}/${route.model.id}, graded ${this.gradeAt(route.model, site)} as called there`,
        };
      }
    }
    return route ?? this.defaultRoute(enabledProviders, tier, site) ?? { refused: "no enabled provider offers a model graded at or above it" };
  }

  /**
   * The model a second opinion of `opinion.strength` goes to for `ask` at `site`, chosen from the
   * catalog by provider and graded tier alone; null when the catalog offers none. A judging request's
   * second opinion is held to the judged tier as its first is: one tier above, else equal, never
   * below. A same-model one has a single candidate, so it is held to the judged tier alone: the
   * model is re-asked only when no other enabled model is graded at or above the judged tier, never
   * because none is graded one tier above it. At a tier:
   * - other-family: another provider's model, by the same routing as any request at `site`;
   * - same-family-other-model: the cheapest other model of the avoided provider graded at or above
   *   the tier;
   * - same-model: the avoided model itself, graded at or above the tier, and only when no other
   *   enabled model is: a deployment that offers another model never re-asks the same one.
   */
  resolveSecondOpinion(ask: TierAsk, opinion: SecondOpinion, site?: KnownLLMSite): ResolvedProvider | null {
    if (ask.judges === undefined) return this.secondOpinionAt(ask.capability, opinion, site);
    if (opinion.strength === "other-family") return this.resolveJudgeFallback(ask.judges, [opinion.avoid.provider], site);
    if (opinion.strength === "same-model") return this.secondOpinionAt(ask.judges, opinion, site);
    for (const tier of judgeTiers(ask.judges)) {
      const resolved = this.secondOpinionAt(tier, opinion, site);
      if (resolved !== null) return resolved;
    }
    return null;
  }

  private secondOpinionAt(capability: CapabilityLevel, opinion: SecondOpinion, site?: KnownLLMSite): ResolvedProvider | null {
    const { avoid } = opinion;
    if (opinion.strength === "other-family") return this.resolveFallback(capability, [avoid.provider], site);
    const same = this.config.providers.find((p) => p.enabled && p.name === avoid.provider);
    if (!same) return null;
    const targetRank = CAPABILITY_RANK[capability];
    const gradeOf = this.gradesAt(site);
    let modelConfig: ModelConfig | undefined;
    if (opinion.strength === "same-family-other-model") {
      modelConfig = findBestModel(same.models.filter((m) => m.id !== avoid.model), capability, gradeOf);
    } else {
      const others = this.config.providers
        .filter((p) => p.enabled)
        .flatMap((p) => p.models.filter((m) => !(p.name === avoid.provider && m.id === avoid.model)))
        .filter((m) => CAPABILITY_RANK[gradeOf(m)] >= targetRank);
      const itself = same.models.find((m) => m.id === avoid.model);
      modelConfig = others.length === 0 && itself !== undefined && CAPABILITY_RANK[gradeOf(itself)] >= targetRank ? itself : undefined;
    }
    if (!modelConfig) return null;
    return this.resolvedOf({ providerConfig: same, model: modelConfig });
  }

  /**
   * The cheapest model of an enabled provider graded at or above `capability` whose context window
   * is larger than `windowTokens`, by capability logic alone (a routing profile pins one model per
   * site, which is the one whose window was too small); null when the catalog offers none.
   */
  resolveWithWindowAbove(capability: CapabilityLevel, windowTokens: number, site: KnownLLMSite): ResolvedProvider | null {
    const targetRank = CAPABILITY_RANK[capability];
    const [best] = this.config.providers
      .filter((p) => p.enabled)
      .flatMap((provider) => provider.models.map((model) => ({ provider, model })))
      .filter(({ model }) => model.maxContextTokens > windowTokens && CAPABILITY_RANK[this.gradeAt(model, site)] >= targetRank)
      .sort((a, b) => cheaperFirst(a.model, b.model));
    if (best === undefined) return null;
    return {
      provider: this.createLanguageModel(best.provider, best.model),
      modelConfig: best.model,
      providerName: best.provider.name,
      providerType: best.provider.providerType,
    };
  }

  /** `id (grade)` of every model the enabled providers offer, graded as `site` calls it, for a refusal's message. */
  enabledModels(site: KnownLLMSite | undefined): string[] {
    return this.config.providers.filter((p) => p.enabled).flatMap((p) => p.models.map((m) => `${p.name}/${m.id} (${this.gradeAt(m, site)})`));
  }

  /**
   * Static per-site routing lookup. Returns `null`,
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
   * A capability request takes the mapped model whatever its grade: a flat
   * string entry (e.g. escalation -> claude-opus-5-5) is a pinned override that
   * wins regardless of the capability asked, and a table entry consults
   * `capability` only to pick which pinned model applies. A judging request is
   * held to its tier by `resolveJudge`, which passes over a mapped model graded
   * below the tier asked.
   */
  private routeFromProfile(
    enabledProviders: ProviderConfig[],
    excludeProviders: readonly string[],
    site: KnownLLMSite,
    capability: CapabilityLevel,
  ): Route | null {
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
      if (model) return { providerConfig, model };
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

  /** Capability logic: the default provider first, then the others, each offering its cheapest model at or above `capability`. */
  private defaultRoute(enabledProviders: ProviderConfig[], capability: CapabilityLevel, site: KnownLLMSite | undefined): Route | null {
    const gradeOf = this.gradesAt(site);
    const defaultFirst = [...enabledProviders].sort((a, b) => {
      if (a.name === this.config.defaultProvider) return -1;
      if (b.name === this.config.defaultProvider) return 1;
      return 0;
    });

    for (const providerConfig of defaultFirst) {
      const model = findBestModel(providerConfig.models, capability, gradeOf);
      if (model) return { providerConfig, model };
    }
    return null;
  }
}
