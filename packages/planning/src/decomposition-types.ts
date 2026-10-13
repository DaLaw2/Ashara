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
    /**
     * Detailed task metadata the LLM was prompted for (TaskOutputSchema) and
     * `resolveTasks` carries through unchanged. Absent for the epic and for the
     * synthetic scaffold task, which has no LLM output — `generateTaskSpec`
     * falls back to regex derivation in those cases.
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
    maxTasksPerEpic: 15,   // was 5 -- budget is the real limit (economy termination)
};

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
