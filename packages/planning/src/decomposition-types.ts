import { z } from "zod";
import type { ProjectKnowledge } from "@ashara/shared";

export interface WorkItemSpec {
    readonly id: string;
    readonly level: "epic" | "task";
    readonly title: string;
    readonly description: string;
    readonly northStar?: string;
    readonly successCriteria: string[];
    readonly parentId?: string;
    readonly dependsOn: string[];
}

type TaskOrigin = NonNullable<import("@ashara/shared").StoredTaskSpec["origin"]>;

export interface TaskSpec {
    readonly goal: string;
    readonly endState: string;
    readonly scope: string;
    readonly deliverables: string[];
    readonly checks: string[];
    readonly capability: import("@ashara/shared").CapabilityLevel;
    readonly origin: TaskOrigin;
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

export interface DecompositionResult {
    readonly epic: WorkItemSpec;
    readonly tasks: Array<WorkItemSpec & { readonly taskSpec: TaskSpec }>;
    readonly dependencyEdges: Array<{ readonly from: string; readonly to: string }>;
    /**
     * The project's knowledge graph (ADR-038), derived by the SAME call that
     * produced the tasks. Required, and deliberately so: an earlier producer sat
     * behind a gate that never opened, while `createBulkPlanWithContract` took it
     * as an optional dependency with zero suppliers and substituted
     * `{nodes:[],edges:[]}`, which made the contract graph structurally
     * unfillable. A required field on the type decomposition returns removes the
     * identity element rather than guarding against it (ADR-048 cause A).
     */
    readonly knowledge: ProjectKnowledge;
}

export interface DecompositionConfig {
    readonly maxTasksPerEpic: number;
}

export const DEFAULT_DECOMPOSITION_CONFIG: DecompositionConfig = {
    maxTasksPerEpic: 15,   // was 5 -- budget is the real limit
};

/**
 * The model emitted more tasks than the per-epic cap the prompt states. Raised
 * instead of truncating, so no task the model planned is silently dropped
 * (Discipline A). Inside the ladder the same message is a re-ask.
 */
export class TaskCapExceededError extends Error {
    readonly emitted: number;
    readonly cap: number;
    readonly parentId: string;

    constructor(context: { readonly emitted: number; readonly cap: number; readonly parentId: string }) {
        super(
            `Decomposition of ${context.parentId} emitted ${context.emitted} tasks; the cap is ${context.cap}. ` +
            `Merge related work so the epic has at most ${context.cap} tasks.`,
        );
        this.name = "TaskCapExceededError";
        this.emitted = context.emitted;
        this.cap = context.cap;
        this.parentId = context.parentId;
    }
}

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
        // Required and non-empty: these were once filled by keyword inference over
        // the title when the model omitted them, which wrote a guessed spec in the
        // register of the model's own. Omission is now a schema failure the ladder re-asks.
        endState: z.string().trim().min(1),
        scope: z.string().trim().min(1),
        deliverables: z.array(z.string().trim().min(1)).min(1),
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
 * in Run 7/8.
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
