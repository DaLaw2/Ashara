import { asc } from "drizzle-orm";
import type { Database } from "@ashara/db";
import { modelConfigs, modelDatedPrices, modelPriceTiers, modelPriceWindows, providerConfigs } from "@ashara/db/schema/model-access";

type PriceWindowRow = typeof modelPriceWindows.$inferSelect;
type PriceTierRow = typeof modelPriceTiers.$inferSelect;
type DatedPriceRow = typeof modelDatedPrices.$inferSelect;

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

function toDatedPrice(row: DatedPriceRow) {
  return {
    effectiveFrom: row.effectiveFrom,
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
   * model has one price at all hours), its model_price_tiers rows (empty when
   * it has one price at every prompt length) and its model_dated_prices rows in
   * effective order (empty when no price change is scheduled).
   *
   * Ordered cheapest first, then by id, so the listing is total and stable for
   * every reader. Routing does not depend on it: `findBestModel` sorts the
   * qualifying models by the same key itself.
   */
  async listModelConfigs() {
    const [models, windows, tiers, dated] = await Promise.all([
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
      this.db
        .select()
        .from(modelDatedPrices)
        .orderBy(asc(modelDatedPrices.modelId), asc(modelDatedPrices.effectiveFrom)),
    ]);
    return models.map((model) => ({
      ...model,
      priceWindows: windows.filter((w) => w.modelId === model.modelId).map(toPriceWindow),
      priceTiers: tiers.filter((t) => t.modelId === model.modelId).map(toPriceTier),
      datedPrices: dated.filter((d) => d.modelId === model.modelId).map(toDatedPrice),
    }));
  }

  async listProviderConfigs() {
    return this.db.select().from(providerConfigs);
  }
}
