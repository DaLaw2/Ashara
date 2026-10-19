import { z } from "zod";
import type { CapabilityLevel } from "./acl/finance-acl.js";
import { CapabilityLevelSchema } from "./acl/finance-acl.js";
import { checkDecides, taskMayCite } from "./acl/engagement-vision-acl.js";
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
     * The level the task's agent is dispatched at: the planner's grade of a
     * decomposed task, a fixed level for every task the plan adds itself.
     */
    readonly capability: CapabilityLevel;
}

/**
 * The vision items a task traces to, as the vision states them: never
 * empty, since a task that delivers no item of the vision is not planned.
 */
interface Traced {
    readonly visionItems: string[];
}

/**
 * The traced items of a task whose checks are judged item by item: each with its id, status,
 * standing with the client and kind, in the vision's order; their texts are `visionItems`.
 */
interface Sourced extends Traced {
    readonly sources: VisionItem[];
}

/** An acceptance line with the ids of the vision items it serves. */
export interface TracedLine {
    readonly line: string;
    readonly sources: string[];
}

/**
 * A decomposed task's specification: what the client asked for that it delivers, and how it is seen
 * done. Its traced items are exactly the union of the items its deliverables and acceptance lines
 * cite, never chosen apart from them.
 */
export type DecomposedTaskSpec = TaskSpecCore &
    Sourced & {
        readonly origin: "decomposition";
        readonly capabilityReason: string;
        readonly acceptance: TracedLine[];
    };

/**
 * A planned task's specification. It carries no checks: the decomposer does not
 * author them. Each decomposed task has a check task in
 * which the check author writes them; Sprint 0 is checked by the environment substrate.
 * The product scaffold sets up the product's layout after Sprint 0 and before
 * the check tasks, and is checked by the substrate too: the definition's build and test
 * on its merge. Its vision items are those of every decomposed task, whose work it enables.
 * The plan's review task reads every check task's suite together before any decomposed
 * task starts; its vision items are every item of the vision.
 */
export type TaskSpec =
    | (TaskSpecCore & { readonly origin: "sprint0"; readonly checkedBy: "substrate" })
    | (TaskSpecCore & Traced & { readonly origin: "product-scaffold"; readonly checkedBy: "substrate" })
    | DecomposedTaskSpec
    /**
     * `checksFor`: the id of the decomposed task whose checks it writes;
     * its sources and acceptance lines are that task's.
     */
    | (TaskSpecCore & Sourced & { readonly origin: "check"; readonly checksFor: string; readonly acceptance: TracedLine[] })
    | (TaskSpecCore & Sourced & { readonly origin: "review" });

/**
 * One item of the vision a plan is decomposed from: a guarantee or an assumption work proceeds on,
 * by its key in the vision. A guarantee and every assumption not classed internal design may be
 * cited by a deliverable or an acceptance line; every guarantee must be (checkDecides); an
 * internal-design assumption is guidance for the implementer.
 */
export type VisionItem = VisionSource;

/** Whether a deliverable or an acceptance line may cite the item (taskMayCite). */
export function citable(item: VisionItem): boolean {
    return taskMayCite(item);
}

/**
 * The items a plan must check: every guarantee, whether the planner chose to cite it or not. Each is cited by a task of the plan, or by a
 * completed task that cited it as the vision states it now, and is decided by that task's stored checks.
 */
export function itemsToCheck(items: readonly VisionItem[]): VisionItem[] {
    return items.filter(checkDecides);
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
 * The product's layout a plan builds on: set up by a new product
 * scaffold task in the plan, or already set up by a completed one. `taskId` is then the completed
 * task whose recorded merge is the layout's latest merged state: the scaffold, or a task merged
 * after it. A revision on the existing environment red-runs its checks there, since the environment
 * task's own commit holds no product to build.
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
    /** Every item of the vision; each planned task names those it delivers. One with no guarantee is refused, never planned on. */
    readonly visionItems: readonly VisionItem[];
    /**
     * The product's public interface as the vision states it, each entry by its key: a new product
     * scaffold writes every entry down as stated. Empty for a vision that recorded none.
     */
    readonly interface: ReadonlyArray<{ readonly id: string; readonly text: string }>;
    /**
     * The vision items the stored checks of a completed task decide (task_checks.decides), each as
     * its check task cites it, so an item here whose text is the vision's now needs no new task to
     * cite it. Never read from what a task cites. Empty for a first plan.
     */
    readonly checkedItems: readonly VisionItem[];
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
 * A deliverable or an acceptance line with the ids of the vision items it serves.
 * `sources` may be empty here: a line that cites nothing is the decomposer's semantic
 * rejection, whose message names the line, not a bare schema failure.
 */
const TracedLineOutputSchema = z.object({
    text: z.string().trim().min(1),
    sources: z.array(z.string().trim().min(1)),
});

export const TaskOutputSchema = z.object({
    tasks: z.array(z.object({
        /**
         * Stable, decomposer-local handle for this task. `dependsOn`
         * entries reference sibling tasks by this `ref` so an edge survives even
         * when the LLM paraphrases a title; resolution also accepts an exact title.
         * Every field is required: a provider decoding strictly against the schema
         * takes no optional property (model-access schema-acceptance), and an empty
         * `dependsOn` or `goal` says "none" as plainly as an omitted one.
         */
        ref: z.string(),
        title: z.string(),
        description: z.string(),
        dependsOn: z.array(z.string()),
        goal: z.string(),
        // Required and non-empty: an omission is a schema failure the ladder re-asks, never
        // filled by inference over the title, which would write a guessed spec in the register
        // of the model's own.
        endState: z.string().trim().min(1),
        scope: z.string().trim().min(1),
        // Each deliverable and each acceptance line names the vision items it serves;
        // the task's traced items are the union of those, never chosen separately.
        deliverables: z.array(TracedLineOutputSchema).min(1),
        acceptance: z.array(TracedLineOutputSchema).min(1),
        // The planner's grade of the work's difficulty and why. Required: a
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
            return (
                `${which} names ${line.source}, an internal-design assumption: it guides the implementer and is never ` +
                `a deliverable or acceptance line's source; drop the line or cite the client-visible item it serves`
            );
    }
}

/**
 * A planned task's deliverable or acceptance line cites no vision item, one the vision does not hold,
 * or an assumption that may not be a source: an untraced
 * line can ask for behaviour the tender never asked for, or rest on an assumption the task does not
 * name. Checked mechanically, with no model call. Inside the ladder its message is a re-ask;
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
 * A plan leaves an item a check must decide cited by no task: neither one it plans
 * nor a completed task that cited it as the vision states it now. Only a task that cites an item
 * has a check task whose checks must decide it (Z0 keeps a check set only when every item its task
 * cites is decided by one of its checks), so an item no task cites would be accepted with no check
 * on it. Whether it is checked is the stored checks' to say; this rule only gives each such item a
 * task. Checked mechanically, with no model call: inside the ladder its message is a re-ask; past
 * it the plan is rejected, never written.
 */
export class UncitedVisionItemsError extends Error {
    constructor(
        readonly parentId: string,
        readonly uncited: ReadonlyArray<{ readonly id: string; readonly text: string }>,
    ) {
        super(
            `No task cites ${uncited.map((item) => `${item.id} ("${item.text}")`).join(", ")}: every guarantee must be ` +
                `named in "sources" by a deliverable or an acceptance line of a task whose work it is, so that task's ` +
                `checks decide it (decomposition of ${parentId})`,
        );
        this.name = "UncitedVisionItemsError";
    }
}

/**
 * The vision holds no guarantee: nothing a delivery is judged against, so a plan would be accepted
 * with no check deciding anything, and nothing could be planned without inventing what the client
 * asked for. No decomposition is attempted.
 */
export class VisionItemsMissing extends Error {
    constructor(readonly epicTitle: string) {
        super(
            `the vision of "${epicTitle}" states no guarantee: no task could trace to what a delivery is judged ` +
                `against, so nothing is planned`,
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
interface UnresolvableDependencyContext {
    readonly dependentTaskTitle: string;
    readonly unresolvedRef: string;
    readonly availableRefs: readonly string[];
    readonly availableTitles: readonly string[];
    readonly parentId: string;
}

/**
 * Raised when a task's `dependsOn` entry matches neither a sibling task's
 * `ref` (primary) nor its exact `title` (legacy fallback), and the referent was
 * never emitted at all. Fails the decomposition closed (Discipline A) instead of
 * silently dropping the edge: a dropped edge lets a prerequisite run out of order.
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
