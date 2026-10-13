import type { RunState } from "@ashara/shared";
import type { WorkItem } from "./acl/planning-acl.js";
import { PlanningService, DependencyGraph } from "./acl/planning-acl.js";
import type { CoreLoopDeps, CycleResult, TaskResult } from "./types.js";
import { BudgetTracker, extractCapability } from "./budget.js";
import { processTask, handleProcessingError } from "./execution.js";
import { reconcileCoverageGaps } from "./post-cycle.js";
import { openRun, persistRun } from "./run-state.js";

export class CoreLoop {
  private readonly deps: CoreLoopDeps;
  private readonly budget: BudgetTracker;
  private runState: RunState | null = null;
  private budgetExhaustionReported = false;

  constructor(deps: CoreLoopDeps) {
    this.deps = deps;
    this.budget = new BudgetTracker(deps.config);
  }

  /**
   * The runId of the currently open run. Derived from `runState`, which is
   * set by `ensureRunOpen` and is never null after that. A throw here means
   * a work-item creation path ran before `ensureRunOpen` — that is a bug,
   * not a fallback case. The value is passed explicitly to every function
   * that stamps it onto a work item, so `""` is unrepresentable: there is
   * no field to seed it into.
   */
  private get currentRunScope(): string {
    if (!this.runState) {
      throw new Error(
        "currentRunScope accessed before ensureRunOpen — " +
          "a work item cannot be created until the run is open",
      );
    }
    return this.runState.runId;
  }

  async runCycle(): Promise<CycleResult> {
    const { deps } = this;

    await this.budget.ensureLoaded(deps.costRepo);
    await this.ensureRunOpen();
    const runScope = this.currentRunScope;

    let batch: WorkItem[] = [];
    const results: TaskResult[] = [];

    // When the budget is exhausted, skip reconciliation and dispatch: the runner idles
    // at the cap. Read live on every cycle: dispatch spends, so it must not run past
    // the cap.
    if (this.budget.isExhausted()) {
      this.reportBudgetExhaustion();
    } else {
      // Plan reconciliation (mig9-t2, ADR-032 §2) runs BEFORE the gate, so any
      // proposed coverage task is eligible for dispatch this same cycle. ENFORCING
      // proposes tasks for uncovered declared endpoints; observe-only just logs.
      await reconcileCoverageGaps(deps, runScope);

      const eligible = await PlanningService.gate(deps.workItemRepo);
      if (eligible.length > 0) {
        const graph = await DependencyGraph.load(deps.workItemRepo);
        const unlockWeights = graph.computeUnlockWeights();
        batch = PlanningService.select(eligible, deps.config.maxBatchSize, unlockWeights);

        // Pre-check budget for entire batch before dispatching concurrently.
        // Each task gets its own worktree (workspace.ts creates per-task branches),
        // so concurrent execution is safe at the process boundary.
        const budgetedTasks: Array<{ task: WorkItem; capability: string }> = [];
        for (const task of batch) {
          if (this.budget.isExhausted()) {
            console.warn(`[${task.id}] budget limit reached, skipping remaining`);
            break;
          }
          const capability = extractCapability(task);
          budgetedTasks.push({ task, capability });
        }

        // Dispatch all concurrently
        const settled = await Promise.allSettled(
          budgetedTasks.map(({ task }) => processTask(deps, task)),
        );

        // Accumulate costs sequentially (budget is in-memory, not concurrent-safe)
        for (let i = 0; i < settled.length; i++) {
          const s = settled[i];
          const { task, capability } = budgetedTasks[i];
          if (s.status === "fulfilled") {
            const { result, costInfo } = s.value;
            this.budget.accumulateCost(costInfo, capability, result.status === "completed");
            await this.budget.recordTaskCost(deps.costRepo, task.id, capability, costInfo, result.status === "completed");
            results.push(result);
          } else {
            results.push(await handleProcessingError(deps, task, s.reason));
          }
        }
        await this.persistRunCounters();
      }

      const completedCount = results.filter((r) => r.status === "completed").length;
      const failedCount = results.filter((r) => r.status === "failed").length;

      if (batch.length > 0) {
        deps.eventLogger?.emit({
          event: "cycle_complete",
          tasksProcessed: batch.length,
          completed: completedCount,
          failed: failedCount,
          cumulativeCost: this.budget.totalCostUsd,
        });
      }
    }

    await this.persistRunCounters();

    return { tasksProcessed: batch.length, results };
  }

  /**
   * Warns once, on the first cycle that finds the cap spent. The runner keeps
   * cycling at the cap, so a per-cycle warn would repeat every idle interval.
   */
  private reportBudgetExhaustion(): void {
    if (this.budgetExhaustionReported) return;
    this.budgetExhaustionReported = true;
    console.warn(
      `[budget] limit $${this.deps.config.budgetLimitUsd.toFixed(2)} reached at ` +
        `$${this.budget.totalCostUsd.toFixed(4)} spent; dispatch is paused. Raise ` +
        `ASHARA_BUDGET_LIMIT_USD and restart to resume.`,
    );
  }

  /**
   * Adopts the durable run record on the first cycle: budget spend resumes where
   * the previous process left it (Discipline B). Runs once per process — after that the in-memory counters are
   * authoritative and are written back by persistRunCounters.
   *
   * Throws through on a store failure: a cycle that cannot read the run's spend
   * cannot enforce the cap, and the runner's consecutive-error backoff is the
   * right response to that, not a dispatch against an assumed zero.
   */
  private async ensureRunOpen(): Promise<void> {
    if (this.runState !== null) return;
    const state = await openRun(this.deps.runStateStore);
    this.runState = state;
    this.budget.adoptSpend(state.spendUsd);
  }

  private async persistRunCounters(): Promise<void> {
    if (this.runState === null) return;
    this.runState = await persistRun(this.deps.runStateStore, this.runState, {
      spendUsd: this.budget.totalCostUsd,
    });
  }
}
