import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createDb, DEFAULT_DATABASE_URL, type Database } from "../connection.js";
import { ConfigRepository } from "./config.js";

const DATABASE_URL = process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL;

let db: Database;

beforeAll(() => {
  db = createDb(DATABASE_URL);
});

afterAll(async () => {
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
