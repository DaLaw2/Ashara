import { asc } from "drizzle-orm";
import type { Database } from "../connection.js";
import { modelConfigs, modelPriceTiers, modelPriceWindows, providerConfigs } from "../schema/index.js";

type PriceWindowRow = typeof modelPriceWindows.$inferSelect;
type PriceTierRow = typeof modelPriceTiers.$inferSelect;

function toPriceWindow(row: PriceWindowRow) {
  return {
    isoWeekday: row.isoWeekday,
    utcStartMinute: row.utcStartMinute,
    utcEndMinute: row.utcEndMinute,
    inputCostPer1m: row.inputCostPer1m,
    outputCostPer1m: row.outputCostPer1m,
    cacheReadCostPer1m: row.cacheReadCostPer1m,
    cacheWriteCostPer1m: row.cacheWriteCostPer1m,
  };
}

function toPriceTier(row: PriceTierRow) {
  return {
    minInputTokens: row.minInputTokens,
    inputCostPer1m: row.inputCostPer1m,
    outputCostPer1m: row.outputCostPer1m,
    cacheReadCostPer1m: row.cacheReadCostPer1m,
    cacheWriteCostPer1m: row.cacheWriteCostPer1m,
  };
}

export class ConfigRepository {
  constructor(private readonly db: Database) {}

  /**
   * Every model_configs row with its model_price_windows rows (empty when the
   * model has one price at all hours) and its model_price_tiers rows (empty when
   * it has one price at every prompt length).
   *
   * Ordered cheapest first, then by id, so the listing is total and stable for
   * every reader. Routing does not depend on it: `findBestModel` sorts the
   * qualifying models by the same key itself.
   */
  async listModelConfigs() {
    const [models, windows, tiers] = await Promise.all([
      this.db
        .select()
        .from(modelConfigs)
        .orderBy(
          asc(modelConfigs.inputCostPer1m),
          asc(modelConfigs.outputCostPer1m),
          asc(modelConfigs.modelId),
        ),
      this.db
        .select()
        .from(modelPriceWindows)
        .orderBy(asc(modelPriceWindows.modelId), asc(modelPriceWindows.isoWeekday), asc(modelPriceWindows.utcStartMinute)),
      this.db
        .select()
        .from(modelPriceTiers)
        .orderBy(asc(modelPriceTiers.modelId), asc(modelPriceTiers.minInputTokens)),
    ]);
    return models.map((model) => ({
      ...model,
      priceWindows: windows.filter((w) => w.modelId === model.modelId).map(toPriceWindow),
      priceTiers: tiers.filter((t) => t.modelId === model.modelId).map(toPriceTier),
    }));
  }

  async listProviderConfigs() {
    return this.db.select().from(providerConfigs);
  }
}
