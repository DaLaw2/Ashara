import { z, type ZodType } from "zod";
import type { ProjectKnowledge } from "@ashara/shared";
import { ProjectKnowledgeSchema } from "@ashara/shared";
import type { StructuredValidation } from "@ashara/llm-gateway";
import type {
    DecomposedTaskSpec,
    DecompositionConfig,
    DecompositionInput,
    EnvironmentPlanning,
    DecompositionResult,
    DroppedDependency,
    PriorEpicResult,
    TaskSpec,
    VisionItem,
    WorkItemSpec,
} from "./decomposition-types.js";
import {
    DEFAULT_DECOMPOSITION_CONFIG,
    TaskCapExceededError,
    TaskOutputSchema,
    UnresolvableDependencyError,
    UntraceableTaskError,
    VisionItemsMissing,
} from "./decomposition-types.js";

export interface DecompositionLLM {
    /**
     * `validate` (mig-run10) is an optional post-parse SEMANTIC check run INSIDE
     * the reliability ladder attempt: a `false` verdict (e.g. a phantom
     * `dependsOn` ref) is a retryable failure whose feedback is re-asked and
     * escalated, so one malformed emission is corrected on retry rather than
     * exploding the whole decomposition. An unladdered LLM may ignore it.
     */
    generateStructured<T>(
        prompt: string,
        schema: ZodType<T>,
        validate?: (value: T) => StructuredValidation,
    ): Promise<T>;
}

type RawTask = z.infer<typeof TaskOutputSchema>["tasks"][number];

// Rewrites negative-framed instructions ("do not modify X") into positive
// equivalents ("only modify files outside of X") — models follow positive
// constraints more reliably than negations. `$1` is the captured target/action.
const POSITIVE_FRAMING_RULES: ReadonlyArray<readonly [RegExp, string]> = [
    [/\bdo\s+not\s+modify\s+(.+)/gi, "only modify files outside of $1"],
    [/\bdon['']t\s+modify\s+(.+)/gi, "only modify files outside of $1"],
    [/\bdon['']t\s+use\s+(.+)/gi, "use alternatives to $1"],
    [/\bdo\s+not\s+use\s+(.+)/gi, "use alternatives to $1"],
    [/\bnever\s+(.+)/gi, "ensure $1 does not occur"],
    [/\bmust\s+not\s+(.+)/gi, "ensure $1 is avoided"],
    [/\bavoid\s+(.+)/gi, "prefer alternatives to $1"],
];

export class DecompositionEngine {
    private readonly llm: DecompositionLLM;
    private readonly config: DecompositionConfig;

    constructor(llm: DecompositionLLM) {
        this.llm = llm;
        this.config = DEFAULT_DECOMPOSITION_CONFIG;
    }

    /** Throws VisionItemsMissing, before any model call, for a vision no task could trace to. */
    async decompose(input: DecompositionInput): Promise<DecompositionResult> {
        if (input.visionItems.length === 0) throw new VisionItemsMissing(input.epicTitle);
        return this.decomposeInternal(input);
    }

    ensurePositiveFraming(text: string): string {
        return POSITIVE_FRAMING_RULES.reduce((result, [pattern, replacement]) => result.replace(pattern, replacement), text);
    }

    /**
     * The single producer of the project knowledge graph. Private on purpose:
     * there is one call site (`decomposeInternal`) and no way to obtain a decomposition whose
     * graph was never derived.
     */
    private async deriveKnowledge(
        visionTitle: string,
        visionDescription: string,
        northStar?: string,
        manifestContext?: string,
    ): Promise<ProjectKnowledge> {
        const contextParts = [`Vision: "${visionTitle}"\nDescription: ${visionDescription}`];
        if (northStar && northStar.trim().length > 0) {
            contextParts.push(`North Star: ${northStar}`);
        }
        if (manifestContext && manifestContext.trim().length > 0) {
            contextParts.push(`Project manifest files found:\n${manifestContext}`);
        }

        const prompt = [
            `You are analyzing a software project vision to produce a structured knowledge graph.`,
            ``,
            contextParts.join("\n\n"),
            ``,
            `Produce nodes for any of these kinds that the vision or the manifest files state: language, runtime, framework, database, subsystem, entry_point, check, build_tool.`,
            `- Emit only what is stated. Where they state no implementation stack, emit no language, runtime, framework, database or build_tool node: an empty "nodes" array is a valid answer, and choosing a stack is not your decision here.`,
            `- check nodes MUST have meta.command set to a string array (the shell command to run)`,
            ``,
            `Produce edges between nodes using these relationship types: uses, depends_on, serves, reads_writes, targets.`,
            ``,
            `Each node needs a unique short slug id, a kind, and a human-readable label.`,
            ``,
            `IMPORTANT: Respond with ONLY valid JSON, no markdown, no explanation, no code fences.`,
        ].join("\n");

        // A graph with no stack node is a valid answer: Ashara never picks the
        // client's stack. The Sprint 0 task chooses it, and every later task's
        // brief carries that team's own statement of the environment.
        return this.llm.generateStructured(prompt, ProjectKnowledgeSchema);
    }

    private async decomposeInternal(input: DecompositionInput): Promise<DecompositionResult> {
        const epicId = generateId("epic");
        const epic: WorkItemSpec = {
            id: epicId,
            level: "epic",
            title: input.epicTitle,
            description: input.epicDescription,
            northStar: input.epicNorthStar,
            successCriteria: [],
            dependsOn: [],
        };

        const allTasks: Array<WorkItemSpec & { taskSpec: TaskSpec }> = [];
        const dependencyEdges: Array<{ from: string; to: string }> = [];

        // Derive the graph BEFORE the tasks so the task prompt carries whatever
        // stack the vision states (buildDecomposePrompt reads input.knowledge).
        // An explicitly supplied graph — a re-decomposition against a contract
        // that already states the stack — is authoritative and is not re-derived.
        const knowledge = input.knowledge ?? await this.deriveKnowledge(
            input.epicTitle,
            input.epicDescription,
            input.epicNorthStar,
            input.manifestContext,
        );
        const knownInput: DecompositionInput = { ...input, knowledge };

        const { tasks, droppedDependencies } = await this.decomposeEpicIntoTasks(epic, knownInput);
        for (const task of tasks) {
            allTasks.push(task);
            for (const dep of task.dependsOn) {
                dependencyEdges.push({ from: task.id, to: dep });
            }
        }

        // decomposeEpicIntoTasks never returns an empty list (TaskOutputSchema
        // requires one task), so every plan carries its Sprint 0, or depends on the
        // one already done.
        const sprint0Id =
            input.environment.kind === "new"
                ? this.ensureSprint0Task(epic.id, allTasks, dependencyEdges)
                : dependOnEnvironment(input.environment.taskId, allTasks, dependencyEdges);
        const plannedTasks = addReviewTask(
            epic.id,
            sprint0Id,
            addCheckTasks(epic.id, sprint0Id, allTasks, dependencyEdges),
            dependencyEdges,
            input.visionItems,
        );

        return {
            epic,
            tasks: plannedTasks,
            dependencyEdges,
            knowledge,
            droppedDependencies,
        };
    }

    /**
     * Adds the plan's one Sprint 0 task (ADR-074 addendum 2 d62-d63): the
     * environment role defines and builds the project environment, choosing the
     * stack, before any implementation task runs, so every other task depends on
     * it. Its text names no stack: choosing one is the task's own work. It carries
     * no checks of its own; the environment substrate checks it.
     *
     * There is no equivalent `ensureWiringTask` — wiring is not a separate task. Every
     * generated task is a vertical slice that makes its own outcome reachable in the
     * same session (see buildDecomposePrompt's Task Quality Requirements), so no
     * dedicated integration task exists to be starved by the dispatch queue.
     */
    private ensureSprint0Task(
        epicId: string,
        tasks: Array<WorkItemSpec & { taskSpec: TaskSpec }>,
        dependencyEdges: Array<{ from: string; to: string }>,
    ): string {
        const sprint0Id = generateId("task");
        const successCriteria = [
            "environment/environment.toml parses",
            "the environment it defines builds",
            "the work touches owned paths only",
            "the environment's build then test commands pass on a fresh checkout, test printing output, and leave it clean",
        ];
        const sprint0Task: WorkItemSpec & { taskSpec: TaskSpec } = {
            id: sprint0Id,
            level: "task",
            title: SPRINT0_TITLE,
            description: SPRINT0_DESCRIPTION,
            successCriteria,
            parentId: epicId,
            dependsOn: [],
            taskSpec: {
                goal: SPRINT0_DESCRIPTION,
                endState: successCriteria.join("; "),
                scope: "environment/environment.toml and the owned files it names; no product code",
                deliverables: [
                    "environment/environment.toml naming the owned paths, the containerfile, and the build and test commands",
                    "the owned files environment/environment.toml names",
                    "a one-paragraph statement of the stack chosen and why, given as finish's statement",
                ],
                capability: "Strong",
                origin: "sprint0",
                checkedBy: "substrate",
            },
        };

        for (const task of tasks) {
            dependencyEdges.push({ from: task.id, to: sprint0Id });
        }
        tasks.unshift(sprint0Task);
        return sprint0Id;
    }

    /**
     * PURE pre-check (mig-run10) run inside the reliability ladder's attempt, so
     * an over-cap emission or a phantom `dependsOn` ref is re-asked with this
     * feedback rather than accepted. It mirrors {@link resolveTasks}'s failure
     * checks without assigning ids (generateId runs once, after this passes).
     */
    private validateTasks(
        rawTasks: readonly RawTask[],
        cap: number,
        parentId: string,
        visionItems: readonly VisionItem[],
    ): StructuredValidation {
        if (rawTasks.length > cap) {
            return { ok: false, errors: [new TaskCapExceededError({ emitted: rawTasks.length, cap, parentId }).message] };
        }
        const availableRefs = rawTasks.flatMap((t) => (t.ref ? [t.ref] : []));
        const availableTitles = rawTasks.map((t) => t.title);
        const errors = [
            ...unresolvedDependencies(rawTasks).map(
                (unresolved) =>
                    new UnresolvableDependencyError({ ...unresolved, availableRefs, availableTitles, parentId }).message,
            ),
            ...rawTasks.flatMap((raw) => {
                const traced = traceToVision(raw, visionItems, parentId);
                return traced.kind === "untraceable" ? [traced.error.message] : [];
            }),
        ];
        return errors.length === 0 ? { ok: true } : { ok: false, errors };
    }

    /**
     * Turns raw LLM tasks into task specs with deterministically resolved, stable
     * inter-task edges (G3). Each task is assigned a synthetic id; every
     * `dependsOn` entry is resolved to that id by `ref` first (primary), then
     * exact `title` (legacy fallback). Over-cap output and a dependency on
     * something never emitted both fail closed, so nothing the model produced is
     * dropped. This holds even for an LLM that ignores `validate`, and so does the
     * trace to the vision: a task naming no vision item, or one the vision does not
     * hold, throws UntraceableTaskError.
     */
    private resolveTasks(
        rawTasks: readonly RawTask[],
        cap: number,
        parentId: string,
        visionItems: readonly VisionItem[],
    ): Array<WorkItemSpec & { taskSpec: DecomposedTaskSpec }> {
        if (rawTasks.length > cap) {
            throw new TaskCapExceededError({ emitted: rawTasks.length, cap, parentId });
        }

        const refToId = new Map<string, string>();
        const titleToId = new Map<string, string>();
        const assigned = rawTasks.map((raw) => {
            const traced = traceToVision(raw, visionItems, parentId);
            if (traced.kind === "untraceable") throw traced.error;
            const id = generateId("task");
            if (raw.ref) refToId.set(raw.ref, id);
            // First-writer-wins on duplicate titles so an edge resolves to the
            // earliest task with that title rather than being clobbered.
            if (!titleToId.has(raw.title)) titleToId.set(raw.title, id);
            return { raw, id, tracedTexts: traced.texts };
        });

        return assigned.map(({ raw, id, tracedTexts }) => ({
            id,
            level: "task" as const,
            title: raw.title,
            description: raw.description,
            successCriteria: raw.successCriteria,
            parentId,
            dependsOn: this.resolveDependsOn(raw, id, refToId, titleToId, parentId),
            taskSpec: {
                goal: raw.goal || raw.description || raw.title,
                endState: raw.endState,
                scope: raw.scope,
                deliverables: raw.deliverables,
                capability: "Strong",
                origin: "decomposition" as const,
                visionItems: tracedTexts,
            },
        }));
    }

    private resolveDependsOn(
        raw: RawTask,
        selfId: string,
        refToId: ReadonlyMap<string, string>,
        titleToId: ReadonlyMap<string, string>,
        parentId: string,
    ): string[] {
        const resolved: string[] = [];
        for (const dep of raw.dependsOn) {
            const target = refToId.get(dep) ?? titleToId.get(dep);
            if (target === undefined) {
                throw new UnresolvableDependencyError({
                    dependentTaskTitle: raw.title,
                    unresolvedRef: dep,
                    availableRefs: [...refToId.keys()],
                    availableTitles: [...titleToId.keys()],
                    parentId,
                });
            }
            // Skip a self-reference so a task never depends on itself.
            if (target !== selfId && !resolved.includes(target)) resolved.push(target);
        }
        return resolved;
    }

    private async decomposeEpicIntoTasks(
        epic: WorkItemSpec,
        input: DecompositionInput,
    ): Promise<{
        readonly tasks: Array<WorkItemSpec & { taskSpec: TaskSpec }>;
        readonly droppedDependencies: readonly DroppedDependency[];
    }> {
        const taskCap = this.config.maxTasksPerEpic;
        const priorContext = this.buildPriorContext(input.priorEpicResults);
        const prompt = this.buildDecomposePrompt(
            "decompose this epic into tasks",
            epic.title,
            epic.description,
            input.knowledge,
            input.conventions,
            priorContext,
            input.epicNorthStar,
            input.manifestContext,
            taskCap,
            input.environment,
            input.visionItems,
        );

        // Every unresolvable edge a rejected attempt carried. The re-ask tells the
        // model to drop what it cannot express (gateway-adapters.ts), so an edge
        // the accepted answer no longer carries is recorded here instead of vanishing.
        const unresolvedSeen = new Map<string, DroppedDependency>();
        const parsed = await this.llm.generateStructured(
            prompt,
            TaskOutputSchema,
            (value) => {
                for (const unresolved of unresolvedDependencies(value.tasks)) {
                    unresolvedSeen.set(JSON.stringify([unresolved.dependentTaskTitle, unresolved.unresolvedRef]), unresolved);
                }
                return this.validateTasks(value.tasks, taskCap, epic.id, input.visionItems);
            },
        );
        // A ref that now resolves on the same task is kept, not dropped. An edge
        // re-expressed under a different ref cannot be told apart from a drop, so
        // it is listed: the record errs toward stating a drop.
        const droppedDependencies = [...unresolvedSeen.values()].filter(
            (seen) =>
                !parsed.tasks.some((t) => t.title === seen.dependentTaskTitle && t.dependsOn.includes(seen.unresolvedRef)),
        );
        return { tasks: this.resolveTasks(parsed.tasks, taskCap, epic.id, input.visionItems), droppedDependencies };
    }

    private buildPriorContext(priorResults?: PriorEpicResult[]): string {
        if (!priorResults || priorResults.length === 0) {
            return "";
        }

        const sections = priorResults.map((r) => {
            const stories = r.completedStories.map((s) => `  - ${s}`).join("\n");
            const decisions = r.keyDecisions.map((d) => `  - ${d}`).join("\n");
            const capabilities = r.deliveredCapabilities.map((c) => `  - ${c}`).join("\n");
            return [
                `Prior Epic: ${r.title} (${r.epicId})`,
                `Completed Stories:\n${stories}`,
                `Key Decisions:\n${decisions}`,
                `Delivered Capabilities:\n${capabilities}`,
            ].join("\n");
        });

        return `\n\nPrior Epic Context (use these results to inform decomposition):\n${sections.join("\n\n")}`;
    }

    private buildDecomposePrompt(
        instruction: string,
        title: string,
        description: string,
        knowledge: ProjectKnowledge | undefined,
        conventions: string[],
        priorContext: string,
        northStar: string,
        manifestContext: string | undefined,
        taskCap: number,
        environment: EnvironmentPlanning,
        visionItems: readonly VisionItem[],
    ): string {
        const positiveConventions = conventions.map((c) => this.ensurePositiveFraming(c));
        const jsonFormat = '{"tasks": [{"ref": "t1", "title": "...", "description": "...", "successCriteria": ["..."], "dependsOn": ["t0"], "goal": "...", "endState": "...", "scope": "...", "deliverables": ["..."], "visionItems": ["S1"]}]}';

        const lines = [
            `${instruction}.`,
            ``,
            `Title: ${title}`,
            `Description: ${description}`,
        ];

        // Carries any answers/assumptions captured during alignment (ADR-019)
        // into the decomposition prompt itself, not just onto the output
        // epic's `northStar` field.
        if (northStar && northStar.trim().length > 0) {
            lines.push(`North Star: ${northStar}`);
        }

        if (knowledge && knowledge.nodes.length > 0) {
            const labels = knowledge.nodes.map(n => `${n.label} (${n.kind})`).join(", ");
            lines.push(`Project Knowledge: ${labels}`);
        } else {
            lines.push(`Project Knowledge: none stated. Plan the work in terms of what the project must do; choose no implementation stack.`);
        }

        lines.push(
            `Conventions: ${positiveConventions.join("; ")}`,
            priorContext ?? "",
        );

        if (manifestContext && manifestContext.trim().length > 0) {
            lines.push(``, `Project manifest files found:`, manifestContext);
        }

        lines.push(
            ``,
            `Vision items (what the client asked for, each with its id):`,
            ...visionItems.map((item) => `- ${item.id}: ${item.text}`),
        );

        const examples = DECOMPOSITION_EXAMPLES;
        lines.push(
            ``,
            `Task Quality Requirements:`,
            `- In "visionItems", list the ids of the vision items above that the task delivers, at least one. Plan no behavior that no vision item asks for: a task that names no vision item, or names an id not listed above, is rejected.`,
            `- Emit at most ${taskCap} tasks. A response with more is rejected, not truncated: merge related work instead.`,
            `- Each task title must be a specific, actionable verb phrase (e.g., ${examples.titleExample}) not generic (e.g., "Implement functionality").`,
            `- Describe each task by what the product does when it is finished, in the client's terms.`,
            `- successCriteria are observable outcomes a user of the product could confirm (e.g., ${examples.successExample}).`,
            `- endState, scope and deliverables are required for every task; a task missing any of them is rejected.`,
            `- deliverables are observable outcomes (e.g., ${examples.deliverablesExample}), not generic descriptions.`,
            `- endState must be an observable condition (e.g., ${examples.endStateExample}) not vague ("complete", "done", "works").`,
            `- scope names the part of the product the task covers (e.g., ${examples.scopeExample}) not "the project".`,
            `- Give each task a short unique "ref" (e.g. "t1", "auth-mw"). In "dependsOn", list ONLY the "ref" values of OTHER tasks in THIS response that must complete first. Never paraphrase a title, never invent an id. A "dependsOn" entry that names no "ref" in this response is invalid.`,
            environment.kind === "new"
                ? `- The project environment, including its technology choices, is set up once by a separate first task before these, outside this decomposition. Plan only the product's behavior here.`
                : `- The project environment, including its technology choices, is already set up and stays as it is. Plan only the product's behavior here.`,
            `- Each task must be a complete vertical slice: build the behavior AND make it reachable by the product's users in the same task. Do not create a separate "wiring" or "integration" task. Example: "${examples.verticalSliceExample}"`,
        );

        lines.push(
            ``,
            `IMPORTANT: Respond with ONLY valid JSON, no markdown, no explanation, no code fences.`,
            `Use exactly this format: ${jsonFormat}`,
        );

        return lines.join("\n");
    }


}

// Stack-free on purpose: nothing here names a file, a path, a command or a
// technology, because the stack is chosen in Sprint 0, after this plan.
interface ContextExamples {
    readonly titleExample: string;
    readonly successExample: string;
    readonly deliverablesExample: string;
    readonly endStateExample: string;
    readonly scopeExample: string;
    readonly verticalSliceExample: string;
}

const DECOMPOSITION_EXAMPLES: ContextExamples = {
    titleExample: '"Create the user registration feature with validation"',
    successExample: '"a visitor who registers with an email address already in use is told so and no second account exists"',
    deliverablesExample: '"a visitor can register with an email address and then sign in"',
    endStateExample: '"a registered user can sign in and sees their own account"',
    scopeExample: '"user registration and sign-in"',
    verticalSliceExample: "Build the registration behavior and make it reachable by visitors, end to end.",
};

const SPRINT0_TITLE = "Define and commit the project environment";

const SPRINT0_DESCRIPTION =
    "Define and commit the project environment, and nothing else: environment/environment.toml (owned paths, " +
    "containerfile, build and test commands) and the owned files it names, as the environment brief states them; " +
    "build it with build_environment and finish with a one-paragraph statement of the stack you chose and why. " +
    "The product's code, tests and data are later tasks' work.";

type PlannedTask = WorkItemSpec & { taskSpec: TaskSpec };

function bulleted(lines: readonly string[]): string {
    return lines.length === 0 ? "- (none stated)" : lines.map((line) => `- ${line}`).join("\n");
}

/**
 * The check task of one decomposed task (ADR-074 addendum 2 d63): the check author
 * writes the checks that decide whether it is done, after Sprint 0 and before any
 * implementation task of the plan starts (d67 a). Its text names no stack: the checks
 * are commands of the project environment. `checksFor` names the task its checks decide,
 * since every implementation task depends on every check task and the edges cannot say.
 */
function checkTaskFor(epicId: string, sprint0Id: string, task: DecomposedTask): PlannedTask {
    const goal =
        `Write the checks that decide whether "${task.title}" is done: observable behaviour from its deliverables ` +
        `and acceptance; each check is a command the project environment can run`;
    const description = [
        `${goal}.`,
        `Vision items "${task.title}" delivers (its checks may test only these, and the inputs they say to reject):\n` +
            bulleted(task.taskSpec.visionItems),
        `Deliverables of "${task.title}":\n${bulleted(task.taskSpec.deliverables)}`,
        `Acceptance of "${task.title}":\n${bulleted(task.successCriteria)}`,
    ].join("\n\n");
    const successCriteria = [
        "every check is defined with define_check",
        `every check fails on the project as it is now, because "${task.title}" is not done yet`,
    ];
    return {
        id: generateId("task"),
        level: "task",
        title: `Write the checks for "${task.title}"`,
        description,
        successCriteria,
        parentId: epicId,
        dependsOn: [sprint0Id],
        taskSpec: {
            goal: description,
            endState: successCriteria.join("; "),
            scope: `the checks of "${task.title}"`,
            deliverables: [
                `checks of "${task.title}", each defined with define_check as a command the project environment can run`,
                "the files those checks need",
            ],
            capability: "Strong",
            origin: "check",
            checksFor: task.id,
            visionItems: task.taskSpec.visionItems,
        },
    };
}

/**
 * The plan revision's review task (ADR-074 addendum 2 d71 c): after the last of its check tasks
 * completes and before any of its decomposed tasks is dispatched, a reviewer who wrote none of the
 * checks reads every stored suite together with the vision and names the checks no product can pass
 * together and the checks that test what no vision item asks for. It depends on every check task and
 * every decomposed task depends on it, so the gate does the ordering. Its vision items are every item.
 */
function reviewTaskFor(
    epicId: string,
    environmentId: string,
    checks: readonly PlannedTask[],
    visionItems: readonly VisionItem[],
): PlannedTask {
    const description = [
        `Read every check this plan's check tasks wrote, all together and with the vision, before any of the plan's ` +
            `work starts. Name every set of checks that no product could pass together, and every check that tests ` +
            `behaviour no vision item asks for.`,
        `Vision items:\n${bulleted(visionItems.map((item) => item.text))}`,
    ].join("\n\n");
    const successCriteria = [
        "every stored check of the plan was read with the vision",
        "every contradiction and every check outside the vision is named with the check task that wrote it",
    ];
    return {
        id: generateId("task"),
        level: "task",
        title: "Review the plan's checks together against the vision",
        description,
        successCriteria,
        parentId: epicId,
        dependsOn: [environmentId, ...checks.map((check) => check.id)],
        taskSpec: {
            goal: description,
            endState: successCriteria.join("; "),
            scope: "every check of this plan revision",
            deliverables: ["a structured review naming each problem, the check tasks involved and the evidence, or none"],
            capability: "Strong",
            origin: "review",
            visionItems: visionItems.map((item) => item.text),
        },
    };
}

/**
 * Adds the review task after every task of the plan: it depends on the environment task and on every
 * check task, and every decomposed task depends on it (beside its edges to every check task, d67 a).
 */
function addReviewTask(
    epicId: string,
    environmentId: string,
    tasks: readonly PlannedTask[],
    dependencyEdges: Array<{ from: string; to: string }>,
    visionItems: readonly VisionItem[],
): PlannedTask[] {
    const checks = tasks.filter((task) => task.taskSpec.origin === "check");
    const review = reviewTaskFor(epicId, environmentId, checks, visionItems);
    dependencyEdges.push({ from: review.id, to: environmentId });
    for (const check of checks) dependencyEdges.push({ from: review.id, to: check.id });
    for (const task of tasks.filter(isDecomposed)) dependencyEdges.push({ from: task.id, to: review.id });
    return [...tasks, review];
}

type DecomposedTask = WorkItemSpec & { taskSpec: DecomposedTaskSpec };

function isDecomposed(task: PlannedTask): task is DecomposedTask {
    return task.taskSpec.origin === "decomposition";
}

type VisionTrace =
    | { readonly kind: "traced"; readonly texts: string[] }
    | { readonly kind: "untraceable"; readonly error: UntraceableTaskError };

/**
 * The vision items a raw task names, each by its prompt id or its exact text, as their texts in the
 * vision's order. Untraceable when it names none, or names anything that is no item of the vision.
 */
function traceToVision(raw: RawTask, visionItems: readonly VisionItem[], parentId: string): VisionTrace {
    const named = raw.visionItems.map((entry) => entry.trim());
    const unknown = named.filter((entry) => !visionItems.some((item) => item.id === entry || item.text === entry));
    if (named.length === 0 || unknown.length > 0) {
        return {
            kind: "untraceable",
            error: new UntraceableTaskError({
                taskTitle: raw.title,
                unknown,
                availableIds: visionItems.map((item) => item.id),
                parentId,
            }),
        };
    }
    const texts = visionItems.filter((item) => named.includes(item.id) || named.includes(item.text)).map((item) => item.text);
    return { kind: "traced", texts };
}

/** Every planned task depends on the environment task already done; returns its id. */
function dependOnEnvironment(
    environmentTaskId: string,
    tasks: readonly PlannedTask[],
    dependencyEdges: Array<{ from: string; to: string }>,
): string {
    for (const task of tasks) dependencyEdges.push({ from: task.id, to: environmentTaskId });
    return environmentTaskId;
}

/**
 * Gives every decomposed task its check task, each depending on Sprint 0, and makes every
 * decomposed task depend on every check task of the plan (ADR-074 addendum 2 d67 a): all checks
 * are authored and red-run against main as Sprint 0 left it, before any implementation changes
 * it, as a QA team writes a sprint's acceptance tests up front. Each check task is placed right
 * after the task it decides, so the plan's writer meets that task before the reference to it.
 */
function addCheckTasks(
    epicId: string,
    sprint0Id: string,
    tasks: readonly PlannedTask[],
    dependencyEdges: Array<{ from: string; to: string }>,
): PlannedTask[] {
    const decomposed = tasks.filter(isDecomposed);
    const checkOf = new Map(decomposed.map((task) => [task.id, checkTaskFor(epicId, sprint0Id, task)]));
    for (const check of checkOf.values()) dependencyEdges.push({ from: check.id, to: sprint0Id });
    for (const task of decomposed) {
        for (const check of checkOf.values()) dependencyEdges.push({ from: task.id, to: check.id });
    }
    return tasks.flatMap((task) => {
        const check = checkOf.get(task.id);
        return check === undefined ? [task] : [task, check];
    });
}

/** Each `dependsOn` entry that names neither a sibling's `ref` nor its exact title. */
function unresolvedDependencies(rawTasks: readonly RawTask[]): DroppedDependency[] {
    const known = new Set<string>();
    for (const t of rawTasks) {
        if (t.ref) known.add(t.ref);
        known.add(t.title);
    }
    return rawTasks.flatMap((t) =>
        t.dependsOn.filter((dep) => !known.has(dep)).map((dep) => ({ dependentTaskTitle: t.title, unresolvedRef: dep })),
    );
}

let idCounter = 0;

function generateId(prefix: string): string {
    idCounter += 1;
    return `${prefix}-${idCounter.toString().padStart(4, "0")}`;
}

/** @testseam decomposition.test.ts restarts generated ids per case */
export function resetIdCounter(): void {
    idCounter = 0;
}
