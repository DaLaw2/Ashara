import { asc } from "drizzle-orm";
import type { Database } from "../connection.js";
import { modelConfigs, modelPriceWindows, providerConfigs } from "../schema.js";

type PriceWindowRow = typeof modelPriceWindows.$inferSelect;

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

export class ConfigRepository {
  constructor(private readonly db: Database) {}

  /**
   * Every model_configs row with its model_price_windows rows (empty when the
   * model has one price at all hours).
   *
   * Ordered because this listing IS the routing tiebreak: the catalog order
   * reaches `findBestModel`, whose capability sort is stable, so equal-capability
   * models are resolved in the order they arrive here. An unordered select left
   * that choice to Postgres. Cheapest first, then by id so ties are still total.
   */
  async listModelConfigs() {
    const [models, windows] = await Promise.all([
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
    ]);
    return models.map((model) => ({
      ...model,
      priceWindows: windows.filter((w) => w.modelId === model.modelId).map(toPriceWindow),
    }));
  }

  async listProviderConfigs() {
    return this.db.select().from(providerConfigs);
  }
}
