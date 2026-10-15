import { z } from "zod";
import type { CapabilityLevel } from "@ashara/model-access";
import { CapabilityLevelSchema } from "@ashara/model-access";
import type { VisionSource } from "./acl/engagement-vision-acl.js";

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

/**
 * The traced items of a task whose checks are judged item by item (d89): each with its id, status,
 * standing with the client and kind, in the vision's order; their texts are `visionItems`.
 */
interface Sourced extends Traced {
    readonly sources: VisionItem[];
}

/** An acceptance line with the ids of the vision items it serves (d89 A). */
export interface TracedLine {
    readonly line: string;
    readonly sources: string[];
}

/**
 * A decomposed task's specification: what the client asked for that it delivers, and how it is seen
 * done. Its traced items are exactly the union of the items its deliverables and acceptance lines
 * cite (d89 A), never chosen apart from them.
 */
export type DecomposedTaskSpec = TaskSpecCore &
    Sourced & {
        readonly origin: "decomposition";
        readonly capabilityReason: string;
        readonly acceptance: TracedLine[];
    };

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
    /**
     * `checksFor`: the id of the decomposed task whose checks it writes (ADR-074 addendum 2 d67 a);
     * its sources and acceptance lines are that task's (d89).
     */
    | (TaskSpecCore & Sourced & { readonly origin: "check"; readonly checksFor: string; readonly acceptance: TracedLine[] })
    | (TaskSpecCore & Sourced & { readonly origin: "review" });

/**
 * One item of the vision a plan is decomposed from: a scope boundary (S1..) or an assumption work
 * proceeds on, by its key in the vision. Only a scope line and a client-visible assumption may be
 * cited by a deliverable or an acceptance line (ADR-074 addendum 2 d89 E); an internal-design or
 * unclassified one is guidance for the implementer.
 */
export type VisionItem = VisionSource;

/** Whether a deliverable or an acceptance line may cite the item (d89 E). */
export function citable(item: VisionItem): boolean {
    return item.type === "scope" || item.kind === "client-visible";
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
 * scaffold task in the plan, or already set up by a completed one. `taskId` is then the completed
 * task whose recorded merge is the layout's latest merged state: the scaffold, or a task merged
 * after it. A revision on the existing environment red-runs its checks there (W11 D2).
 */
export type LayoutPlanning =
    | { readonly kind: "new" }
    | { readonly kind: "existing"; readonly taskId: string };

export interface DecompositionInput {
    readonly epicTitle: string;
    readonly epicNorthStar: string;
    readonly epicDescription: string;
    readonly priorEpicResults?: PriorEpicResult[];
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

/**
 * A deliverable or an acceptance line with the ids of the vision items it serves (ADR-074 addendum 2
 * d89 A). `sources` may be empty here: a line that cites nothing is the decomposer's semantic
 * rejection, whose message names the line, not a bare schema failure.
 */
const TracedLineOutputSchema = z.object({
    text: z.string().trim().min(1),
    sources: z.array(z.string().trim().min(1)),
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
        dependsOn: z.array(z.string()).default([]),
        goal: z.string().default(""),
        // Required and non-empty: these were once filled by keyword inference over
        // the title when the model omitted them, which wrote a guessed spec in the
        // register of the model's own. Omission is now a schema failure the ladder re-asks.
        endState: z.string().trim().min(1),
        scope: z.string().trim().min(1),
        // Each deliverable and each acceptance line names the vision items it serves (ADR-074 addendum
        // 2 d71 d, d89 A); the task's traced items are the union of those, never chosen separately.
        deliverables: z.array(TracedLineOutputSchema).min(1),
        acceptance: z.array(TracedLineOutputSchema).min(1),
        // The planner's grade of the work's difficulty (ADR-074 addendum 2 d70) and why. Required: a
        // task without a grade is a schema failure the ladder re-asks, never a default level.
        capability: CapabilityLevelSchema,
        capabilityReason: z.string().trim().min(1),
    })).min(1),
});

/** What is wrong with one deliverable or acceptance line's sources. */
export type UntracedLine =
    | { readonly field: "deliverable" | "acceptance"; readonly text: string; readonly problem: "no-source" }
    | { readonly field: "deliverable" | "acceptance"; readonly text: string; readonly problem: "unknown"; readonly source: string }
    | {
          readonly field: "deliverable" | "acceptance";
          readonly text: string;
          readonly problem: "not-citable";
          readonly source: string;
          readonly kind: "internal-design" | "unclassified";
      };

/** Context of {@link UntraceableTaskError}: the task, each line whose sources are wrong, and every item it could cite. */
interface UntraceableTaskContext {
    readonly taskTitle: string;
    readonly lines: readonly UntracedLine[];
    readonly citableIds: readonly string[];
    readonly parentId: string;
}

function untracedText(line: UntracedLine): string {
    const which = `${line.field} ${JSON.stringify(line.text)}`;
    switch (line.problem) {
        case "no-source":
            return `${which} names no vision item it serves`;
        case "unknown":
            return `${which} names ${JSON.stringify(line.source)}, which is no vision item`;
        case "not-citable":
            return line.kind === "internal-design"
                ? `${which} names ${line.source}, an internal-design assumption: it guides the implementer and is never ` +
                      `a deliverable or acceptance line's source; drop the line or cite the client-visible item it serves`
                : `${which} names ${line.source}, an assumption of no recorded kind, which cannot be a source`;
    }
}

/**
 * A planned task's deliverable or acceptance line cites no vision item, one the vision does not hold,
 * or an assumption that may not be a source (ADR-074 addendum 2 d71 d, d89 A and E; fifth run N21: a
 * scaffold task whose behaviour the tender never asked for; W11: lines drawn from assumptions the task
 * did not name). Checked mechanically, with no model call. Inside the ladder its message is a re-ask;
 * past it the plan is rejected, never written.
 */
export class UntraceableTaskError extends Error {
    readonly context: UntraceableTaskContext;

    constructor(context: UntraceableTaskContext) {
        super(
            `Task "${context.taskTitle}": ${context.lines.map(untracedText).join("; ")}. Every deliverable and every ` +
                `acceptance line must name in "sources" at least one of [${context.citableIds.join(", ")}] ` +
                `(decomposition of ${context.parentId})`,
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
