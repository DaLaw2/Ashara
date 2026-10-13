import { sql } from "drizzle-orm";
import type { Database } from "../connection.js";
import { taskCostHistory, modelConfigs } from "../schema.js";

export interface CapabilityCostEstimate {
  avgInputTokens: number;
  avgOutputTokens: number;
  avgCostUsd: number;
  sampleCount: number;
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
}
