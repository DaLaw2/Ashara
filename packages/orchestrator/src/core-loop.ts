import type { RunState } from "@ashara/shared";
import type { IntakeOutcome } from "./acl/engagement-acl.js";
import type { RosterOutcome } from "./acl/organization-acl.js";
import type { FirstPlanOutcome, WorkItem } from "./acl/planning-acl.js";
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

/** A blocked project is logged at warn by the roster step itself, with the violations. */
function logRoster(outcome: RosterOutcome): void {
  if (outcome.kind === "recorded") {
    console.log(
      `[roster] project ${outcome.projectId}: roster revision ${outcome.revision} recorded, ` +
        `${outcome.roles.length} role(s): ${outcome.roles.join(", ")}`,
    );
  }
}

/** Failures are logged at warn by the planner itself, with their attempt count. */
function logFirstPlan(outcome: FirstPlanOutcome): void {
  if (outcome.kind === "planned") {
    console.log(
      `[first-plan] project ${outcome.projectId}: first plan written, ${outcome.epics} epic(s), ${outcome.tasks} task(s)`,
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

    // The client's stops first, even at the budget cap (no LLM call): a project
    // stopped here is not active, so no step below takes it in, plans it,
    // reports on it or dispatches its tasks. Nothing of this process is running
    // for it now: the previous cycle awaited every task it dispatched.
    for (const stop of await deps.clientStops.runPending()) {
      console.log(`[liaison-stop] stop ${stop.stopId}: project ${stop.projectId} ${stop.kind}`);
    }

    // When the budget is exhausted, skip dispatch: the runner idles
    // at the cap. Read live on every cycle: dispatch spends, so it must not run past
    // the cap.
    if (this.budget.isExhausted()) {
      this.reportBudgetExhaustion();
    } else {
      // Tenders first: a project's intake comes before any work on it. Skipped
      // with dispatch at the budget cap, since intake is an LLM call too.
      for (const outcome of await deps.liaisonIntake.runPending()) logIntake(outcome);

      // Then a roster for each project with vision v1 and none: first planning
      // requires one, since every planned task gets its owning role.
      for (const outcome of await deps.rosterDerivation.runPending()) logRoster(outcome);

      // Then a first plan for each project that has a vision, a roster and no work items,
      // and the Liaison's report on each recorded planning outcome. Both before
      // gating, so a plan written this cycle can be dispatched this cycle.
      // A project whose own record is bad is blocked inside each step, logged at
      // warn there, and skipped; any other failure throws out of the cycle.
      for (const outcome of await deps.firstPlanning.runPending()) logFirstPlan(outcome);
      for (const report of await deps.planReports.runPending()) {
        if (report.kind !== "project-blocked") {
          console.log(`[liaison-report] project ${report.projectId}: ${report.subject} report ${report.kind}`);
        }
      }

      const eligible = await PlanningService.gate(deps.workItemRepo, deps.projectRepo);
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
