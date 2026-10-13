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
    /**
     * The project's knowledge graph (ADR-038), derived by the SAME call that
     * produced the tasks. Required, and deliberately so: the previous producer
     * lived in `decomposeLeafStories`, behind a Story-level gate that
     * `maxDepth: 2` holds permanently shut, while the only other injection point
     * (`createBulkPlanWithContract`) took it as an optional dependency with zero
     * suppliers and substituted `{nodes:[],edges:[]}`. Both halves typechecked;
     * together they made the contract graph structurally unfillable. A required
     * field on the one type every decomposition path already returns removes the
     * identity element rather than guarding against it (ADR-048 cause A).
     */
    readonly knowledge: ProjectKnowledge;
}

/**
 * Raised when decomposition cannot state what the project is built in. Fails the
 * whole decomposition closed (Discipline A) rather than emitting tasks alongside
 * an empty graph: an empty graph seeds an empty contract, an empty contract states
 * nothing about the target, and every downstream reader then substitutes its own
 * prior — which is precisely how Runs 36 and 37 built `index.js` + `package.json`
 * for a Go vision.
 */
export class KnowledgeDerivationError extends Error {
    readonly context: { readonly visionTitle: string; readonly reason: string };

    constructor(visionTitle: string, reason: string) {
        super(
            `Cannot derive the project knowledge graph for vision "${visionTitle}": ${reason}. ` +
            `Decomposition is refused: tasks without a stated language or runtime leave every ` +
            `downstream consumer (contract, scaffold, brief, verification) to guess the stack.`,
        );
        this.name = "KnowledgeDerivationError";
        this.context = { visionTitle, reason };
    }
}

export interface DecompositionConfig {
    readonly maxTasksPerEpic: number;
    readonly maxTasksPerStory: number;
    /**
     * Depth of the decomposition tree: 2 = Epic -> Tasks directly (skips
     * Story/Feature layers), 3 = Epic -> Stories -> Tasks, 4 = full
     * Epic -> Stories -> Features -> Tasks. Forced to 2 by default (coarse
     * vertical-slice strategy, granularity-debate.md) so a vision produces
     * tasks instead of the 40-item explosion a full 4-layer fan-out
     * produces. This is authoritative over any per-vision complexity
     * classification (see DecompositionEngine.decomposeInternal).
     */
    readonly maxDepth: number;
}

export const DEFAULT_DECOMPOSITION_CONFIG: DecompositionConfig = {
    maxTasksPerEpic: 15,   // was 5 -- budget is the real limit (economy termination)
    maxTasksPerStory: 8,   // was 4
    maxDepth: 2,
};

/**
 * Reads decomposition cap overrides from system_settings (key-value store).
 * Falls back to DEFAULT_DECOMPOSITION_CONFIG for any key absent from the DB.
 * The `getSetting` dependency mirrors ConfigRepository.getSetting so this
 * stays free of a db package import (the Planning BC does not depend on @ashara/db).
 */
export async function loadDecompositionConfig(
    getSetting: (key: string) => Promise<string | null>,
): Promise<Partial<DecompositionConfig>> {
    const [epicCap, storyCap] = await Promise.all([
        getSetting("decomposition.maxTasksPerEpic"),
        getSetting("decomposition.maxTasksPerStory"),
    ]);

    const result: Record<string, number> = {};

    if (epicCap !== null) {
        const parsed = Number(epicCap);
        if (Number.isFinite(parsed) && parsed > 0) {
            result["maxTasksPerEpic"] = parsed;
        }
    }
    if (storyCap !== null) {
        const parsed = Number(storyCap);
        if (Number.isFinite(parsed) && parsed > 0) {
            result["maxTasksPerStory"] = parsed;
        }
    }

    return result;
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
