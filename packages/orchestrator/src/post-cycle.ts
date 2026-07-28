import type { WorkItem } from "./acl/planning-acl.js";
import type { BrainstormOrchestrationDeps } from "./acl/planning-acl.js";
import {
  checkNorthStarAlignment,
  checkBrainstormTriggers,
  executeBrainstorm,
  executeGatedBrainstorm,
  reconcileCoverage,
} from "./acl/planning-acl.js";
import type { CycleResult, CoreLoopDeps } from "./types.js";

/**
 * Runs the per-cycle coverage reconciliation (mig9-t2). No-op when no contract
 * repo is wired. Logs each open gap; enforcing mode also proposes coverage tasks
 * (inside reconcileCoverage) so an uncovered declared endpoint becomes plannable
 * work rather than a silent hole. Never throws into the cycle — a reconciliation
 * failure is logged and the cycle proceeds (the rollup HOLD is the safety net).
 */
export async function reconcileCoverageGaps(deps: CoreLoopDeps, runScope: string): Promise<void> {
  if (!deps.contractRepo) return;
  try {
    const gaps = await reconcileCoverage({
      workItemRepo: deps.workItemRepo,
      contractRepo: deps.contractRepo,
      withPlanningTransaction: deps.withPlanningTransaction,
      enforcing: deps.config.coverageEnforcing,
      runScope,
    });
    for (const gap of gaps) {
      console.log(
        `Coverage gap (${deps.config.coverageEnforcing ? "enforcing" : "observe-only"}): ` +
          `${gap.method} ${gap.path} [${gap.kind}] — ${gap.reason}`,
      );
    }
  } catch (e) {
    console.warn("Coverage reconciliation failed, continuing:", e);
  }
}

export async function runPostCycleChecks(
  deps: CoreLoopDeps,
  batch: WorkItem[],
  cycleResult: CycleResult,
  completedCount: number,
  runScope: string,
): Promise<void> {
  const brainstormDeps = buildBrainstormDeps(deps, runScope);
  let brainstormTriggered = false;

  if (completedCount > 0) {
    try {
      const completedIds = cycleResult.results
        .filter((r) => r.status === "completed")
        .map((r) => r.taskId);

      const driftDetected = await checkNorthStarAlignment(
        { workItemRepo: deps.workItemRepo, northstarChecker: deps.northstarChecker },
        batch,
        completedIds,
      );
      if (driftDetected) {
        console.log("NorthStar drift detected, requesting deep brainstorm");
        try {
          await executeGatedBrainstorm(brainstormDeps, {
            reason: "direction_drift",
            level: "deep",
            context: "NorthStar drift detected — completed work may not align with story/epic direction",
            relatedItemIds: completedIds,
          });
        } catch (e) {
          console.warn("Brainstorm execution failed after drift detection:", e);
        }
        brainstormTriggered = true;
      } else {
        console.log("NorthStar check passed, work is aligned");
      }
    } catch (e) {
      console.warn("NorthStar check failed, continuing:", e);
    }
  }

  if (!brainstormTriggered) {
    try {
      const trigger = await checkBrainstormTriggers(brainstormDeps, cycleResult);
      if (trigger) {
        console.log(`Brainstorm trigger fired: ${trigger.reason} (${trigger.level})`);
        try {
          await executeBrainstorm(brainstormDeps, trigger);
        } catch (e) {
          console.warn("Brainstorm execution failed:", e);
        }
      }
    } catch (e) {
      console.warn("Brainstorm trigger check failed:", e);
    }
  }

}

function buildBrainstormDeps(deps: CoreLoopDeps, runScope: string): BrainstormOrchestrationDeps {
  return {
    workItemRepo: deps.workItemRepo,
    brainstormEngine: deps.brainstormEngine,
    brainstormLogSink: deps.brainstormLogRepo,
    contextBriefSource: deps.contextBriefRepo,
    embedder: deps.embedder ?? null,
    brainstormCooldownThreshold: deps.config.brainstormCooldownThreshold,
    maxPendingWorkItems: deps.config.maxPendingWorkItems,
    maxBrainstormItems: deps.config.maxBrainstormItems,
    runScope,
  };
}
