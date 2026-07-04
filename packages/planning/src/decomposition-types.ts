import { z } from "zod";
import type { ProjectKnowledge } from "@ashara/shared";

export type DecompositionLevel = "epic" | "story" | "feature" | "task";

export interface WorkItemSpec {
    readonly id: string;
    readonly level: DecompositionLevel;
    readonly title: string;
    readonly description: string;
    readonly northStar?: string;
    readonly successCriteria: string[];
    readonly parentId?: string;
    readonly dependsOn: string[];
    /**
     * Detailed task metadata the LLM was prompted for (TaskOutputSchema) and
     * `resolveTasks` carries through unchanged. Absent for epics/stories/features
     * and for the synthetic scaffold/wiring tasks, which have no LLM output —
     * `generateTaskSpec` falls back to regex derivation in those cases.
     */
    readonly goal?: string;
    readonly endState?: string;
    readonly scope?: string;
    readonly deliverables?: string[];
    readonly checks?: string[];
}

export interface TaskSpec {
    readonly goal: string;
    readonly endState: string;
    readonly scope: string;
    readonly deliverables: string[];
    readonly checks: string[];
    readonly priorWorkPointers: string[];
    readonly capability: import("@ashara/shared").CapabilityLevel;
}

export interface DecompositionInput {
    readonly epicTitle: string;
    readonly epicNorthStar: string;
    readonly epicDescription: string;
    readonly knowledge?: ProjectKnowledge;
    readonly priorEpicResults?: PriorEpicResult[];
    readonly conventions: string[];
    readonly manifestContext?: string;
}

export interface PriorEpicResult {
    readonly epicId: string;
    readonly title: string;
    readonly completedStories: string[];
    readonly keyDecisions: string[];
    readonly deliveredCapabilities: string[];
}

/**
 * A minimal summary of a work item that already exists in the project graph
 * (sibling stories' tasks, or anything already created), shown to decomposition
 * prompts so they do not re-emit prerequisites they cannot otherwise see.
 */
export interface ExistingWorkItemSummary {
    readonly id: string;
    readonly title: string;
    readonly level: string;
    readonly status: string;
}

export interface DecompositionResult {
    readonly epic: WorkItemSpec;
    readonly stories: WorkItemSpec[];
    readonly features: WorkItemSpec[];
    readonly tasks: Array<WorkItemSpec & { readonly taskSpec: TaskSpec }>;
    readonly dependencyEdges: Array<{ readonly from: string; readonly to: string }>;
}

export interface DecompositionConfig {
    readonly maxStoriesPerEpic: number;
    readonly maxFeaturesPerStory: number;
    readonly maxTasksPerFeature: number;
    readonly maxTasksPerEpic: number;
    readonly maxTasksPerStory: number;
    readonly maxTotalItems: number;
    /**
     * Depth of the decomposition tree: 2 = Epic -> Tasks directly (skips
     * Story/Feature layers), 3 = Epic -> Stories -> Tasks, 4 = full
     * Epic -> Stories -> Features -> Tasks. Forced to 2 by default (coarse
     * vertical-slice strategy, granularity-debate.md) so a vision produces
     * 5-8 tasks instead of the 40-item explosion a full 4-layer fan-out
     * produces. This is authoritative over any per-vision complexity
     * classification (see DecompositionEngine.decomposeInternal).
     */
    readonly maxDepth: number;
    readonly model: string;
}

export const DEFAULT_DECOMPOSITION_CONFIG: DecompositionConfig = {
    maxStoriesPerEpic: 8,
    maxFeaturesPerStory: 5,
    maxTasksPerFeature: 5,
    maxTasksPerEpic: 5,
    maxTasksPerStory: 4,
    maxTotalItems: 0,
    maxDepth: 2,
    model: "default",
};

export const StoryOutputSchema = z.object({
    stories: z.array(z.object({
        title: z.string(),
        description: z.string(),
        northStar: z.string().optional(),
        successCriteria: z.array(z.string()).default([]),
    })).min(1),
});

export const FeatureOutputSchema = z.object({
    features: z.array(z.object({
        title: z.string(),
        description: z.string(),
        successCriteria: z.array(z.string()).default([]),
    })).min(1),
});

export const TaskOutputSchema = z.object({
    tasks: z.array(z.object({
        /**
         * Stable, decomposer-local handle for this task (G3, Run 7/8). `dependsOn`
         * entries reference sibling tasks by this `ref` so an edge survives even
         * when the LLM paraphrases a title. Optional so legacy plans that only emit
         * titles still parse; resolution falls back to exact-title match for them.
         */
        ref: z.string().optional(),
        title: z.string(),
        description: z.string(),
        successCriteria: z.array(z.string()).default([]),
        dependsOn: z.array(z.string()).default([]),
        goal: z.string().default(""),
        endState: z.string().default(""),
        scope: z.string().default(""),
        deliverables: z.array(z.string()).default([]),
        checks: z.array(z.string()).default([]),
    })).min(1),
});

/**
 * Context carried by {@link UnresolvableDependencyError} (Discipline C): reading
 * the message alone names the dependent task, the ref that could not be resolved,
 * and every ref/title that WAS available — so the failing decomposition is
 * self-diagnosing without re-running it.
 */
export interface UnresolvableDependencyContext {
    readonly dependentTaskTitle: string;
    readonly unresolvedRef: string;
    readonly availableRefs: readonly string[];
    readonly availableTitles: readonly string[];
    readonly parentId: string;
}

/**
 * Raised when a task's `dependsOn` entry (G3) matches neither a sibling task's
 * `ref` (primary) nor its exact `title` (legacy fallback), and the referent was
 * never emitted at all. Fails the decomposition closed (Discipline A) instead of
 * silently dropping the edge, which is exactly how prerequisites ran out of order
 * in Run 7/8. A dependency on a sibling that WAS emitted but capped out of the
 * batch is a capacity drop, not this error — see DecompositionEngine.resolveTasks.
 */
export class UnresolvableDependencyError extends Error {
    readonly context: UnresolvableDependencyContext;

    constructor(context: UnresolvableDependencyContext) {
        super(
            `Unresolvable task dependency: "${context.dependentTaskTitle}" depends on ` +
            `"${context.unresolvedRef}", which matches no sibling ref ` +
            `[${context.availableRefs.join(", ")}] and no exact title ` +
            `[${context.availableTitles.join(", ")}]`,
        );
        this.name = "UnresolvableDependencyError";
        this.context = context;
    }
}
