import type { CostRepository } from "@ashara/db";
import type { WorkItem } from "./acl/planning-acl.js";
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

  /**
   * Seeds the counter from the durable run record at startup. A run whose
   * process was killed mid-flight resumes its cap here; a fresh run adopts 0.
   * Without this the counter started at 0 on every process start, so a crash
   * loop handed out the same budget once per restart.
   */
  adoptSpend(spendUsd: number): void {
    this.cumulativeCostUsd = spendUsd;
    if (spendUsd > 0) {
      console.warn(
        `Budget resumed from the durable run record: $${spendUsd.toFixed(4)} of ` +
          `$${this.config.budgetLimitUsd} already spent by this run`,
      );
    }
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

  /**
   * Charges one dispatch against the run's cap. An UNKNOWN cost (`costUsd ===
   * null` — the agent ran and its output never carried a total) is charged, not
   * skipped: the whole job of this counter is to stop a runaway, and a runaway
   * is exactly the shape that loses its own cost report. The charge is the best
   * available upper-bound estimate for the capability; when even that is zero we
   * have no bound at all, so the run is charged out to the cap and stops rather
   * than continuing to spend against a number known to be wrong.
   */
  accumulateCost(costInfo: TaskCostInfo, capability: string, completed: boolean): void {
    if (completed) this.completedTaskCount += 1;

    const cost = costInfo.costUsd ?? this.unknownCostCharge(capability);
    if (cost > 0) {
      this.cumulativeCostUsd += cost;
      console.log(
        `Task cost: $${cost.toFixed(4)}, cumulative: $${this.cumulativeCostUsd.toFixed(4)}, ` +
        `completed: ${this.completedTaskCount}`,
      );
    }
  }

  private unknownCostCharge(capability: string): number {
    const estimate = this.costEstimator.estimateTaskCost(capability);
    if (estimate > 0) {
      console.warn(
        `Agent run reported no cost (capability=${capability}); charging the ${capability} ` +
          `estimate $${estimate.toFixed(4)} against the run budget rather than $0 — ` +
          `an unmeasured run is not a free run`,
      );
      return estimate;
    }
    const remaining = Math.max(0, this.config.budgetLimitUsd - this.cumulativeCostUsd);
    console.warn(
      `Agent run reported no cost (capability=${capability}) and no estimate exists to bound it; ` +
        `charging the full remaining $${remaining.toFixed(4)} so the run stops instead of ` +
        `spending against an unknown`,
    );
    return remaining;
  }

  async recordTaskCost(
    costRepo: CostRepository,
    taskId: string,
    capability: string,
    costInfo: TaskCostInfo,
    success: boolean,
  ): Promise<void> {
    // An unknown or zero cost is never written to task_cost_history: that table
    // is the estimator's training data, and seeding it with a charge we inferred
    // would feed the estimate back into itself.
    const cost = costInfo.costUsd;
    if (cost === null || cost <= 0) return;

    try {
      await costRepo.recordTaskCost(
        taskId,
        capability,
        costInfo.inputTokens,
        costInfo.outputTokens,
        cost,
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
      cost,
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
  const spec = task.taskSpec;
  return typeof spec?.capability === "string" ? spec.capability : "Strong";
}
