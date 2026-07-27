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
    strictMode?: boolean;
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
        strictMode: model.strictMode ?? false,
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
          strictMode: sql`EXCLUDED.strict_mode`,
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

  async getSettings() {
    return this.db.select().from(systemSettings);
  }

  async updateSetting(key: string, value: string) {
    await this.db
      .insert(systemSettings)
      .values({ key, value, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: { value, updatedAt: new Date() },
      });
  }

  async seedProviders(
    providers: Array<{
      name: string;
      providerType: string;
      apiKey?: string | null;
      baseUrl?: string | null;
    }>,
  ) {
    for (const provider of providers) {
      await this.db
        .insert(providerConfigs)
        .values({
          name: provider.name,
          providerType: provider.providerType,
          apiKey: provider.apiKey ?? null,
          baseUrl: provider.baseUrl ?? null,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: providerConfigs.name,
          set: {
            providerType: sql`EXCLUDED.provider_type`,
            apiKey: sql`EXCLUDED.api_key`,
            baseUrl: sql`EXCLUDED.base_url`,
            updatedAt: sql`EXCLUDED.updated_at`,
          },
        });
    }
  }

  async seedModelsFromToml(
    models: Array<{
      modelId: string;
      providerName: string;
      apiModelId?: string;
      capability: string;
      formatGroup?: string;
      strictMode?: boolean;
      inputCostPer1m?: number;
      outputCostPer1m?: number;
      maxContextTokens?: number;
      supportsCaching?: boolean;
    }>,
  ) {
    for (const model of models) {
      await this.db
        .insert(modelConfigs)
        .values({
          modelId: model.modelId,
          providerName: model.providerName,
          apiModelId: model.apiModelId ?? null,
          capability: model.capability,
          formatGroup: model.formatGroup ?? "native-fc",
          strictMode: model.strictMode ?? false,
          inputCostPer1m: model.inputCostPer1m ?? 0,
          outputCostPer1m: model.outputCostPer1m ?? 0,
          maxContextTokens: model.maxContextTokens ?? 128000,
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
            strictMode: sql`EXCLUDED.strict_mode`,
            inputCostPer1m: sql`EXCLUDED.input_cost_per_1m`,
            outputCostPer1m: sql`EXCLUDED.output_cost_per_1m`,
            maxContextTokens: sql`EXCLUDED.max_context_tokens`,
            supportsCaching: sql`EXCLUDED.supports_caching`,
            updatedAt: sql`EXCLUDED.updated_at`,
          },
        });
    }
  }
}
