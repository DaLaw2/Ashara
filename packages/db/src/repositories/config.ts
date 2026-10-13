import { asc } from "drizzle-orm";
import type { Database } from "../connection.js";
import { modelConfigs, providerConfigs } from "../schema.js";

export class ConfigRepository {
  constructor(private readonly db: Database) {}

  /**
   * Ordered because this listing IS the routing tiebreak: the catalog order
   * reaches `findBestModel`, whose capability sort is stable, so equal-capability
   * models are resolved in the order they arrive here. An unordered select left
   * that choice to Postgres. Cheapest first, then by id so ties are still total.
   */
  async listModelConfigs() {
    return this.db
      .select()
      .from(modelConfigs)
      .orderBy(
        asc(modelConfigs.inputCostPer1m),
        asc(modelConfigs.outputCostPer1m),
        asc(modelConfigs.modelId),
      );
  }

  async listProviderConfigs() {
    return this.db.select().from(providerConfigs);
  }
}
