import type { BrainstormTrigger, TriggerContext } from "./brainstorm-types.js";
import type { BrainstormEngine } from "./brainstorm.js";
import type { NorthStarChecker } from "./northstar.js";
import type { RouteDecision, RouteInput } from "./route-types.js";

export class Router {
  private readonly northStarChecker: NorthStarChecker;
  private readonly brainstormEngine: BrainstormEngine;

  constructor(northStarChecker: NorthStarChecker, brainstormEngine: BrainstormEngine) {
    this.northStarChecker = northStarChecker;
    this.brainstormEngine = brainstormEngine;
  }

  async route(input: RouteInput, completedWorkSummary: string): Promise<RouteDecision[]> {
    const decisions: RouteDecision[] = [];

    // 1. Run North Star alignment check
    const alignment = await this.northStarChecker.check({
      completedWork: completedWorkSummary,
      storyNorthStar: input.storyNorthStar,
      epicNorthStar: input.epicNorthStar,
      storyCriteria: input.storyCriteria,
    });

    let driftDetected = false;

    // 2. If drift detected, flag it and trigger deep brainstorm
    if (!alignment.aligned) {
      driftDetected = true;
      decisions.push({ action: "flag_drift", description: alignment.driftDescription });
      decisions.push({
        action: "trigger_brainstorm",
        trigger: {
          reason: "direction_drift",
          level: "deep",
          context: `North Star drift: ${alignment.driftDescription}`,
          relatedItemIds: [input.storyId],
        },
      });
    }

    // 3. Check if story is complete (all criteria met)
    const storyComplete = input.storyCriteriaMetCount >= input.storyCriteria.length && input.storyCriteria.length > 0;

    if (storyComplete) {
      decisions.push({ action: "cascade_close", closedItems: [input.storyId] });

      // Check if epic is complete (all stories done, counting the newly completed one)
      const epicComplete = input.epicStoriesCompleted + 1 >= input.epicStoriesTotal && input.epicStoriesTotal > 0;

      if (epicComplete) {
        decisions.push({ action: "cascade_close", closedItems: [input.epicId] });
      }
    }

    // 4. Check brainstorm triggers (only if drift didn't already trigger one)
    if (!driftDetected) {
      const triggerContext: TriggerContext = {
        tasksSinceBrainstorm: input.tasksSinceBrainstorm,
        hasReadyTasks: input.hasReadyTasks,
        blockedTaskIds: input.blockedTaskIds,
        driftDetected: false,
        recentCompletions: this.buildRecentCompletions(input, storyComplete),
      };

      const trigger: BrainstormTrigger | null = this.brainstormEngine.evaluateTrigger(triggerContext);

      if (trigger !== null) {
        decisions.push({ action: "trigger_brainstorm", trigger });
      }
    }

    // 5. If no ready tasks and blocked tasks exist, mark blocked
    if (!input.hasReadyTasks && input.blockedTaskIds.length > 0) {
      decisions.push({
        action: "mark_blocked",
        reason: `No ready tasks. Blocked: ${input.blockedTaskIds.join(", ")}`,
      });
    }

    // 6. If no decisions were made, continue
    if (decisions.length === 0) {
      decisions.push({ action: "continue" });
    }

    return decisions;
  }

  private buildRecentCompletions(
    input: RouteInput,
    storyComplete: boolean,
  ): ReadonlyArray<{ type: "task" | "story" | "epic"; id: string }> {
    const completions: Array<{ type: "task" | "story" | "epic"; id: string }> = [];

    for (const taskId of input.completedTaskIds) {
      completions.push({ type: "task", id: taskId });
    }

    if (storyComplete) {
      completions.push({ type: "story", id: input.storyId });

      const epicComplete = input.epicStoriesCompleted + 1 >= input.epicStoriesTotal && input.epicStoriesTotal > 0;
      if (epicComplete) {
        completions.push({ type: "epic", id: input.epicId });
      }
    }

    return completions;
  }
}
