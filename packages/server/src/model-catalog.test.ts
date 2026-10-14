import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { ConfigRepository, createDb, DEFAULT_DATABASE_URL } from "@ashara/db";
import {
  buildGateway,
  LLMGateway,
  loadRoutingProfilesFromToml,
  measureCost,
  resolveModelsConfigPath,
  sdkLanguageModels,
  StructuredOutputExhausted,
  toModelConfig,
  withStructuredLadder,
} from "@ashara/llm-gateway";
import type { LanguageModelFactory } from "@ashara/llm-gateway";

// Against the shared dev database (in CI, the freshly migrated one). The routing
// check only reads the catalog; the price-window test creates one model row with
// its windows, and afterAll deletes exactly that row (its windows cascade).

const DATABASE_URL = process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL;
const MODEL_ID = `catalog-test-${randomUUID().slice(0, 8)}`;

let db: ReturnType<typeof createDb>;
let repo: ConfigRepository;

beforeAll(() => {
  db = createDb(DATABASE_URL);
  repo = new ConfigRepository(db);
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM model_configs WHERE model_id = ${MODEL_ID}`);
  await db.$client.end();
});

describe("the model catalog", () => {
  test("every model a routing profile in config/models.toml names is a priced model_configs row", async () => {
    const profiles = loadRoutingProfilesFromToml(resolveModelsConfigPath());
    const named = Object.values(profiles)
      .flatMap((profile) => Object.values(profile))
      .flatMap((entry) => (typeof entry === "string" ? [entry] : Object.values(entry ?? {})))
      .filter((id): id is string => id !== undefined);
    const catalog = new Map((await repo.listModelConfigs()).map((m) => [m.modelId, m]));

    const unpriced = named.filter((id) => {
      const row = catalog.get(id);
      return row === undefined || !(row.inputCostPer1m > 0 && row.outputCostPer1m > 0);
    });

    expect(named.length).toBeGreaterThan(0);
    expect(unpriced).toEqual([]);
  });

  test("a model's price windows load with it and set the rate at the call's instant", async () => {
    await db.execute(sql`
      INSERT INTO model_configs (model_id, provider_name, capability, input_cost_per_1m, output_cost_per_1m,
                                 cache_read_cost_per_1m, max_context_tokens)
      VALUES (${MODEL_ID}, 'deepseek', 'Strong', 0.30, 1.20, 0.006, 1000000)`);
    await db.execute(sql`
      INSERT INTO model_price_windows (model_id, iso_weekday, utc_start_minute, utc_end_minute,
                                       input_cost_per_1m, output_cost_per_1m, cache_read_cost_per_1m)
      VALUES (${MODEL_ID}, 3, 600, 1440, 0.15, 0.60, 0.003)`);

    const row = (await repo.listModelConfigs()).find((m) => m.modelId === MODEL_ID);
    if (row === undefined) return expect.unreachable(`${MODEL_ID} not listed`);
    expect(row.priceWindows).toHaveLength(1);
    const model = toModelConfig("model_configs", row);

    // Wednesday 2026-10-14: 09:59 UTC is outside the window, 10:00 is its first minute.
    const reported = { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 400, cacheWriteTokens: 0 };
    const peak = measureCost(reported, model, new Date("2026-10-14T09:59:00Z"));
    const offPeak = measureCost(reported, model, new Date("2026-10-14T10:00:00Z"));
    if (!peak.measured || !offPeak.measured) return expect.unreachable("both instants are priced");
    expect(peak.totalCost).toBeCloseTo((600 * 0.3 + 400 * 0.006 + 100 * 1.2) / 1_000_000, 12);
    expect(offPeak.totalCost).toBeCloseTo((600 * 0.15 + 400 * 0.003 + 100 * 0.6) / 1_000_000, 12);
  });

  test("capability routing over the Anthropic catalog resolves Strong to the current Sonnet, claude-sonnet-5-5", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const models = (await repo.listModelConfigs())
      .filter((m) => m.providerName === "anthropic")
      .map((m) => toModelConfig("model_configs", m));
    const gateway = new LLMGateway(
      {
        providers: [{ name: "anthropic", providerType: "anthropic", apiKey: "unused", models, enabled: true }],
        defaultProvider: "anthropic",
      },
      { kind: "unrecorded", reason: "resolution only: no request is sent" },
      () => new Date(),
      sdkLanguageModels,
    );

    expect(gateway.resolveModel("Strong", "decomposition").modelId).toBe("claude-sonnet-5-5");
  });
});

describe("the migrated catalog (021, 026, 047)", () => {
  test("deepseek-flash is charged off-peak outside 01:00-04:00 and 06:00-10:00 UTC on weekdays, and all weekend", async () => {
    const row = (await repo.listModelConfigs()).find((m) => m.modelId === "deepseek-flash");
    if (row === undefined) return expect.unreachable("deepseek-flash not migrated");
    const model = toModelConfig("model_configs", row);
    const reported = { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 400, cacheWriteTokens: null };
    const costAt = (iso: string): number => {
      const cost = measureCost(reported, model, new Date(iso));
      if (!cost.measured) return expect.unreachable(`deepseek-flash unpriced at ${iso}`);
      return cost.totalCost;
    };
    const peak = (600 * 0.3 + 400 * 0.006 + 100 * 1.2) / 1_000_000;
    const offPeak = (600 * 0.15 + 400 * 0.003 + 100 * 0.6) / 1_000_000;

    // 2026-10-12 is a Monday, 2026-10-17 a Saturday.
    expect(costAt("2026-10-12T00:59:00Z")).toBeCloseTo(offPeak, 12);
    expect(costAt("2026-10-12T01:00:00Z")).toBeCloseTo(peak, 12);
    expect(costAt("2026-10-12T10:00:00Z")).toBeCloseTo(offPeak, 12);
    expect(costAt("2026-10-17T02:00:00Z")).toBeCloseTo(offPeak, 12);
  });

  test("grok-3-mini, whose price the investigation could not verify, is not in the catalog", async () => {
    const ids = (await repo.listModelConfigs()).map((m) => m.modelId);
    expect(ids).not.toContain("grok-3-mini");
  });

  test("grok-3-mini's removal (026) holds", async () => {
    const ids = (await repo.listModelConfigs()).map((m) => m.modelId);
    expect(ids).not.toContain("grok-3-mini");
  });
});

// docs/investigations/model-catalog-2026-10-14.md §8 with ADR-074 item 83: level as
// called (deepseek-flash with thinking on), base-tier prices, mistral-large-4 at list.
const CATALOG_047: readonly (readonly [string, string, string, number, number, number | null, number | null, number])[] = [
  ["claude-fable-5-1", "anthropic", "Frontier", 10, 50, 0.25, 12.5, 1_000_000],
  ["claude-opus-5-5", "anthropic", "Frontier", 4, 20, 0.2, 5, 1_000_000],
  ["claude-sonnet-5-5", "anthropic", "Strong", 2, 10, 0.1, 2.5, 1_000_000],
  ["claude-haiku-5-5", "anthropic", "Medium", 0.1, 0.5, 0.01, 0.125, 1_000_000],
  ["deepseek-flash", "deepseek", "Strong", 0.3, 1.2, 0.006, null, 1_000_000],
  ["gpt-6-astra", "openai", "Frontier", 10, 50, 1, 12.5, 1_050_000],
  ["gpt-6.1-sol", "openai", "Strong", 2, 10, 0.1, 2.5, 1_050_000],
  ["gpt-6-luna", "openai", "Light", 0.1, 0.5, 0.01, 0.125, 1_050_000],
  ["gemini-4-argon", "google", "Frontier", 2, 10, 0.1, null, 1_048_576],
  ["gemini-3.8-flash", "google", "Medium", 0.75, 3.75, 0.075, null, 1_048_576],
  ["gemini-3.5-flash-lite", "google", "Light", 0.3, 2.5, 0.03, null, 1_048_576],
  ["grok-4.7", "xai", "Medium", 2, 6, 0.5, null, 500_000],
  ["grok-4.3", "xai", "Light", 1.25, 2.5, 0.2, null, 1_000_000],
  ["mistral-large-4", "mistral", "Strong", 1.36, 4.18, 0.14, null, 1_000_000],
  ["mistral-medium-3-5", "mistral", "Light", 1.5, 7.5, 0.15, null, 256_000],
  ["mistral-small-2603", "mistral", "Light", 0.15, 0.6, 0.015, null, 256_000],
  ["ministral-3b-2512", "mistral", "Light", 0.1, 0.1, 0.01, null, 256_000],
  ["codestral-2508", "mistral", "Light", 0.3, 0.9, 0.03, null, 128_000],
];

describe("the migrated catalog (047)", () => {
  test("holds exactly the record's eighteen models, each with its level, base-tier prices, context and API id", async () => {
    // The price-window test above adds one row of its own until afterAll.
    const rows = (await repo.listModelConfigs()).filter((m) => m.modelId !== MODEL_ID).map((m) => [
      m.modelId, m.providerName, m.capability, m.inputCostPer1m, m.outputCostPer1m, m.cacheReadCostPer1m,
      m.cacheWriteCostPer1m, m.maxContextTokens, m.apiModelId,
    ]);
    const expected = CATALOG_047.map((row) => [...row, row[0]]);
    const byId = (a: readonly unknown[], b: readonly unknown[]) => String(a[0]).localeCompare(String(b[0]));
    expect(rows.sort(byId)).toEqual(expected.sort(byId));
  });

  test("holds the higher prompt-length tiers, and only those, at the thresholds the providers state", async () => {
    const tiers = (await repo.listModelConfigs()).flatMap((m) =>
      m.priceTiers.map((t) => [m.modelId, t.minInputTokens, t.inputCostPer1m, t.outputCostPer1m, t.cacheReadCostPer1m, t.cacheWriteCostPer1m]),
    );
    expect(tiers).toEqual(expect.arrayContaining([
      ["claude-haiku-5-5", 100_001, 0.5, 2.5, 0.05, 0.625],
      ["gpt-6-astra", 272_001, 20, 75, 2, 25],
      ["gpt-6.1-sol", 272_001, 4, 15, 0.2, 5],
      ["gpt-6-luna", 272_001, 0.2, 0.75, 0.02, 0.25],
      ["grok-4.7", 200_000, 4, 12, 1, null],
      ["grok-4.3", 200_000, 2.5, 5, 0.4, null],
    ]));
    expect(tiers).toHaveLength(6);
  });

  test("the ledger prices a migrated model at its actual tier: grok-4.7 below, at and past 200,000 tokens", async () => {
    const row = (await repo.listModelConfigs()).find((m) => m.modelId === "grok-4.7");
    if (row === undefined) return expect.unreachable("grok-4.7 not migrated");
    const model = toModelConfig("model_configs", row);
    const costOf = (inputTokens: number): number => {
      const cost = measureCost({ inputTokens, outputTokens: 1_000, cacheReadTokens: 0, cacheWriteTokens: null }, model, new Date());
      if (!cost.measured) return expect.unreachable(`grok-4.7 unpriced at ${inputTokens}`);
      return cost.totalCost;
    };
    expect(costOf(199_999)).toBeCloseTo((199_999 * 2 + 1_000 * 6) / 1_000_000, 12);
    expect(costOf(200_000)).toBeCloseTo((200_000 * 4 + 1_000 * 12) / 1_000_000, 12);
  });
});

describe("routing over the migrated catalog and config/models.toml, per profile and level", () => {
  const LEVELS = ["Light", "Medium", "Strong", "Frontier"] as const;
  type Level = (typeof LEVELS)[number];
  type Site = Parameters<LLMGateway["resolveModel"]>[1];
  const SITES: readonly Site[] = ["agent-runner", "decomposition", "liaison-intake", "roster", "suite-review", "escalation"];

  async function gatewayFor(
    providerNames: readonly string[],
    withProfiles: boolean,
    models: LanguageModelFactory = sdkLanguageModels,
  ): Promise<LLMGateway> {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const catalog = (await repo.listModelConfigs())
      .filter((m) => m.modelId !== MODEL_ID)
      .map((m) => toModelConfig("model_configs", m));
    const typeOf: Record<string, "anthropic" | "deepseek"> = { anthropic: "anthropic", deepseek: "deepseek" };
    return buildGateway({
      config: {
        providers: providerNames.map((name) => ({
          name,
          providerType: typeOf[name] ?? "deepseek",
          apiKey: "unused",
          baseUrl: "https://stub.invalid/v1",
          models: catalog.filter((m) => m.provider === name),
          enabled: true,
        })),
        defaultProvider: providerNames[0] ?? "none",
        routingProfiles: withProfiles ? loadRoutingProfilesFromToml(resolveModelsConfigPath()) : {},
      },
      checkedSources: ["test"],
      recording: { kind: "unrecorded", reason: "resolution only, or a scripted model: nothing is charged" },
      clock: () => new Date(),
      models,
    });
  }

  const resolvedAt = (gateway: LLMGateway, site: Site, level: Level): string => {
    try {
      return gateway.resolveModel(level, site).modelId;
    } catch (err) {
      return err instanceof Error && err.name === "NoProviderAvailableError" ? err.name : `unexpected ${String(err)}`;
    }
  };
  const table = (gateway: LLMGateway) =>
    Object.fromEntries(SITES.map((site) => [site, LEVELS.map((level) => resolvedAt(gateway, site, level))]));
  const everySite = (levels: readonly string[]) => Object.fromEntries(SITES.map((site) => [site, levels]));

  test('"deepseek": every level up to Strong is deepseek-flash; Frontier has no model and fails closed', async () => {
    expect(table(await gatewayFor(["deepseek"], true))).toEqual(
      everySite(["deepseek-flash", "deepseek-flash", "deepseek-flash", "NoProviderAvailableError"]),
    );
  });

  test('"deepseek": a Strong structured call whose attempts all fail ends in StructuredOutputExhausted, with no Frontier tier to escalate to', async () => {
    const scripted = new MockLanguageModelV4({
      doGenerate: {
        content: [{ type: "text" as const, text: '{"wrong":true}' }],
        usage: {
          inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 10, text: 10, reasoning: undefined },
          raw: undefined,
        },
        finishReason: { unified: "stop" as const, raw: "stop" },
        warnings: [],
      },
    });
    const ladder = withStructuredLadder(await gatewayFor(["deepseek"], true, () => scripted), { site: "roster", attempts: 2 });

    const failure = await ladder
      .generateStructured({ capability: "Strong", prompt: "p", schema: z.object({ roles: z.array(z.string()) }), maxTokens: 100 })
      .then(() => null, (err: unknown) => err);

    if (!(failure instanceof StructuredOutputExhausted)) return expect.unreachable(`not exhausted: ${String(failure)}`);
    expect(failure.perModel.map((m) => [m.capability, m.model, m.attempts])).toEqual([["Strong", "deepseek-flash", 2]]);
    expect(failure.unavailableEscalation?.capability).toBe("Frontier");
    expect(failure.unavailableEscalation?.reason).toContain("deepseek-flash (Strong)");
    expect(scripted.doGenerateCalls).toHaveLength(2);
  });

  test('"anthropic": Frontier is claude-opus-5-5, every other level claude-sonnet-5-5', async () => {
    expect(table(await gatewayFor(["anthropic"], true))).toEqual(
      everySite(["claude-sonnet-5-5", "claude-sonnet-5-5", "claude-sonnet-5-5", "claude-opus-5-5"]),
    );
  });

  test('"anthropic+deepseek": agent-runner goes to the Claude model of each level; planning sites to deepseek-flash', async () => {
    const flash = ["deepseek-flash", "deepseek-flash", "deepseek-flash", "deepseek-flash"];
    expect(table(await gatewayFor(["anthropic", "deepseek"], true))).toEqual({
      "agent-runner": ["claude-haiku-5-5", "claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"],
      decomposition: flash,
      "liaison-intake": flash,
      roster: flash,
      "suite-review": flash,
      escalation: ["claude-opus-5-5", "claude-opus-5-5", "claude-opus-5-5", "claude-opus-5-5"],
    });
  });

  test("capability logic over Anthropic alone picks the cheapest model at or above each level", async () => {
    const gateway = await gatewayFor(["anthropic"], false);
    expect(LEVELS.map((level) => resolvedAt(gateway, "agent-runner", level))).toEqual([
      "claude-haiku-5-5", "claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5",
    ]);
  });
});
