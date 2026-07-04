import type { WorkItem } from "@ashara/planning-domain";
import { PlanningService, DependencyGraph } from "@ashara/planning-domain";
import { decomposeLeafStories } from "@ashara/planning";
import { detectTechStack, readManifestContext } from "@ashara/development";

import type { CoreLoopDeps, CycleResult, TaskResult } from "./types.js";
import { BudgetTracker, extractCapability } from "./budget.js";
import { processTask, handleProcessingError } from "./execution.js";
import { evaluateRunTermination } from "./termination-snapshot.js";
import { runPostCycleChecks, reconcileCoverageGaps } from "./post-cycle.js";

export class CoreLoop {
  private readonly deps: CoreLoopDeps;
  private readonly budget: BudgetTracker;

  constructor(deps: CoreLoopDeps) {
    this.deps = deps;
    this.budget = new BudgetTracker(deps.config);
  }

  async runCycle(): Promise<CycleResult> {
    const { deps } = this;

    const unprocessed = await deps.eventStore.pollUnprocessed();
    for (const envelope of unprocessed) {
      await deps.eventStore.markProcessed(envelope.eventId);
    }

    await this.budget.ensureLoaded(deps.costRepo);

    const budgetStatus = this.budget.checkpoint();
    if (budgetStatus === "low") {
      await this.budget.checkProviderBalances(deps.costRepo);
    }

    let batch: WorkItem[] = [];
    const results: TaskResult[] = [];

    // When the periodic budget checkpoint reports exhaustion, skip decomposition and
    // dispatch for this cycle (preserving the pre-Phase-7 early-return semantics) but
    // DO fall through to the termination evaluation below, so the run stops with the
    // `economy` reason instead of idling forever — the Run-8 failure mode. When budget
    // remains, run the full decompose → gate → dispatch → post-cycle flow so the
    // termination snapshot is taken at a quiescent point. The economy verdict itself is
    // driven by the live Budget.isExhausted() read in evaluateTermination, not by this
    // periodic checkpoint, so it fires on the very cycle the budget is truly spent.
    if (budgetStatus !== "exhausted") {
      const decomposed = await decomposeLeafStories({
        workItemRepo: deps.workItemRepo,
        decompositionEngine: deps.decompositionEngine,
        repoPath: deps.config.repoPath,
        detectTechStack,
        readManifestContext,
        withPlanningTransaction: deps.withPlanningTransaction,
        specDerivationLlm: deps.specDerivationLlm,
      });
      if (decomposed > 0) {
        console.log(`Decomposed ${decomposed} leaf stories into tasks`);
      }

      // Plan reconciliation (mig9-t2, ADR-032 §2): AFTER decomposition (so t1's
      // spec-derived endpoints are in the contract) and BEFORE the gate, so any
      // proposed coverage task is eligible for dispatch this same cycle. ENFORCING
      // proposes tasks for uncovered declared endpoints; observe-only just logs.
      await reconcileCoverageGaps(deps);

      const eligible = await PlanningService.gate(deps.workItemRepo);
      if (eligible.length > 0) {
        const graph = await DependencyGraph.load(deps.workItemRepo);
        const unlockWeights = graph.computeUnlockWeights();
        batch = PlanningService.select(eligible, deps.config.maxBatchSize, unlockWeights);

        for (const task of batch) {
          if (this.budget.isExhausted()) {
            console.warn(`[${task.id}] budget limit reached mid-batch, skipping remaining`);
            break;
          }

          const capability = extractCapability(task);
          const estCost = this.budget.estimateTaskCost(capability);
          console.log(`[${task.id}] pre-dispatch estimate: $${estCost.toFixed(4)} (${capability})`);

          try {
            const { result, costInfo } = await processTask(deps, task);
            this.budget.accumulateCost(costInfo.costUsd, result.status === "completed");
            await this.budget.recordTaskCost(deps.costRepo, task.id, capability, costInfo, result.status === "completed");
            results.push(result);
          } catch (e) {
            results.push(await handleProcessingError(deps, task, e));
          }
        }
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

      // Post-cycle checks run even on an IDLE cycle (empty batch). Run 8's bug was
      // returning here before the planner ran, so the runner idled forever. Brainstorm
      // and NorthStar triggers can still create work on their own cooldown logic, and
      // the quiescence contract (mig7-t1) requires they get their chance BEFORE the
      // termination snapshot is taken below — otherwise a liveness verdict could race
      // items about to appear this cycle.
      await runPostCycleChecks(deps, batch, { tasksProcessed: batch.length, results }, completedCount);
    }

    // QUIESCENT POINT (Option A quiescence, mig7-t1): decomposition, dispatch, and the
    // post-cycle brainstorm/northstar mutations have all settled this cycle. Assemble a
    // FRESH snapshot and evaluate termination against it, so the snapshot already
    // reflects any work those steps created — the liveness verdict cannot race work
    // about to appear. Completeness (all-terminal) and economy (budget) are
    // monotone-enough not to need this care; liveness is the one that does.
    //
    // TRIPWIRE: this liveness-race closure DEPENDS on brainstorm's cooldown being
    // COMPLETION-counted (planning/brainstorm-orchestrator.ts checkBrainstormGate gates
    // on tasks-since-last, not elapsed time). Because no task completes on a frozen
    // plan, the counter is static, so brainstorm either fires THIS cycle (its items land
    // in the snapshot below) or is deterministically dormant — a frozen plan cannot
    // sprout work on a later idle cycle that this snapshot fails to see. If that gate
    // ever becomes WALL-CLOCK-based, that guarantee breaks and the race reopens; re-add a
    // next-cycle re-verification before acting on a liveness stop.
    const termination = await evaluateRunTermination(deps, this.budget.isExhausted());

    return { tasksProcessed: batch.length, results, termination };
  }
}
