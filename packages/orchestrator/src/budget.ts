import type { CostRepository } from "@ashara/db";
import type { WorkItem } from "@ashara/planning-domain";
import type { CoreLoopConfig, TaskCostInfo } from "./types.js";
import { CostEstimator } from "./cost-estimator.js";

export type BudgetStatus = "ok" | "low" | "exhausted";

export class BudgetTracker {
  private readonly config: CoreLoopConfig;
  private readonly costEstimator = new CostEstimator();
  private cumulativeCostUsd = 0;
  private completedTaskCount = 0;
  private tasksSinceBudgetCheck = 0;

  constructor(config: CoreLoopConfig) {
    this.config = config;
  }

  get totalCostUsd(): number {
    return this.cumulativeCostUsd;
  }

  async ensureLoaded(costRepo: CostRepository): Promise<void> {
    if (!this.costEstimator.isLoaded()) {
      await this.costEstimator.load(costRepo);
    }
  }

  isExhausted(): boolean {
    return this.cumulativeCostUsd >= this.config.budgetLimitUsd;
  }

  estimateTaskCost(capability: string): number {
    return this.costEstimator.estimateTaskCost(capability);
  }

  checkpoint(): BudgetStatus {
    this.tasksSinceBudgetCheck += 1;
    if (this.tasksSinceBudgetCheck < this.budgetCheckInterval()) {
      return "ok";
    }
    this.tasksSinceBudgetCheck = 0;

    if (this.cumulativeCostUsd >= this.config.budgetLimitUsd) {
      console.warn(`Budget limit reached: $${this.cumulativeCostUsd.toFixed(2)} / $${this.config.budgetLimitUsd}`);
      return "exhausted";
    }

    const remaining = this.config.budgetLimitUsd - this.cumulativeCostUsd;
    console.log(
      `Budget checkpoint: $${this.cumulativeCostUsd.toFixed(2)} spent, $${remaining.toFixed(2)} remaining, ` +
      `${this.completedTaskCount} tasks completed`,
    );

    if (this.config.budgetLimitUsd > 0) {
      const remainingRatio = remaining / this.config.budgetLimitUsd;
      if (remainingRatio < 0.3) {
        return "low";
      }
    }
    return "ok";
  }

  async checkProviderBalances(costRepo: CostRepository): Promise<void> {
    const remaining = this.config.budgetLimitUsd - this.cumulativeCostUsd;
    const balances = await CostEstimator.checkProviderBalances(costRepo);
    for (const bal of balances) {
      if (bal.balanceUsd !== null && bal.balanceUsd < remaining) {
        console.warn(
          `Provider ${bal.providerName} balance ($${bal.balanceUsd.toFixed(2)}) ` +
          `is lower than remaining budget ($${remaining.toFixed(2)})`,
        );
      }
    }
  }

  accumulateCost(cost: number, completed: boolean): void {
    if (completed) this.completedTaskCount += 1;
    if (cost > 0) {
      this.cumulativeCostUsd += cost;
      console.log(
        `Task cost: $${cost.toFixed(4)}, cumulative: $${this.cumulativeCostUsd.toFixed(4)}, ` +
        `completed: ${this.completedTaskCount}`,
      );
    }
  }

  async recordTaskCost(
    costRepo: CostRepository,
    taskId: string,
    capability: string,
    costInfo: TaskCostInfo,
    success: boolean,
  ): Promise<void> {
    if (costInfo.costUsd <= 0) return;

    try {
      await costRepo.recordTaskCost(
        taskId,
        capability,
        costInfo.inputTokens,
        costInfo.outputTokens,
        costInfo.costUsd,
        costInfo.modelId,
        success,
        costInfo.attempt,
      );
    } catch (e) {
      console.warn(`[${taskId}] failed to record task cost history:`, e);
    }
    this.costEstimator.updateHistory(
      capability,
      costInfo.inputTokens,
      costInfo.outputTokens,
      costInfo.costUsd,
    );
  }

  private budgetCheckInterval(): number {
    const { budgetLimitUsd } = this.config;
    if (budgetLimitUsd <= 0) return Number.MAX_SAFE_INTEGER;
    const remaining = budgetLimitUsd - this.cumulativeCostUsd;
    if (remaining <= 0) return 1;
    const estNext = this.costEstimator.estimateTaskCost("Strong");
    if (estNext <= 0) return 10;
    const tasksTillExhausted = remaining / estNext;
    return Math.max(1, Math.min(10, Math.floor(tasksTillExhausted / 3)));
  }
}

export function extractCapability(task: WorkItem): string {
  const spec = task.taskSpec as Record<string, unknown> | undefined;
  return typeof spec?.capability === "string" ? spec.capability : "Strong";
}
