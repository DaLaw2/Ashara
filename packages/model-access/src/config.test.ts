import { describe, expect, test } from "vitest";
import { buildGatewayConfig, toModelConfig } from "./config.js";
import { InvalidGatewayCatalog } from "./errors.js";

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

describe("buildGatewayConfig reads the provider type, not the name", () => {
    const model = toModelConfig("model_configs", { ...validCatalog().models[0]!, providerName: "ollama" });

    test("a local-type row of any name needs no key; an unknown type refuses to build", () => {
        const local = buildGatewayConfig({ m: model }, {}, [
            { name: "ollama", providerType: "local", apiKey: null, baseUrl: "http://localhost:11434/v1" },
        ]);
        expect(local.providers.map((p) => [p.name, p.providerType])).toEqual([["ollama", "local"]]);

        expect(() =>
            buildGatewayConfig({ m: model }, {}, [{ name: "ollama", providerType: "vllm", apiKey: "k", baseUrl: null }]),
        ).toThrow(/provider "ollama": provider_type "vllm"/);
    });
});
