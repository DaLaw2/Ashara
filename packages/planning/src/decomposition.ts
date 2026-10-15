import { z, type ZodType } from "zod";
import type { CapabilityLevel } from "@ashara/shared";
import { PUBLIC_INTERFACE_FILE, visionSourceLine } from "@ashara/shared";
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
    TracedLine,
    UntracedLine,
    VisionItem,
    WorkItemSpec,
} from "./decomposition-types.js";
import {
    citable,
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

        const { tasks, droppedDependencies } = await this.decomposeEpicIntoTasks(epic, input);
        for (const task of tasks) {
            allTasks.push(task);
            for (const dep of task.dependsOn) {
                dependencyEdges.push({ from: task.id, to: dep });
            }
        }

        // decomposeEpicIntoTasks never returns an empty list (TaskOutputSchema
        // requires one task), so every plan carries its Sprint 0, or depends on the
        // one already done. A plan with no product layout yet then sets it up before
        // any check is written (ADR-074 addendum 2 d72 B2); one whose layout a
        // completed scaffold set up builds on it.
        const environmentId =
            input.environment.kind === "new"
                ? this.ensureSprint0Task(epic.id, allTasks, dependencyEdges)
                : dependOnEnvironment(input.environment.taskId, allTasks, dependencyEdges);
        // A revision on a layout already merged red-runs its checks on that layout's latest merged
        // state (layout.taskId), never on an environment task merged before it (W11 D2); a new
        // environment task of the revision lands on that state, so it is the foundation then.
        const foundationId =
            input.layout.kind === "new"
                ? addProductScaffold(epic.id, environmentId, allTasks, dependencyEdges)
                : input.environment.kind === "new"
                  ? environmentId
                  : input.layout.taskId;
        const plannedTasks = addReviewTask(
            epic.id,
            foundationId,
            addCheckTasks(epic.id, foundationId, allTasks, dependencyEdges),
            dependencyEdges,
            input.visionItems,
        );

        return {
            epic,
            tasks: plannedTasks,
            dependencyEdges,
            droppedDependencies,
        };
    }

    /**
     * Adds the plan's one Sprint 0 task (ADR-074 addendum 2 d62-d63, d72 S): the
     * environment role writes the recipe of the project environment, choosing the
     * stack, before any other task runs, so every other task depends on it. Its text
     * names no stack: choosing one is the task's own work. It carries no checks of
     * its own; the environment substrate checks it by building the image and running
     * the toolchain probe, never the product's build or test, since no product exists.
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
            "the work touches recipe files only",
            "the image builds from the recipe",
            "the probe passes in a cell from that image, printing output",
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
                scope: "environment/environment.toml and the recipe files it names; no product file of any kind",
                deliverables: [
                    "environment/environment.toml naming the containerfile, the recipe files, the inputs, and the probe, build and test commands",
                    "the recipe files environment/environment.toml names",
                    "a one-paragraph statement of the stack chosen and why, given as finish's statement",
                ],
                capability: PLANNER_SET_LEVEL,
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
            return { raw, id, traced };
        });

        return assigned.map(({ raw, id, traced }) => ({
            id,
            level: "task" as const,
            title: raw.title,
            description: raw.description,
            successCriteria: traced.acceptance.map((line) => line.line),
            parentId,
            dependsOn: this.resolveDependsOn(raw, id, refToId, titleToId, parentId),
            taskSpec: {
                goal: raw.goal || raw.description || raw.title,
                endState: raw.endState,
                scope: raw.scope,
                deliverables: raw.deliverables.map((deliverable) => deliverable.text),
                capability: raw.capability,
                capabilityReason: raw.capabilityReason,
                origin: "decomposition" as const,
                visionItems: traced.sources.map((item) => item.text),
                sources: traced.sources,
                acceptance: traced.acceptance,
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
            priorContext,
            input.epicNorthStar,
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
        priorContext: string,
        northStar: string,
        taskCap: number,
        environment: EnvironmentPlanning,
        visionItems: readonly VisionItem[],
    ): string {
        const jsonFormat = '{"tasks": [{"ref": "t1", "title": "...", "description": "...", "dependsOn": ["t0"], "goal": "...", "endState": "...", "scope": "...", "deliverables": [{"text": "...", "sources": ["S1"]}], "acceptance": [{"text": "...", "sources": ["S1", "A2"]}], "capability": "Medium", "capabilityReason": "..."}]}';

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

        lines.push(
            `Plan the work in terms of what the project must do; choose no implementation stack the vision items below do not state.`,
            priorContext,
        );

        lines.push(
            ``,
            `Vision items (what the client asked for, each with its id). A scope line or a client-visible assumption may be cited; an internal-design assumption is how the team builds the product, guidance for its implementer that no deliverable or acceptance line cites:`,
            ...visionItems.map((item) => `- ${visionSourceLine(item)}`),
        );

        const examples = DECOMPOSITION_EXAMPLES;
        lines.push(
            ``,
            `Task Quality Requirements:`,
            `- Every deliverable and every acceptance line names in "sources" the ids of the citable vision items above it serves, at least one each. A line that names no item, names an id not listed above, or names an internal-design assumption is rejected. Plan no behavior that no citable item asks for, and write no line that uses an assumption it does not name: the items a task delivers are exactly those its lines name.`,
            `- "acceptance" lines decide the task done: each is an observable outcome a user of the product could confirm (e.g., ${examples.successExample}), and the task's checks test each line against the items it names.`,
            `- Emit at most ${taskCap} tasks. A response with more is rejected, not truncated: merge related work instead.`,
            `- Each task title must be a specific, actionable verb phrase (e.g., ${examples.titleExample}) not generic (e.g., "Implement functionality").`,
            `- Describe each task by what the product does when it is finished, in the client's terms.`,
            `- endState, scope, deliverables and acceptance are required for every task; a task missing any of them is rejected.`,
            `- deliverables are observable outcomes (e.g., ${examples.deliverablesExample}), not generic descriptions.`,
            `- endState must be an observable condition (e.g., ${examples.endStateExample}) not vague ("complete", "done", "works").`,
            `- scope names the part of the product the task covers (e.g., ${examples.scopeExample}) not "the project".`,
            `- Give each task a short unique "ref" (e.g. "t1", "auth-mw"). In "dependsOn", list ONLY the "ref" values of OTHER tasks in THIS response that must complete first. Never paraphrase a title, never invent an id. A "dependsOn" entry that names no "ref" in this response is invalid.`,
            environment.kind === "new"
                ? `- The project environment, including its technology choices, is set up once by a separate first task before these, outside this decomposition. Plan only the product's behavior here.`
                : `- The project environment, including its technology choices, is already set up and stays as it is. Plan only the product's behavior here.`,
            `- Each task must be a complete vertical slice: build the behavior AND make it reachable by the product's users in the same task. Do not create a separate "wiring" or "integration" task. Example: "${examples.verticalSliceExample}"`,
            `- Each task is a small, complete behaviour a user can use and observe end to end, never a layer or a stage of processing. Do not split the work into steps such as reading the input, parsing it, computing and printing the output: none of them is usable alone, and each could only be confirmed through the final output. Example: "${examples.sliceSequenceExample}"`,
            ...CAPABILITY_GRADING,
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
    readonly sliceSequenceExample: string;
}

const DECOMPOSITION_EXAMPLES: ContextExamples = {
    titleExample: '"Create the user registration feature with validation"',
    successExample: '"a visitor who registers with an email address already in use is told so and no second account exists"',
    deliverablesExample: '"a visitor can register with an email address and then sign in"',
    endStateExample: '"a registered user can sign in and sees their own account"',
    scopeExample: '"user registration and sign-in"',
    verticalSliceExample: "Build the registration behavior and make it reachable by visitors, end to end.",
    sliceSequenceExample:
        "for a product that turns an input into one report, the first task produces the report for the simplest valid " +
        "input from end to end; each later task adds one more case the report covers, or one kind of input it refuses " +
        "with a message, again from end to end.",
};

/**
 * How the planner grades a task (ADR-074 addendum 2 d70): by the difficulty of the work alone, never
 * by its language, stack or kind of product, since the same grade must mean the same thing for every
 * project. The grade picks the cheapest model at or above it; the escalation on failed attempts
 * stays the safety net for a task graded too low.
 */
const CAPABILITY_GRADING: readonly string[] = [
    `- Grade every task's difficulty in "capability", one of Light, Medium, Strong, Frontier, and say why in one sentence in "capabilityReason". Judge the work, not its technology:`,
    `  - Light: a small, fully specified change with one obvious way to do it, confined to one part of the product.`,
    `  - Medium: a well-specified behavior within one part of the product, with a few design choices that its success criteria settle.`,
    `  - Strong: a behavior whose design must be worked out, that spans several parts of the product, or whose requirements leave real ambiguity to resolve.`,
    `  - Frontier: a broad or novel design problem, a change cutting across most of the product, or one where a subtle mistake is likely and costly.`,
    `- Grade honestly rather than high: a task that turns out harder than graded is retried at a higher level, while a task graded too high spends more on every attempt.`,
];

/**
 * The level of every task the plan adds itself (Sprint 0, the product scaffold, the suite review):
 * a planner policy, not a grade (ADR-074 addendum 2 d70). Sprint 0 chooses the stack for the whole
 * product and the scaffold lays out its structure, both before any behaviour exists to judge
 * difficulty by; the review's own call routes at its own level, so this level only labels it.
 */
const PLANNER_SET_LEVEL: CapabilityLevel = "Strong";

/**
 * A check task's level (ADR-074 addendum 2 d70): its checks are the verdict on the task they decide,
 * so they are written at no lower level than that task's grade, and never below Strong, since a weak
 * suite passes weak work whatever the implementation's level.
 */
function checkLevelFor(decided: CapabilityLevel): CapabilityLevel {
    return decided === "Frontier" ? "Frontier" : "Strong";
}

const SPRINT0_TITLE = "Define and commit the project environment";

const SPRINT0_DESCRIPTION =
    "Define and commit the project environment's recipe, and nothing else: environment/environment.toml " +
    "(containerfile, recipe files, inputs, probe, build and test commands) and the recipe files it names, as the " +
    "environment brief states them; build it with build_environment and finish with a one-paragraph statement of " +
    "the stack you chose and why. The product's layout, manifests, code, tests and data are later tasks' work.";

const SCAFFOLD_TITLE = "Set up the product's layout";

const SCAFFOLD_DESCRIPTION =
    "Set up the product's skeleton in the environment the platform role defined: its module root, its manifests " +
    "and its entry point, laid out so that the environment's build and test commands pass from the repository root " +
    "on a fresh checkout and leave it clean. " +
    `Write down the product's public interface in ${PUBLIC_INTERFACE_FILE} at the repository root: the one interface ` +
    "the product commits to, which every later task implements and every check tests. Name each way the vision says " +
    "the product is used, in the terms its kind has (each command with its arguments and exit statuses, each network " +
    "route with its request and response shapes and statuses, each function or type of a library's API, or whatever " +
    "else the product exposes), how it is started and configured (arguments, environment variables, the files it " +
    "reads and writes, a port), and the error each entry gives for input it refuses. Choose one form for each: never " +
    "alternatives. Where an assumption marked internal design fixes part of what the product exposes (a command's " +
    "name, a file the client reads), write it into the interface as that assumption states it; the other " +
    "internal-design assumptions are how later tasks build the product, not part of its interface. Implement none " +
    "of the behaviour the vision asks for: each later task delivers its own, and its checks are written against " +
    "this layout and this interface. The product is a placeholder of the interface: it " +
    "starts and runs exactly as the interface says, and answers every entry of the interface with a refusal (an error " +
    "response, a non-zero exit status, a raised error, as the entry's kind has) saying the product does not do that " +
    "yet, so that a check of any behaviour fails on it because the behaviour is missing, never because the product " +
    "could not start. A product that runs as a long-lived process starts, stays up and answers each request with that " +
    "refusal until it is stopped. Say in your finish summary where the entry point is and how the product is run.";

type PlannedTask = WorkItemSpec & { taskSpec: TaskSpec };

/**
 * Adds the product scaffold after Sprint 0 (ADR-074 addendum 2 d72 B2): the implementer role sets up
 * the product's module root, manifests and entry point, so that the layout every check names is the
 * product's, never one the environment role supplied. It depends on Sprint 0; the check tasks, the
 * review and every decomposed task depend on it. It traces to the vision items of every decomposed
 * task, whose work it enables, and delivers none of them alone. Z0 checks it by the definition's own
 * build and test on its merge: a check task could only be written against a layout that does not
 * exist yet. Returns its id.
 */
function addProductScaffold(
    epicId: string,
    sprint0Id: string,
    tasks: Array<WorkItemSpec & { taskSpec: TaskSpec }>,
    dependencyEdges: Array<{ from: string; to: string }>,
): string {
    const decomposed = tasks.filter(isDecomposed);
    const visionItems = [...new Set(decomposed.flatMap((task) => task.taskSpec.visionItems))];
    const successCriteria = [
        "the environment's build then test commands pass on a fresh checkout of the merge, test printing output",
        "build and test leave the checkout clean",
        "the work changes no recipe file",
        "no behaviour a vision item asks for is implemented yet",
        `${PUBLIC_INTERFACE_FILE} at the repository root names one form for each entry of the product's public interface, ` +
            "how the product is started and configured, and the error each entry gives",
        "the product starts as the interface says and answers every entry of it with a refusal (an error response or " +
            "a non-zero exit status), never failing to start",
    ];
    const scaffold: PlannedTask = {
        id: generateId("task"),
        level: "task",
        title: SCAFFOLD_TITLE,
        description: SCAFFOLD_DESCRIPTION,
        successCriteria,
        parentId: epicId,
        dependsOn: [sprint0Id],
        taskSpec: {
            goal: SCAFFOLD_DESCRIPTION,
            endState: successCriteria.join("; "),
            scope: `the product's module root, manifests, entry point and ${PUBLIC_INTERFACE_FILE}; no behaviour of the vision`,
            deliverables: [
                "the product's skeleton, on which the environment's build and test commands pass",
                `${PUBLIC_INTERFACE_FILE}: the product's public interface, one form for each entry`,
                "a placeholder that starts as the interface says and refuses every entry of it",
                "a finish summary naming the entry point and how the product is run",
            ],
            capability: PLANNER_SET_LEVEL,
            origin: "product-scaffold",
            checkedBy: "substrate",
            visionItems,
        },
    };
    dependencyEdges.push({ from: scaffold.id, to: sprint0Id });
    for (const task of decomposed) dependencyEdges.push({ from: task.id, to: scaffold.id });
    // Right after Sprint 0 when the plan holds it; first when it builds on an environment already done.
    const sprint0At = tasks.findIndex((task) => task.id === sprint0Id);
    tasks.splice(sprint0At + 1, 0, scaffold);
    return scaffold.id;
}

function bulleted(lines: readonly string[]): string {
    return lines.length === 0 ? "- (none stated)" : lines.map((line) => `- ${line}`).join("\n");
}

/**
 * The check task of one decomposed task (ADR-074 addendum 2 d63): the check author
 * writes the checks that decide whether it is done, after the plan's foundation (the
 * product scaffold, or a revision's latest merged layout or new environment, d72 B2) and before any
 * implementation task of the plan starts (d67 a). Its text names no stack: the checks
 * are commands of the project environment. `checksFor` names the task its checks decide,
 * since every implementation task depends on every check task and the edges cannot say.
 */
function checkTaskFor(epicId: string, foundationId: string, task: DecomposedTask): PlannedTask {
    const goal =
        `Write the checks that decide whether "${task.title}" is done: the observable behaviour its acceptance lines ` +
        `ask for, each tested against the vision items it cites; each check is a command the project environment can run`;
    const description = [
        `${goal}.`,
        `Vision items "${task.title}" cites (its checks may test only what these ask for, and the inputs they say to ` +
            `reject):\n${bulleted(task.taskSpec.sources.map(visionSourceLine))}`,
        `Acceptance of "${task.title}", each line with the items it serves:\n` +
            bulleted(task.taskSpec.acceptance.map((line) => `[${line.sources.join(", ")}] ${line.line}`)),
        `Deliverables of "${task.title}", for context:\n${bulleted(task.taskSpec.deliverables)}`,
        `Read the product's public interface in ${PUBLIC_INTERFACE_FILE} at the repository root before writing any ` +
            "check, and test the product only through that interface, in the one form it names: never try other ways " +
            "to start, configure or call the product. On the foundation the product starts and refuses every entry, " +
            `so each check must fail there because "${task.title}" is not done, never because the product did not ` +
            `start. If ${PUBLIC_INTERFACE_FILE} is missing, or does not name what a check needs, say so in your ` +
            "finish summary.",
    ].join("\n\n");
    const successCriteria = [
        "every check is defined with define_check",
        `at least one check fails on the plan's foundation, because "${task.title}" is not done there`,
    ];
    return {
        id: generateId("task"),
        level: "task",
        title: `Write the checks for "${task.title}"`,
        description,
        successCriteria,
        parentId: epicId,
        dependsOn: [foundationId],
        taskSpec: {
            goal: description,
            endState: successCriteria.join("; "),
            scope: `the checks of "${task.title}"`,
            deliverables: [
                `checks of "${task.title}", each defined with define_check as a command the project environment can run`,
                "the files those checks need",
            ],
            capability: checkLevelFor(task.taskSpec.capability),
            origin: "check",
            checksFor: task.id,
            visionItems: task.taskSpec.visionItems,
            sources: task.taskSpec.sources,
            acceptance: task.taskSpec.acceptance,
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
            `behaviour none of the vision items its own task cites asks for.`,
        `Vision items:\n${bulleted(visionItems.map(visionSourceLine))}`,
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
            capability: PLANNER_SET_LEVEL,
            origin: "review",
            visionItems: visionItems.map((item) => item.text),
            sources: [...visionItems],
        },
    };
}

/**
 * Adds the review task after every task of the plan: it depends on the plan's foundation (the product
 * scaffold, or a revision's latest merged layout or new environment task) and on every check task, and every decomposed task
 * depends on it (beside its edges to every check task, d67 a).
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
    | {
          readonly kind: "traced";
          /** The union of every line's sources, in the vision's order. */
          readonly sources: VisionItem[];
          readonly acceptance: TracedLine[];
      }
    | { readonly kind: "untraceable"; readonly error: UntraceableTaskError };

/**
 * The vision items a raw task's deliverables and acceptance lines cite (ADR-074 addendum 2 d89 A), each
 * by its id or its exact text. Untraceable when a line cites none, cites anything that is no item of
 * the vision, or cites an item no line may cite (d89 E): an internal-design or unclassified
 * assumption. The task's traced items are then exactly the union of what its lines cite.
 */
function traceToVision(raw: RawTask, visionItems: readonly VisionItem[], parentId: string): VisionTrace {
    const lookup = (entry: string) => visionItems.find((item) => item.id === entry || item.text === entry);
    const problems: UntracedLine[] = [];
    const cited = new Set<string>();
    const lineIds = (field: "deliverable" | "acceptance", line: { readonly text: string; readonly sources: readonly string[] }) => {
        const ids: string[] = [];
        if (line.sources.length === 0) problems.push({ field, text: line.text, problem: "no-source" });
        for (const source of line.sources.map((entry) => entry.trim())) {
            const item = lookup(source);
            if (item === undefined) problems.push({ field, text: line.text, problem: "unknown", source });
            else if (item.type === "assumption" && item.kind !== "client-visible") {
                problems.push({ field, text: line.text, problem: "not-citable", source: item.id, kind: item.kind });
            } else if (!ids.includes(item.id)) ids.push(item.id);
        }
        for (const id of ids) cited.add(id);
        return ids;
    };
    for (const deliverable of raw.deliverables) lineIds("deliverable", deliverable);
    const acceptance = raw.acceptance.map((line) => ({ line: line.text, sources: lineIds("acceptance", line) }));
    if (problems.length > 0) {
        return {
            kind: "untraceable",
            error: new UntraceableTaskError({
                taskTitle: raw.title,
                lines: problems,
                citableIds: visionItems.filter(citable).map((item) => item.id),
                parentId,
            }),
        };
    }
    return { kind: "traced", sources: visionItems.filter((item) => cited.has(item.id)), acceptance };
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
 * Gives every decomposed task its check task, each depending on the plan's foundation (the product
 * scaffold of a new project, d72 B2, or a revision's latest merged layout or new environment task), and makes every
 * decomposed task depend on every check task of the plan (ADR-074 addendum 2 d67 a): all checks
 * are authored before any implementation starts, as a QA team writes a sprint's acceptance tests up
 * front, and every authoring is red-run against the foundation's recorded merge (d74 A). Each check task is placed
 * right after the task it decides, so the plan's writer meets that task before the reference to it.
 */
function addCheckTasks(
    epicId: string,
    foundationId: string,
    tasks: readonly PlannedTask[],
    dependencyEdges: Array<{ from: string; to: string }>,
): PlannedTask[] {
    const decomposed = tasks.filter(isDecomposed);
    const checkOf = new Map(decomposed.map((task) => [task.id, checkTaskFor(epicId, foundationId, task)]));
    for (const check of checkOf.values()) dependencyEdges.push({ from: check.id, to: foundationId });
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
