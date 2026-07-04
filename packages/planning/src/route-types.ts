import type { BrainstormTrigger } from "./brainstorm-types.js";

export type RouteDecision =
  | { action: "continue" }
  | { action: "cascade_close"; closedItems: string[] }
  | { action: "trigger_brainstorm"; trigger: BrainstormTrigger }
  | { action: "mark_blocked"; reason: string }
  | { action: "flag_drift"; description: string };

export interface RouteInput {
  readonly completedTaskIds: string[];
  readonly storyId: string;
  readonly storyTitle: string;
  readonly storyNorthStar: string;
  readonly storyCriteria: string[];
  readonly storyCriteriaMetCount: number;
  readonly epicId: string;
  readonly epicTitle: string;
  readonly epicNorthStar: string;
  readonly epicStoriesCompleted: number;
  readonly epicStoriesTotal: number;
  readonly tasksSinceBrainstorm: number;
  readonly hasReadyTasks: boolean;
  readonly blockedTaskIds: string[];
}
