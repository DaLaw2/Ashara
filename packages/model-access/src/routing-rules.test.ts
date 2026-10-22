import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { JudgeUnavailable, NoProviderAvailableError, RoutingEntryBelowTier, SecondOpinionUnanswered, SecondOpinionUnavailable } from "./errors.js";
import { LLMGateway } from "./gateway.js";
import { ProviderRegistry } from "./provider-registry.js";
import { ROUTING_RULES } from "./routing-rules.js";
import type { RoutingRules } from "./routing-rules.js";
import type { CapabilityLevel } from "./capability-level.js";
import type { GatewayConfig, ModelConfig, SecondOpinion } from "./types.js";

// Each rule is changed in its value alone: the model chosen and the text stating the rule must both follow it.

const model = (provider: string, id: string, grade: CapabilityLevel, inputCostPer1M: number): ModelConfig => ({
  id,
  apiModelId: id,
  provider,
  capabilityLevel: grade,
  thinkingOffCapabilityLevel: grade,
  inputCostPer1M,
  outputCostPer1M: inputCostPer1M,
  maxContextTokens: 128_000,
  cacheReadCostPer1M: null,
  cacheWriteCostPer1M: null,
  priceWindows: [],
  priceTiers: [],
  datedPrices: [],
});

const configOf = (providers: ReadonlyArray<readonly [string, readonly ModelConfig[]]>): GatewayConfig => ({
  providers: providers.map(([name, models]) => ({ name, providerType: "openai-compatible", apiKey: "k", baseUrl: "https://example.invalid/v1", models: [...models], enabled: true })),
  defaultProvider: providers[0]?.[0] ?? "none",
  contextOverflow: { statuses: [400], codes: ["context_length_exceeded"], phrases: [] },
});

const scripted = () => new MockLanguageModelV4();
const registryOf = (config: GatewayConfig, rules: RoutingRules) => new ProviderRegistry(config, scripted, rules);

const ALPHA = [model("alpha", "alpha-medium", "Medium", 1), model("alpha", "alpha-strong", "Strong", 2), model("alpha", "alpha-frontier", "Frontier", 9)];

const answered = () =>
  new MockLanguageModelV4({
    doGenerate: {
      content: [{ type: "text" as const, text: '{"ok":true}' }],
      usage: {
        inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
        raw: undefined,
      },
      finishReason: { unified: "stop" as const, raw: "stop" },
      warnings: [],
    },
  });

const gatedOf = (config: GatewayConfig, rules: RoutingRules) =>
  new LLMGateway(config, () => new Date(), answered, rules).gated("suite-review", { admit: async () => {}, settle: async () => {} });

const refusal = (run: () => unknown): unknown => {
  try {
    run();
  } catch (err) {
    return err;
  }
  return expect.unreachable("the request was not refused");
};

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : expect.unreachable(`not an Error: ${String(err)}`));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the capability floor", () => {
  const raised: RoutingRules = { ...ROUTING_RULES, capabilityFloor: { tiersAbove: 1 } };

  test("the model chosen and the refusal's text both follow the floor", () => {
    const config = configOf([["alpha", ALPHA]]);
    expect(registryOf(config, ROUTING_RULES).resolve("Medium").modelConfig.id).toBe("alpha-medium");
    expect(registryOf(config, raised).resolve("Medium").modelConfig.id).toBe("alpha-strong");

    const atFloor = refusal(() => registryOf(configOf([["alpha", ALPHA.slice(0, 2)]]), ROUTING_RULES).resolve("Frontier"));
    const aboveFloor = refusal(() => registryOf(configOf([["alpha", ALPHA.slice(0, 2)]]), raised).resolve("Strong"));
    expect(atFloor).toBeInstanceOf(NoProviderAvailableError);
    expect(messageOf(atFloor)).toContain("graded at or above that level");
    expect(messageOf(aboveFloor)).toContain("graded at least one tier above that level");
    expect(messageOf(aboveFloor)).not.toContain("at or above");
  });

  test("RoutingEntryBelowTier's headline and advice both state the floor the profile check applies", () => {
    const entries = [{ site: "suite-review", tier: "Strong" as const, model: "m", grade: "Strong" as const }];
    const atFloor = new RoutingEntryBelowTier({ combo: "alpha", entries, configPath: "c", floor: ROUTING_RULES.capabilityFloor }).message;
    const aboveFloor = new RoutingEntryBelowTier({ combo: "alpha", entries, configPath: "c", floor: { tiersAbove: 1 } }).message;
    expect(atFloor).toContain("maps tier(s) to a model not graded at or above them as called at the site");
    expect(aboveFloor).toContain("maps tier(s) to a model not graded at least one tier above them as called at the site");
    expect(aboveFloor).not.toContain("below them");
    expect(aboveFloor).not.toContain("at or above");
  });
});

describe("the judge rule", () => {
  const atTierOnly: RoutingRules = { ...ROUTING_RULES, judge: { rungs: [0] } };
  const twoAbove: RoutingRules = { ...ROUTING_RULES, judge: { rungs: [2, 1, 0] } };

  test("the judge chosen follows the rule's rungs", () => {
    const config = configOf([["alpha", ALPHA]]);
    expect(registryOf(config, ROUTING_RULES).resolveJudge("Medium").modelConfig.id).toBe("alpha-strong");
    expect(registryOf(config, atTierOnly).resolveJudge("Medium").modelConfig.id).toBe("alpha-medium");
    expect(registryOf(config, twoAbove).resolveJudge("Medium").modelConfig.id).toBe("alpha-frontier");
  });

  test("JudgeUnavailable states the rule it was refused under", () => {
    const config = configOf([["alpha", ALPHA.slice(0, 1)]]);
    const ladder = refusal(() => registryOf(config, ROUTING_RULES).resolveJudge("Strong"));
    const flat = refusal(() => registryOf(config, atTierOnly).resolveJudge("Strong"));
    expect(ladder).toBeInstanceOf(JudgeUnavailable);
    expect(messageOf(ladder)).toContain("a judge is graded one tier above the work, else at its tier, never lower");
    expect(messageOf(flat)).toContain("a judge is graded at its tier, never lower");
    expect(messageOf(flat)).not.toContain("one tier above");
  });

  test("the warning on a judge no stronger than the work names the rungs above it the rule asked", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = configOf([["alpha", ALPHA]]);
    const ask = { judges: "Frontier" as const, prompt: "p", schema: z.object({ ok: z.boolean() }), maxTokens: 10, abortSignal: new AbortController().signal };
    await gatedOf(config, ROUTING_RULES).generateStructured(ask);
    await gatedOf(config, twoAbove).generateStructured(ask);
    const lines = warned.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("no stronger than the work"));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("since no model one tier above it is routed there");
    expect(lines[1]).toContain("since no model 2 tiers above it or one tier above it is routed there");
  });
});

describe("the second-opinion rule", () => {
  const avoid = { provider: "alpha", model: "alpha-frontier" };
  const sameFamily: SecondOpinion = { avoid, strength: "same-family-other-model" };
  const withSameFamily = (judging: RoutingRules["secondOpinion"]["same-family-other-model"]["judging"]): RoutingRules => ({
    ...ROUTING_RULES,
    secondOpinion: { ...ROUTING_RULES.secondOpinion, "same-family-other-model": { ...ROUTING_RULES.secondOpinion["same-family-other-model"], judging } },
  });
  const floorAbove = withSameFamily({ kind: "floor", tiersAbove: 1 });
  const asJudge = withSameFamily({ kind: "judge-rule" });

  test("a same-family opinion on judged work takes the model its rule holds it to", () => {
    const config = configOf([["alpha", ALPHA], ["beta", [model("beta", "beta-frontier", "Frontier", 5)]]]);
    const chosen = (rules: RoutingRules) => registryOf(config, rules).resolveSecondOpinion({ judges: "Medium" }, sameFamily)?.modelConfig.id;
    expect(chosen(ROUTING_RULES)).toBe("alpha-medium");
    expect(chosen(floorAbove)).toBe("alpha-strong");
    expect(chosen(asJudge)).toBe("alpha-strong");
  });

  test("SecondOpinionUnavailable states the rule of the strength it was refused under", async () => {
    const config = configOf([["alpha", [ALPHA[2]]], ["beta", [model("beta", "beta-frontier", "Frontier", 5)]]]);
    const ask = { judges: "Medium" as const, prompt: "p", schema: z.object({ ok: z.boolean() }), maxTokens: 10, secondOpinion: sameFamily, abortSignal: new AbortController().signal };
    const refused = async (rules: RoutingRules): Promise<string> => {
      const err: unknown = await gatedOf(config, rules).generateStructured(ask).then(
        () => expect.unreachable("the second opinion was served"),
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(SecondOpinionUnavailable);
      return messageOf(err);
    };
    const atTier = await refused(ROUTING_RULES);
    const above = await refused(floorAbove);
    const judgeLike = await refused(asJudge);
    expect(atTier).toContain("it goes only to another model of the avoided provider, the cheapest such model graded at or above the judged tier");
    expect(above).toContain("the cheapest such model graded at least one tier above the judged tier");
    expect(judgeLike).toContain("as a judge is: graded one tier above the work, else at its tier, never lower");
    expect(new Set([atTier, above, judgeLike]).size).toBe(3);
  });

  test("a same-model opinion on judged work, refused while another model serves the tier, names no model the selection does not take", async () => {
    const config = configOf([["alpha", ALPHA]]);
    const sameModel: SecondOpinion = { avoid, strength: "same-model" };
    expect(registryOf(config, ROUTING_RULES).resolveSecondOpinion({ judges: "Medium" }, sameModel)).toBeNull();
    const ask = { judges: "Medium" as const, prompt: "p", schema: z.object({ ok: z.boolean() }), maxTokens: 10, secondOpinion: sameModel, abortSignal: new AbortController().signal };
    const err: unknown = await gatedOf(config, ROUTING_RULES).generateStructured(ask).then(
      () => expect.unreachable("the second opinion was served"),
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SecondOpinionUnavailable);
    expect(messageOf(err)).toContain(
      "it goes only to the avoided model itself, and only when no other enabled model serves the tier, that model graded at or above the judged tier",
    );
    expect(messageOf(err)).not.toContain("cheapest");
  });

  test("SecondOpinionUnanswered states the failover of the strength's rule", () => {
    const otherFamily: SecondOpinion = { avoid, strength: "other-family" };
    const pinned: RoutingRules = {
      ...ROUTING_RULES,
      secondOpinion: { ...ROUTING_RULES.secondOpinion, "other-family": { ...ROUTING_RULES.secondOpinion["other-family"], failover: "none" } },
    };
    const routedTo = { provider: "beta", model: "beta-frontier" };
    const cause = new NoProviderAvailableError("Strong", [], ROUTING_RULES.capabilityFloor);
    expect(new SecondOpinionUnanswered(otherFamily, routedTo, ROUTING_RULES, { cause }).message).toContain("and no failover went to alpha");
    expect(new SecondOpinionUnanswered(otherFamily, routedTo, pinned, { cause }).message).toContain("with no failover to another model");
  });
});
