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

interface TaskSpecCore {
    readonly goal: string;
    readonly endState: string;
    readonly scope: string;
    /** Observable outcomes, never file paths: the stack is not chosen until Sprint 0. */
    readonly deliverables: string[];
    readonly capability: import("@ashara/shared").CapabilityLevel;
}

/**
 * A planned task's specification. It carries no checks: the decomposer does not
 * author them (ADR-074 addendum 2 d63; the check-author role does, story
 * t-verify-checks-from-plan). Sprint 0 is checked by the environment substrate.
 */
export type TaskSpec =
    | (TaskSpecCore & { readonly origin: "sprint0"; readonly checkedBy: "substrate" })
    | (TaskSpecCore & { readonly origin: "decomposition" });

/**
 * A `dependsOn` entry the model emitted that named no sibling task, was re-asked
 * with the ladder's "drop any dependency you cannot express" instruction, and is
 * not carried by the accepted answer. The plan holds no edge for it; it is
 * recorded so the drop is stated, not silent.
 */
export interface DroppedDependency {
    readonly dependentTaskTitle: string;
    readonly unresolvedRef: string;
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
    /** Every ordering hint the re-ask dropped; empty when none was. */
    readonly droppedDependencies: readonly DroppedDependency[];
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
