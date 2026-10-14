import { z } from "zod";
import type { CapabilityLevel, ProjectKnowledge } from "@ashara/shared";
import { CapabilityLevelSchema } from "@ashara/shared";

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
    /**
     * The level the task's agent is dispatched at (ADR-074 addendum 2 d70): the planner's grade of a
     * decomposed task, a fixed level for every task the plan adds itself.
     */
    readonly capability: CapabilityLevel;
}

/**
 * The vision items a task traces to (ADR-074 addendum 2 d71 d), as the vision states them: never
 * empty, since a task that delivers no item of the vision is not planned.
 */
interface Traced {
    readonly visionItems: string[];
}

/** A decomposed task's specification: what the client asked for that it delivers, and how it is seen done. */
export type DecomposedTaskSpec = TaskSpecCore &
    Traced & { readonly origin: "decomposition"; readonly capabilityReason: string };

/**
 * A planned task's specification. It carries no checks: the decomposer does not
 * author them (ADR-074 addendum 2 d63). Each decomposed task has a check task in
 * which the check author writes them; Sprint 0 is checked by the environment substrate.
 * The product scaffold (d72 B2) sets up the product's layout after Sprint 0 and before
 * the check tasks, and is checked by the substrate too: the definition's build and test
 * on its merge. Its vision items are those of every decomposed task, whose work it enables.
 * The plan's review task reads every check task's suite together before any decomposed
 * task starts (d71 c); its vision items are every item of the vision.
 */
export type TaskSpec =
    | (TaskSpecCore & { readonly origin: "sprint0"; readonly checkedBy: "substrate" })
    | (TaskSpecCore & Traced & { readonly origin: "product-scaffold"; readonly checkedBy: "substrate" })
    | DecomposedTaskSpec
    /** `checksFor`: the id of the decomposed task whose checks it writes (ADR-074 addendum 2 d67 a). */
    | (TaskSpecCore & Traced & { readonly origin: "check"; readonly checksFor: string })
    | (TaskSpecCore & Traced & { readonly origin: "review" });

/**
 * One item of the vision a plan is decomposed from: a scope boundary or an assumption work
 * proceeds on. `id` is local to one decomposition prompt (S1.., A1..); the item's text is what
 * the plan records.
 */
export interface VisionItem {
    readonly id: string;
    readonly text: string;
}

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

/**
 * Where the plan's environment comes from. `new`: the plan carries its own Sprint 0 task, as a
 * first plan does and as a revision does when the change is an environment change. `existing`: a
 * revision builds on the environment task already done (its work item id), which every planned
 * task depends on instead.
 */
export type EnvironmentPlanning =
    | { readonly kind: "new" }
    | { readonly kind: "existing"; readonly taskId: string };

/**
 * The product's layout a plan builds on (ADR-074 addendum 2 d72 B2): set up by a new product
 * scaffold task in the plan, or already set up by a completed one (`taskId`).
 */
export type LayoutPlanning =
    | { readonly kind: "new" }
    | { readonly kind: "existing"; readonly taskId: string };

export interface DecompositionInput {
    readonly epicTitle: string;
    readonly epicNorthStar: string;
    readonly epicDescription: string;
    readonly knowledge?: ProjectKnowledge;
    readonly priorEpicResults?: PriorEpicResult[];
    readonly conventions: string[];
    readonly manifestContext?: string;
    readonly environment: EnvironmentPlanning;
    readonly layout: LayoutPlanning;
    /** Every item of the vision; each planned task names those it delivers. Empty is refused, never planned on. */
    readonly visionItems: readonly VisionItem[];
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
        // The ids (or exact texts) of the vision items the task delivers (ADR-074 addendum 2 d71 d).
        // Required: an empty list, or an entry naming no item, is the decomposer's semantic rejection.
        visionItems: z.array(z.string().trim().min(1)),
        // The planner's grade of the work's difficulty (ADR-074 addendum 2 d70) and why. Required: a
        // task without a grade is a schema failure the ladder re-asks, never a default level.
        capability: CapabilityLevelSchema,
        capabilityReason: z.string().trim().min(1),
    })).min(1),
});

/** Context of {@link UntraceableTaskError}: the task, what it named, and every item it could have named. */
interface UntraceableTaskContext {
    readonly taskTitle: string;
    /** The entries of its `visionItems` that name no vision item; empty when it named none at all. */
    readonly unknown: readonly string[];
    readonly availableIds: readonly string[];
    readonly parentId: string;
}

/**
 * A planned task names no vision item it delivers, or names one the vision does not hold (ADR-074
 * addendum 2 d71 d; fifth run N21: a scaffold task whose behaviour the tender never asked for).
 * Inside the ladder its message is a re-ask; past it the plan is rejected, never written.
 */
export class UntraceableTaskError extends Error {
    readonly context: UntraceableTaskContext;

    constructor(context: UntraceableTaskContext) {
        super(
            context.unknown.length === 0
                ? `Task "${context.taskTitle}" names no vision item it delivers; every task must name at least one of ` +
                      `[${context.availableIds.join(", ")}] (decomposition of ${context.parentId})`
                : `Task "${context.taskTitle}" names ${context.unknown.map((u) => JSON.stringify(u)).join(", ")}, which ` +
                      `${context.unknown.length === 1 ? "is" : "are"} no vision item; the vision's items are ` +
                      `[${context.availableIds.join(", ")}] (decomposition of ${context.parentId})`,
        );
        this.name = "UntraceableTaskError";
        this.context = context;
    }
}

/**
 * The vision holds no item a task could trace to (no scope boundary, no assumption): nothing could
 * be planned without inventing what the client asked for, so no decomposition is attempted.
 */
export class VisionItemsMissing extends Error {
    constructor(readonly epicTitle: string) {
        super(
            `the vision of "${epicTitle}" states no scope boundary and no assumption: no task could trace to it, ` +
                `so nothing is planned`,
        );
        this.name = "VisionItemsMissing";
    }
}

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
