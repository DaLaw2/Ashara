import { eq, sql } from "drizzle-orm";

import type { Database } from "../connection.js";
import { taskCostHistory, modelConfigs, providerConfigs } from "../schema.js";

export interface CapabilityCostEstimate {
  avgInputTokens: number;
  avgOutputTokens: number;
  avgCostUsd: number;
  sampleCount: number;
}

export interface VerifiedTaskCostEstimate {
  totalCostUsd: number;
  verifiedTaskCount: number;
  costPerVerifiedTaskUsd: number;
}

export class CostRepository {
  constructor(private readonly db: Database) {}

  async recordTaskCost(
    taskId: string,
    capability: string,
    inputTokens: number,
    outputTokens: number,
    costUsd: number,
    modelId: string | null,
    success: boolean,
    attempt: number,
  ) {
    await this.db.insert(taskCostHistory).values({
      taskId,
      capability,
      inputTokens,
      outputTokens,
      actualCostUsd: costUsd,
      modelId,
      success,
      attempt,
    });
  }

  /** Cost-per-verified-task (success = true), grouped by capability tier. */
  async loadCostPerVerifiedTask(): Promise<Record<string, VerifiedTaskCostEstimate>> {
    const rows = await this.db
      .select({
        capability: taskCostHistory.capability,
        totalCost: sql<number>`SUM(${taskCostHistory.actualCostUsd})::float`,
        verifiedCount: sql<number>`COUNT(*)::int`,
      })
      .from(taskCostHistory)
      .where(eq(taskCostHistory.success, true))
      .groupBy(taskCostHistory.capability);

    const result: Record<string, VerifiedTaskCostEstimate> = {};
    for (const row of rows) {
      const verifiedTaskCount = row.verifiedCount;
      const totalCostUsd = row.totalCost;
      result[row.capability] = {
        totalCostUsd,
        verifiedTaskCount,
        costPerVerifiedTaskUsd: verifiedTaskCount > 0 ? totalCostUsd / verifiedTaskCount : 0,
      };
    }
    return result;
  }

  async loadCostHistory(): Promise<Record<string, CapabilityCostEstimate>> {
    const rows = await this.db
      .select({
        capability: taskCostHistory.capability,
        avgInput: sql<number>`AVG(${taskCostHistory.inputTokens}::double precision)::float`,
        avgOutput: sql<number>`AVG(${taskCostHistory.outputTokens}::double precision)::float`,
        avgCost: sql<number>`AVG(${taskCostHistory.actualCostUsd})::float`,
        count: sql<number>`COUNT(*)::int`,
      })
      .from(taskCostHistory)
      .groupBy(taskCostHistory.capability);

    const history: Record<string, CapabilityCostEstimate> = {};
    for (const row of rows) {
      history[row.capability] = {
        avgInputTokens: row.avgInput,
        avgOutputTokens: row.avgOutput,
        avgCostUsd: row.avgCost,
        sampleCount: row.count,
      };
    }
    return history;
  }

  async loadModelPricing(): Promise<Record<string, { inputPer1m: number; outputPer1m: number }>> {
    const rows = await this.db
      .select({
        capability: modelConfigs.capability,
        avgInput: sql<number>`AVG(${modelConfigs.inputCostPer1m})::float`,
        avgOutput: sql<number>`AVG(${modelConfigs.outputCostPer1m})::float`,
      })
      .from(modelConfigs)
      .groupBy(modelConfigs.capability);

    const pricing: Record<string, { inputPer1m: number; outputPer1m: number }> = {};
    for (const row of rows) {
      pricing[row.capability] = {
        inputPer1m: row.avgInput,
        outputPer1m: row.avgOutput,
      };
    }
    return pricing;
  }

  async checkProviderBalances() {
    return this.db
      .select({
        name: providerConfigs.name,
        providerType: providerConfigs.providerType,
        baseUrl: providerConfigs.baseUrl,
      })
      .from(providerConfigs);
  }
}
