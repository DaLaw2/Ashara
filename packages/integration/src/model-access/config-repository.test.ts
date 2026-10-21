import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createDb, resolveTestDatabaseUrl, type Database } from "@ashara/db";
import { modelConfigs, providerConfigs } from "@ashara/db/schema/model-access";
import { ConfigRepository } from "@ashara/model-access";

const DATABASE_URL = resolveTestDatabaseUrl(process.env);

let db: Database;

beforeAll(() => {
  db = createDb(DATABASE_URL);
});

const createdProviderNames: string[] = [];
const createdModelIds: string[] = [];

afterAll(async () => {
  for (const modelId of createdModelIds) {
    await db.execute(sql`DELETE FROM model_configs WHERE model_id = ${modelId}`);
  }
  for (const name of createdProviderNames) {
    await db.execute(sql`DELETE FROM provider_configs WHERE name = ${name}`);
  }
  await db.$client.end();
});

describe("ConfigRepository.listModelConfigs", () => {
  test("loads each model's seeded dated prices", async () => {
    const models = await new ConfigRepository(db).listModelConfigs();
    const dated = models.flatMap((m) =>
      m.datedPrices.map((p) => [
        m.modelId,
        p.effectiveFrom.toISOString(),
        p.inputCostPer1m,
        p.outputCostPer1m,
        p.cacheReadCostPer1m,
        p.cacheWriteCostPer1m,
      ]),
    );
    expect(dated).toEqual(expect.arrayContaining([
      ["gemini-4-argon", "2026-12-01T00:00:00.000Z", 4, 20, 0.2, null],
      ["gemini-3.8-flash", "2027-01-01T00:00:00.000Z", 1.5, 7.5, 0.15, null],
    ]));
    expect(dated).toHaveLength(2);
  });
});

describe("ConfigRepository round trip", () => {
  let repo: ConfigRepository;
  const testProviderName = `test-provider-${randomUUID().slice(0, 8)}`;
  const testModelId = `test-model-${randomUUID().slice(0, 8)}`;

  beforeAll(() => {
    repo = new ConfigRepository(db);
  });

  test("providers and model configs each round-trip through their table", async () => {
    createdProviderNames.push(testProviderName);
    await db.insert(providerConfigs).values({
      name: testProviderName,
      providerType: "openai-compatible",
      baseUrl: "http://localhost:11434/v1",
    });
    const providers = await repo.listProviderConfigs();
    const provider = providers.find((p) => p.name === testProviderName);
    expect(provider?.providerType).toBe("openai-compatible");
    expect(provider?.baseUrl).toBe("http://localhost:11434/v1");
    expect(provider).not.toHaveProperty("apiKey");

    createdModelIds.push(testModelId);
    await db.insert(modelConfigs).values({
      modelId: testModelId,
      providerName: testProviderName,
      capability: "Strong",
      capabilityThinkingOff: "Strong",
      inputCostPer1m: 3.0,
      outputCostPer1m: 0,
      maxContextTokens: 128000,
    });
    const models = await repo.listModelConfigs();
    const model = models.find((m) => m.modelId === testModelId);
    expect(model?.providerName).toBe(testProviderName);
    expect(model?.capability).toBe("Strong");
  });
});
