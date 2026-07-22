import type { WorkItem } from "@ashara/planning";
import { PlanningService } from "@ashara/planning";
import type { BrainstormOrchestrationDeps, RouteInput } from "@ashara/planning";
import {
  checkNorthStarAlignment,
  checkBrainstormTriggers,
  executeBrainstorm,
  executeGatedBrainstorm,
  reconcileCoverage,
} from "@ashara/planning";

import type { CycleResult, CoreLoopDeps } from "./types.js";

/**
 * Runs the per-cycle coverage reconciliation (mig9-t2). No-op when no contract
 * repo is wired. Logs each open gap; enforcing mode also proposes coverage tasks
 * (inside reconcileCoverage) so an uncovered declared endpoint becomes plannable
 * work rather than a silent hole. Never throws into the cycle — a reconciliation
 * failure is logged and the cycle proceeds (the rollup HOLD is the safety net).
 */
export async function reconcileCoverageGaps(deps: CoreLoopDeps): Promise<void> {
  if (!deps.contractRepo) return;
  try {
    const gaps = await reconcileCoverage({
      workItemRepo: deps.workItemRepo,
      contractRepo: deps.contractRepo,
      withPlanningTransaction: deps.withPlanningTransaction,
      enforcing: deps.config.coverageEnforcing,
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
): Promise<void> {
  const brainstormDeps = buildBrainstormDeps(deps);
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

  if (deps.router && completedCount > 0) {
    const completedIds = cycleResult.results
      .filter((r) => r.status === "completed")
      .map((r) => r.taskId);
    await runRouterAnalysis(deps, batch, completedIds);
  }
}

async function runRouterAnalysis(
  deps: CoreLoopDeps,
  batch: WorkItem[],
  completedIds: string[],
): Promise<void> {
  if (!deps.router || completedIds.length === 0) return;

  const firstCompleted = batch.find((t) => completedIds.includes(t.id));
  if (!firstCompleted?.parentId) return;

  const parent = await PlanningService.findWorkItem(deps.workItemRepo, firstCompleted.parentId);
  if (!parent) return;

  let story: WorkItem;
  let epic: WorkItem | null = null;

  if (parent.level === "Story") {
    story = parent;
    if (parent.parentId) {
      epic = await PlanningService.findWorkItem(deps.workItemRepo, parent.parentId);
    }
  } else if (parent.level === "Feature" && parent.parentId) {
    const parentStory = await PlanningService.findWorkItem(deps.workItemRepo, parent.parentId);
    if (!parentStory) return;
    story = parentStory;
    if (parentStory.parentId) {
      epic = await PlanningService.findWorkItem(deps.workItemRepo, parentStory.parentId);
    }
  } else {
    return;
  }

  const storyCriteria = Array.isArray(story.successCriteria)
    ? (story.successCriteria as string[])
    : [];
  const storyChildren = await deps.workItemRepo.findChildren(story.id);
  const completedChildCount = storyChildren.filter((c) => c.status === "Completed").length;

  let epicStoriesCompleted = 0;
  let epicStoriesTotal = 0;
  if (epic) {
    const epicChildren = await deps.workItemRepo.findChildren(epic.id);
    epicStoriesTotal = epicChildren.length;
    epicStoriesCompleted = epicChildren.filter((c) => c.status === "Completed").length;
  }

  const pending = await PlanningService.findByStatus(deps.workItemRepo, "Pending");
  const tasksSinceBrainstorm = await deps.brainstormLogRepo.countTasksSinceLast();

  const blockedTaskIds = batch
    .filter((t) => !completedIds.includes(t.id) && t.blockedReason !== undefined)
    .map((t) => t.id);

  const routeInput: RouteInput = {
    completedTaskIds: completedIds,
    storyId: story.id,
    storyTitle: story.title,
    storyNorthStar: story.northStar ?? "",
    storyCriteria,
    storyCriteriaMetCount: completedChildCount,
    epicId: epic?.id ?? "",
    epicTitle: epic?.title ?? "",
    epicNorthStar: epic?.northStar ?? "",
    epicStoriesCompleted,
    epicStoriesTotal,
    tasksSinceBrainstorm,
    hasReadyTasks: pending.length > 0,
    blockedTaskIds,
  };

  const completedSummary = batch
    .filter((t) => completedIds.includes(t.id))
    .map((t) => (t.description ? `${t.title}: ${t.description}` : t.title))
    .join(". ");

  try {
    const decisions = await deps.router.route(routeInput, completedSummary);
    for (const decision of decisions) {
      switch (decision.action) {
        case "flag_drift":
          console.log(`[Router] drift flagged: ${decision.description}`);
          break;
        case "cascade_close":
          console.log(`[Router] cascade close suggested: ${decision.closedItems.join(", ")}`);
          break;
        case "trigger_brainstorm":
          console.log(`[Router] brainstorm trigger (handled separately): ${decision.trigger.reason}`);
          break;
        // The mark_blocked failure path is no longer logged-and-dropped here:
        // permanent task failures are recovered by the FailureRouter (Phase 6),
        // so a stalled item routes to replan/abandon instead of a dead log line.
        case "mark_blocked":
          break;
        case "continue":
          break;
      }
    }
  } catch (e) {
    console.warn("[Router] post-completion analysis failed:", e);
  }
}

function buildBrainstormDeps(deps: CoreLoopDeps): BrainstormOrchestrationDeps {
  return {
    workItemRepo: deps.workItemRepo,
    brainstormEngine: deps.brainstormEngine,
    brainstormLogSink: deps.brainstormLogRepo,
    contextBriefSource: deps.contextBriefRepo,
    embedder: deps.embedder ?? null,
    brainstormCooldownThreshold: deps.config.brainstormCooldownThreshold,
    maxPendingWorkItems: deps.config.maxPendingWorkItems,
    maxBrainstormItems: deps.config.maxBrainstormItems,
  };
}
