import { z } from "zod";
import type { CapabilityLevel } from "./acl/finance-acl.js";
import { CapabilityLevelSchema } from "./acl/finance-acl.js";
import { assumptionChecked } from "./acl/engagement-vision-acl.js";
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
 * proceeds on, by its key in the vision. A scope line and every assumption not classed internal
 * design may be cited by a deliverable or an acceptance line (ADR-074 addendum 2 d89 E, ADR-083),
 * and every such assumption must be; an internal-design one is guidance for the implementer.
 */
export type VisionItem = VisionSource;

/** Whether a deliverable or an acceptance line may cite the item (d89 E). */
export function citable(item: VisionItem): boolean {
    return item.type === "scope" || assumptionChecked(item.kind);
}

/**
 * The assumptions a plan must check (ADR-083): every one an acceptance line may cite. Each is named
 * by an acceptance line of the plan, or of a completed task that cited it as the vision states it now.
 */
export function assumptionsToCheck(items: readonly VisionItem[]): Array<Extract<VisionItem, { readonly type: "assumption" }>> {
    return items.flatMap((item) => (item.type === "assumption" && assumptionChecked(item.kind) ? [item] : []));
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
    /** Every item of the vision; each planned task names those it delivers. Empty is refused, never planned on. */
    readonly visionItems: readonly VisionItem[];
    /**
     * The vision items an acceptance line of a completed task already names, each as that task cited
     * it: an assumption here whose text is the vision's now needs no new line (ADR-083). Empty for a
     * first plan.
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
         * Stable, decomposer-local handle for this task. `dependsOn`
         * entries reference sibling tasks by this `ref` so an edge survives even
         * when the LLM paraphrases a title. Optional so legacy plans that only emit
         * titles still parse; resolution falls back to exact-title match for them.
         */
        ref: z.string().optional(),
        title: z.string(),
        description: z.string(),
        dependsOn: z.array(z.string()).default([]),
        goal: z.string().default(""),
        // Required and non-empty: an omission is a schema failure the ladder re-asks, never
        // filled by inference over the title, which would write a guessed spec in the register
        // of the model's own.
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
 * or an assumption that may not be a source (ADR-074 addendum 2 d71 d, d89 A and E): an untraced
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
 * A plan leaves an assumption a check must decide (ADR-083) named by no acceptance line: neither of
 * a task it plans nor of a completed task that cited it as the vision states it now. Its breach is
 * one the client could observe, so accepting without a check on it would deliver it unverified.
 * Checked mechanically, with no model call: inside the ladder its message is a re-ask; past it the
 * plan is rejected, never written.
 */
export class UncheckedAssumptionsError extends Error {
    constructor(
        readonly parentId: string,
        readonly unchecked: ReadonlyArray<{ readonly id: string; readonly text: string }>,
    ) {
        super(
            `No acceptance line names ${unchecked.map((item) => `${item.id} ("${item.text}")`).join(", ")}: every client-visible ` +
                `assumption must be named in "sources" by at least one acceptance line of a task, so a check decides it ` +
                `(decomposition of ${parentId})`,
        );
        this.name = "UncheckedAssumptionsError";
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
interface UnresolvableDependencyContext {
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
