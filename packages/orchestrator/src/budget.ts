import type { CostRepository } from "@ashara/db";
import type { WorkItem } from "./acl/planning-acl.js";
import type { CoreLoopConfig, TaskCostInfo } from "./types.js";
import { CostEstimator } from "./cost-estimator.js";

export class BudgetTracker {
  private readonly config: CoreLoopConfig;
  private readonly costEstimator = new CostEstimator();
  private cumulativeCostUsd = 0;
  private completedTaskCount = 0;

  constructor(config: CoreLoopConfig) {
    this.config = config;
  }

  get totalCostUsd(): number {
    return this.cumulativeCostUsd;
  }

  /**
   * Seeds the counter from the durable run record at startup. Nothing closes that
   * record, so every restart resumes the recorded spend and only a database with
   * no record adopts 0 — the cap is a lifetime total per database (ADR-073
   * addendum 3).
   * Without this the counter started at 0 on every process start, so a crash
   * loop handed out the same budget once per restart.
   */
  adoptSpend(spendUsd: number): void {
    this.cumulativeCostUsd = spendUsd;
    if (spendUsd > 0) {
      console.warn(
        `Budget resumed from the durable run record: $${spendUsd.toFixed(4)} of ` +
          `$${this.config.budgetLimitUsd} already spent against this database's cap`,
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

  /**
   * Charges one dispatch against the cap. An UNKNOWN cost (`costUsd ===
   * null` — the agent ran and its output never carried a total) is charged, not
   * skipped: the whole job of this counter is to stop a runaway, and a runaway
   * is exactly the shape that loses its own cost report. The charge is the best
   * available upper-bound estimate for the capability; when even that is zero we
   * have no bound at all, so the counter is charged out to the cap and dispatch
   * pauses rather than continuing to spend against a number known to be wrong.
   */
  accumulateCost(costInfo: TaskCostInfo, capability: string, completed: boolean): void {
    if (completed) this.completedTaskCount += 1;

    // EVIDENCE default: the caller reports the cost it observed; null means
    // it could not observe one, not "pick a price for me." Fail-closed via
    // unknownCostCharge — overestimates or exhausts the cap.
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
        `charging the full remaining $${remaining.toFixed(4)} so dispatch pauses instead of ` +
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
}

export function extractCapability(task: WorkItem): string {
  const spec = task.taskSpec;
  return typeof spec?.capability === "string" ? spec.capability : "Strong";
}
