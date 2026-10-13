import { writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { loadGatewayCatalogFromFile, loadGatewayConfigFromApi, toModelConfig } from "./config.js";
import { InvalidGatewayCatalog } from "./errors.js";

const TMP = join(tmpdir(), "ashara-catalog-test");

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
            priceWindows: [],
        }],
        providers: [{ name: "anthropic", providerType: "anthropic", baseUrl: null }],
    };
}

const SAVED_KEY = process.env["ANTHROPIC_API_KEY"];

beforeEach(async () => {
    await mkdir(TMP, { recursive: true });
    process.env["ANTHROPIC_API_KEY"] = "test-key";
});

afterEach(async () => {
    await rm(TMP, { recursive: true, force: true });
    if (SAVED_KEY === undefined) delete process.env["ANTHROPIC_API_KEY"];
    else process.env["ANTHROPIC_API_KEY"] = SAVED_KEY;
    vi.restoreAllMocks();
});

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
});

describe("loadGatewayCatalogFromFile", () => {
    test("valid catalog produces a GatewayConfig with the provider", async () => {
        const path = join(TMP, "valid.json");
        await writeFile(path, JSON.stringify(validCatalog()));
        const config = await loadGatewayCatalogFromFile(path);
        expect(config.providers).toHaveLength(1);
        expect(config.providers[0].name).toBe("anthropic");
        expect(config.providers[0].models).toHaveLength(1);
    });

    test("absent file throws InvalidGatewayCatalog", async () => {
        const err = await loadGatewayCatalogFromFile("/nonexistent/catalog.json")
            .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(InvalidGatewayCatalog);
        expect((err as InvalidGatewayCatalog).source).toBe("/nonexistent/catalog.json");
    });

    test("malformed JSON throws InvalidGatewayCatalog", async () => {
        const path = join(TMP, "bad.json");
        await writeFile(path, "{ not json }}}");
        const err = await loadGatewayCatalogFromFile(path).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(InvalidGatewayCatalog);
        expect((err as InvalidGatewayCatalog).issues[0]).toContain("invalid JSON");
    });

    test("empty models array fails closed", async () => {
        const catalog = { ...validCatalog(), models: [] };
        const path = join(TMP, "empty-models.json");
        await writeFile(path, JSON.stringify(catalog));
        const err = await loadGatewayCatalogFromFile(path).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(InvalidGatewayCatalog);
    });
});

describe("loadGatewayConfigFromApi", () => {
    function mockFetch(
        models: { body: unknown; ok?: boolean },
        providers: { body: unknown; ok?: boolean },
    ) {
        const resp = (cfg: { body: unknown; ok?: boolean }) => ({
            ok: cfg.ok ?? true,
            status: (cfg.ok ?? true) ? 200 : 500,
            json: () => Promise.resolve(cfg.body),
        });
        vi.stubGlobal("fetch", vi.fn()
            .mockResolvedValueOnce(resp(models))
            .mockResolvedValueOnce(resp(providers)));
    }

    test("malformed model response throws InvalidGatewayCatalog with the server URL", async () => {
        mockFetch(
            { body: [{ modelId: "x" }] },  // missing required fields
            { body: [{ name: "anthropic", providerType: "anthropic", baseUrl: null }] },
        );
        const err = await loadGatewayConfigFromApi("http://test:3000", "tok")
            .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(InvalidGatewayCatalog);
        expect((err as InvalidGatewayCatalog).source).toBe("http://test:3000");
    });

    test("providers endpoint failure throws InvalidGatewayCatalog instead of defaulting", async () => {
        mockFetch(
            { body: [validCatalog().models[0]] },
            { body: null, ok: false },
        );
        const err = await loadGatewayConfigFromApi("http://test:3000", "tok")
            .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(InvalidGatewayCatalog);
        expect((err as InvalidGatewayCatalog).issues[0]).toContain("/config/providers");
    });
});
