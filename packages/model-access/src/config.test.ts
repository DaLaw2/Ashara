import { describe, expect, test } from "vitest";
import { buildGatewayConfig, toModelConfig } from "./config.js";
import { TURN_MAX_OUTPUT_TOKENS } from "./context-window.js";
import { InvalidGatewayCatalog, JudgePinnedBelowTop } from "./errors.js";
import type { ThinkingPolicy } from "./types.js";

function validCatalog() {
    return {
        models: [{
            modelId: "test-model",
            providerName: "anthropic",
            apiModelId: null,
            capability: "Strong",
            inputCostPer1m: 3,
            outputCostPer1m: 15,
            cacheReadCostPer1m: 0.3,
            cacheWriteCostPer1m: 3.75,
            maxContextTokens: 200000,
            priceWindows: [], priceTiers: [],
        }],
    };
}

describe("toModelConfig", () => {
    const offPeak = (utcStartMinute: number, utcEndMinute: number) => ({
        isoWeekday: 1, utcStartMinute, utcEndMinute,
        inputCostPer1m: 1.5, outputCostPer1m: 7.5, cacheReadCostPer1m: 0.15, cacheWriteCostPer1m: 1.875,
    });

    test("refuses overlapping windows on one weekday: the rate at an instant would be ambiguous", () => {
        const model = { ...validCatalog().models[0]!, priceWindows: [offPeak(0, 120), offPeak(60, 180)] };
        expect(() => toModelConfig("catalog.json", model)).toThrow(InvalidGatewayCatalog);
        expect(() => toModelConfig("catalog.json", model)).toThrow(/overlaps priceWindows\[1\]/);
    });

    test("refuses a window that bills a cache class the base rates do not", () => {
        const base = validCatalog().models[0]!;
        const model = { ...base, cacheWriteCostPer1m: null, priceWindows: [offPeak(0, 60)] };
        expect(() => toModelConfig("catalog.json", model)).toThrow(/cache write rate/);
    });

    const longPrompt = { minInputTokens: 200_000, inputCostPer1m: 6, outputCostPer1m: 30, cacheReadCostPer1m: 0.6, cacheWriteCostPer1m: 7.5 };

    test("loads a prompt-length tier with its rates", () => {
        const model = toModelConfig("catalog.json", { ...validCatalog().models[0]!, priceTiers: [longPrompt] });
        expect(model.priceTiers).toEqual([{
            minInputTokens: 200_000,
            rates: { inputCostPer1M: 6, outputCostPer1M: 30, cacheReadCostPer1M: 0.6, cacheWriteCostPer1M: 7.5 },
        }]);
    });

    test("refuses a model with both tiers and windows: no rule combines them", () => {
        const model = { ...validCatalog().models[0]!, priceWindows: [offPeak(0, 60)], priceTiers: [longPrompt] };
        expect(() => toModelConfig("catalog.json", model)).toThrow(/both priceTiers and priceWindows/);
    });

    test("refuses a tier that bills a cache class the base rates do not, or two tiers at one threshold", () => {
        const base = validCatalog().models[0]!;
        expect(() => toModelConfig("catalog.json", { ...base, cacheReadCostPer1m: null, priceTiers: [longPrompt] }))
            .toThrow(/cache read rate/);
        expect(() => toModelConfig("catalog.json", { ...base, priceTiers: [longPrompt, longPrompt] }))
            .toThrow(/share the threshold 200000/);
    });
});

describe("toModelConfig: the context window has no default", () => {
    test("loads the catalogued window as it is", () => {
        expect(toModelConfig("model_configs", validCatalog().models[0]!).maxContextTokens).toBe(200000);
    });

    test.each([0, -1, 1.5, Number.NaN])("refuses window %s at boot, naming the model", (maxContextTokens) => {
        const model = { ...validCatalog().models[0]!, maxContextTokens };
        expect(() => toModelConfig("model_configs", model)).toThrow(InvalidGatewayCatalog);
        expect(() => toModelConfig("model_configs", model)).toThrow(/test-model: maxContextTokens .* is not a positive integer/);
    });

    test("refuses a row that carries no window at all", () => {
        const { maxContextTokens: _dropped, ...withoutWindow } = validCatalog().models[0]!;
        const row: Parameters<typeof toModelConfig>[1] = Object.assign(withoutWindow, { maxContextTokens: undefined as unknown as number });
        expect(() => toModelConfig("model_configs", row)).toThrow(/test-model: maxContextTokens undefined is not a positive integer/);
    });
});

const OVERFLOW = { statuses: [400], codes: ["context_length_exceeded"], phrases: [] };
const THINKING_OFF: ThinkingPolicy = { default: "off", sites: {} };

describe("buildGatewayConfig reads the provider type, not the name", () => {
    const model = toModelConfig("model_configs", { ...validCatalog().models[0]!, providerName: "ollama" });

    test("a local-type row of any name needs no key; an unknown type refuses to build", () => {
        const local = buildGatewayConfig({ m: model }, {}, [
            { name: "ollama", providerType: "local", apiKey: null, baseUrl: "http://localhost:11434/v1" },
        ], OVERFLOW, THINKING_OFF);
        expect(local.providers.map((p) => [p.name, p.providerType])).toEqual([["ollama", "local"]]);

        expect(() =>
            buildGatewayConfig({ m: model }, {}, [{ name: "ollama", providerType: "vllm", apiKey: "k", baseUrl: null }], OVERFLOW, THINKING_OFF),
        ).toThrow(/provider "ollama": provider_type "vllm"/);
    });
});

// A flat entry applies whatever tier a judging request asks, so at a judgement site it must be graded at the catalog's top tier.
describe("buildGatewayConfig: a judgement site is never pinned flatly below the catalog's top tier", () => {
    const graded = (modelId: string, capability: string) => toModelConfig("model_configs", { ...validCatalog().models[0]!, modelId, capability });
    const catalog = { "model-strong": graded("model-strong", "Strong"), "model-frontier": graded("model-frontier", "Frontier") };
    const build = (profile: Parameters<typeof buildGatewayConfig>[1][string]) =>
        buildGatewayConfig(catalog, { anthropic: profile }, [{ name: "anthropic", providerType: "anthropic", apiKey: "k", baseUrl: null }], OVERFLOW, THINKING_OFF);

    test("refuses a flat judgement-site pin graded below the top tier, naming the site, the model and its grade", () => {
        expect(() => build({ "suite-review": "model-strong" })).toThrow(JudgePinnedBelowTop);
        expect(() => build({ "suite-review": "model-strong" })).toThrow(/top tier "Frontier": "suite-review" -> "model-strong" \(Strong\)/);
        expect(() => build({ "suite-review": { default: "model-frontier" }, escalation: "model-strong" })).toThrow(/"escalation" -> "model-strong"/);
    });

    test("boots a per-capability table, a flat pin at the top tier, and a flat pin at a site that judges nothing", () => {
        expect(build({ "suite-review": { Frontier: "model-frontier", default: "model-strong" } }).providers).toHaveLength(1);
        expect(build({ "suite-review": "model-frontier", escalation: "model-frontier" }).providers).toHaveLength(1);
        expect(build({ decomposition: "model-strong" }).providers).toHaveLength(1);
    });
});

// The boot check reserves what the gateway's preflight reserves for a turn at
// every site, the reasoning allowance included where thinking is on.
describe("buildGatewayConfig: a window must hold input beside the output a turn reserves at every site", () => {
    const deepseek = (maxContextTokens: number) =>
        toModelConfig("model_configs", { ...validCatalog().models[0]!, providerName: "deepseek", maxContextTokens });
    const build = (maxContextTokens: number, thinking: ThinkingPolicy) =>
        buildGatewayConfig({ m: deepseek(maxContextTokens) }, {}, [{ name: "deepseek", providerType: "deepseek", apiKey: "k", baseUrl: null }], OVERFLOW, thinking);
    const agentRunnerThinks: ThinkingPolicy = { default: "off", sites: { "agent-runner": "on" } };
    // A turn's answer bound plus the least reasoning allowance (thinking.ts).
    const THINKING_TURN_RESERVE = TURN_MAX_OUTPUT_TOKENS + 32_768;

    test.each([TURN_MAX_OUTPUT_TOKENS, TURN_MAX_OUTPUT_TOKENS - 1, 8_192])(
        "thinking off: refuses window %s, no larger than a turn's answer bound, naming the model",
        (maxContextTokens) => {
            expect(() => build(maxContextTokens, THINKING_OFF)).toThrow(InvalidGatewayCatalog);
            expect(() => build(maxContextTokens, THINKING_OFF)).toThrow(
                new RegExp(`test-model: maxContextTokens ${maxContextTokens} is not larger than the ${TURN_MAX_OUTPUT_TOKENS} output tokens`),
            );
        },
    );

    test("thinking off: loads a window one token larger than a turn's answer bound", () => {
        expect(build(TURN_MAX_OUTPUT_TOKENS + 1, THINKING_OFF).providers[0]!.models[0]!.maxContextTokens).toBe(TURN_MAX_OUTPUT_TOKENS + 1);
    });

    test.each([TURN_MAX_OUTPUT_TOKENS + 1, 30_000, THINKING_TURN_RESERVE])(
        "a site with thinking on: refuses window %s, larger than the answer bound but not the answer plus reasoning, naming the site",
        (maxContextTokens) => {
            expect(() => build(maxContextTokens, agentRunnerThinks)).toThrow(InvalidGatewayCatalog);
            expect(() => build(maxContextTokens, agentRunnerThinks)).toThrow(
                new RegExp(`test-model: maxContextTokens ${maxContextTokens} is not larger than the ${THINKING_TURN_RESERVE} output tokens .*site agent-runner`),
            );
        },
    );

    test("a site with thinking on: loads a window one token larger than the answer plus reasoning", () => {
        expect(build(THINKING_TURN_RESERVE + 1, agentRunnerThinks).thinking).toEqual(agentRunnerThinks);
    });

    test("a provider type that takes no thinking switch reserves only the answer bound, whatever the policy", () => {
        const model = toModelConfig("model_configs", { ...validCatalog().models[0]!, maxContextTokens: 30_000 });
        const config = buildGatewayConfig({ m: model }, {}, [{ name: "anthropic", providerType: "anthropic", apiKey: "k", baseUrl: null }], OVERFLOW, agentRunnerThinks);
        expect(config.providers.map((p) => p.name)).toEqual(["anthropic"]);
    });
});
