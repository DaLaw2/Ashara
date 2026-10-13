import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { sql } from "drizzle-orm";
import { ConfigRepository, createDb, DEFAULT_DATABASE_URL } from "@ashara/db";
import {
  LLMGateway,
  loadRoutingProfilesFromToml,
  measureCost,
  resolveModelsConfigPath,
  toModelConfig,
} from "@ashara/llm-gateway";

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
        providers: [{ name: "anthropic", apiKey: "unused", models, enabled: true }],
        defaultProvider: "anthropic",
      },
      { kind: "unrecorded", reason: "resolution only: no request is sent" },
    );

    expect(gateway.resolveModel("Strong", "decomposition").modelId).toBe("claude-sonnet-5-5");
  });
});
