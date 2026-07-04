import { z, type ZodType } from "zod";

export type BrainstormLevel = "standard" | "high" | "deep";

export type TriggerReason =
  | "tasks_completed"
  | "no_ready_tasks"
  | "task_blocked"
  | "direction_drift"
  | "story_completed"
  | "epic_completed";

export interface BrainstormTrigger {
  readonly reason: TriggerReason;
  readonly level: BrainstormLevel;
  readonly context: string;
  readonly relatedItemIds?: string[];
  readonly projectContext?: string;
}

export interface BrainstormOutput {
  readonly level: BrainstormLevel;
  readonly recommendations: Recommendation[];
  readonly reasoning: string;
  readonly dissent?: string;
}

export interface Recommendation {
  readonly action: RecommendationAction;
  readonly title: string;
  readonly description: string;
  readonly priority?: "critical" | "high" | "medium" | "low";
  readonly rationale: string;
  /** ID of an existing work item the new item belongs under (its parent). */
  readonly relatedTo?: string;
  /** IDs of existing work items that must complete before the new item starts. */
  readonly dependsOn?: readonly string[];
}

export type RecommendationAction =
  | "create_task"
  | "create_story"
  | "create_feature"
  | "reorder"
  | "reopen"
  | "record_insight"
  | "flag_risk";

export interface BrainstormConfig {
  readonly tasksPerBrainstorm: number;
  readonly standardModel: string;
  readonly highModel: string;
  readonly deepModel: string;
}

export interface TriggerContext {
  readonly tasksSinceBrainstorm: number;
  readonly hasReadyTasks: boolean;
  readonly blockedTaskIds: string[];
  readonly driftDetected: boolean;
  readonly recentCompletions: ReadonlyArray<{ type: "task" | "story" | "epic"; id: string }>;
}

export interface BrainstormLLM {
  generateStructured<T>(prompt: string, schema: ZodType<T, z.ZodTypeDef, any>): Promise<T>;
}
