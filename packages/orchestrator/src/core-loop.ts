import type { RunState } from "@ashara/shared";
import type { IntakeOutcome } from "./acl/engagement-acl.js";
import type { WorkItem } from "./acl/planning-acl.js";
import { PlanningService, DependencyGraph } from "./acl/planning-acl.js";
import type { CoreLoopDeps, CycleResult, TaskResult } from "./types.js";
import { BudgetTracker, extractCapability } from "./budget.js";
import { processTask, handleProcessingError } from "./execution.js";
import { openRun, persistRun } from "./run-state.js";

/** Failures are logged at warn by the Liaison itself, with their attempt count. */
function logIntake(outcome: IntakeOutcome): void {
  if (outcome.kind === "recorded") {
    console.log(
      `[liaison-intake] tender ${outcome.tenderId}: vision v1 written for project ${outcome.projectId}, ` +
        `${outcome.questions} question(s) posted`,
    );
  }
}

export class CoreLoop {
  private readonly deps: CoreLoopDeps;
  private readonly budget: BudgetTracker;
  private runState: RunState | null = null;
  private budgetExhaustionReported = false;

  constructor(deps: CoreLoopDeps) {
    this.deps = deps;
    this.budget = new BudgetTracker(deps.config);
  }

  async runCycle(): Promise<CycleResult> {
    const { deps } = this;

    await this.budget.ensureLoaded(deps.costRepo);
    await this.ensureRunOpen();

    let batch: WorkItem[] = [];
    const results: TaskResult[] = [];

    // When the budget is exhausted, skip dispatch: the runner idles
    // at the cap. Read live on every cycle: dispatch spends, so it must not run past
    // the cap.
    if (this.budget.isExhausted()) {
      this.reportBudgetExhaustion();
    } else {
      // Tenders first: a project's intake comes before any work on it. Skipped
      // with dispatch at the budget cap, since intake is an LLM call too.
      for (const outcome of await deps.liaisonIntake.runPending()) logIntake(outcome);

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
