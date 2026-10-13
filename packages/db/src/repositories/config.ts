import { asc, eq, sql } from "drizzle-orm";
import type { Database } from "../connection.js";
import { modelConfigs, providerConfigs, systemSettings } from "../schema.js";

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

  async getModelConfig(modelId: string) {
    const rows = await this.db
      .select()
      .from(modelConfigs)
      .where(eq(modelConfigs.modelId, modelId));
    return rows[0] ?? null;
  }

  async upsertModelConfig(model: {
    modelId: string;
    providerName: string;
    apiModelId?: string | null;
    capability: string;
    formatGroup?: string;
    inputCostPer1m: number;
    outputCostPer1m: number;
    maxContextTokens: number;
    supportsCaching?: boolean;
  }) {
    const rows = await this.db
      .insert(modelConfigs)
      .values({
        modelId: model.modelId,
        providerName: model.providerName,
        apiModelId: model.apiModelId ?? null,
        capability: model.capability,
        formatGroup: model.formatGroup ?? "native-fc",
        inputCostPer1m: model.inputCostPer1m,
        outputCostPer1m: model.outputCostPer1m,
        maxContextTokens: model.maxContextTokens,
        supportsCaching: model.supportsCaching ?? false,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: modelConfigs.modelId,
        set: {
          providerName: sql`EXCLUDED.provider_name`,
          apiModelId: sql`EXCLUDED.api_model_id`,
          capability: sql`EXCLUDED.capability`,
          formatGroup: sql`EXCLUDED.format_group`,
          inputCostPer1m: sql`EXCLUDED.input_cost_per_1m`,
          outputCostPer1m: sql`EXCLUDED.output_cost_per_1m`,
          maxContextTokens: sql`EXCLUDED.max_context_tokens`,
          supportsCaching: sql`EXCLUDED.supports_caching`,
          updatedAt: sql`EXCLUDED.updated_at`,
        },
      })
      .returning();
    return rows[0]!;
  }

  async deleteModelConfig(modelId: string): Promise<boolean> {
    const rows = await this.db
      .delete(modelConfigs)
      .where(eq(modelConfigs.modelId, modelId))
      .returning({ modelId: modelConfigs.modelId });
    return rows.length > 0;
  }

  async listProviderConfigs() {
    return this.db.select().from(providerConfigs);
  }

  async getSetting(key: string): Promise<string | null> {
    const rows = await this.db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.key, key));
    return rows[0]?.value ?? null;
  }
}
