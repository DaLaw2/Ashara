import { z, type ZodType } from "zod";
import type { ProjectKnowledge } from "@ashara/shared";
import { ProjectKnowledgeSchema } from "@ashara/shared";
import type { StructuredValidation } from "@ashara/llm-gateway";
import type {
    DecompositionConfig,
    DecompositionInput,
    DecompositionResult,
    PriorEpicResult,
    TaskSpec,
    WorkItemSpec,
} from "./decomposition-types.js";
import {
    DEFAULT_DECOMPOSITION_CONFIG,
    TaskCapExceededError,
    TaskOutputSchema,
    UnresolvableDependencyError,
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

    async decompose(input: DecompositionInput): Promise<DecompositionResult> {
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
        // client's stack. Development's ProjectFrame ladder handles that absence
        // explicitly (its contract-knowledge rung declines and records why).
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

        const tasks = await this.decomposeEpicIntoTasks(epic, knownInput);
        for (const task of tasks) {
            allTasks.push(task);
            for (const dep of task.dependsOn) {
                dependencyEdges.push({ from: task.id, to: dep });
            }
        }

        if (allTasks.length > 0) {
            this.ensureScaffoldTask(allTasks, dependencyEdges);
        }

        return {
            epic,
            tasks: allTasks,
            dependencyEdges,
            knowledge,
        };
    }

    /**
     * Guarantees exactly one project-level scaffold task exists whenever the decomposition
     * produces any tasks at all. The task prompt does not mandate a scaffold (see
     * buildDecomposePrompt), so it is created once here.
     *
     * There is no equivalent `ensureWiringTask` — wiring is not a separate task. Every
     * generated task is a vertical slice that mounts its own deliverable into the entry
     * point in the same session (see buildDecomposePrompt's Task Quality Requirements),
     * so no dedicated integration task exists to be starved by the dispatch queue.
     */
    private ensureScaffoldTask(
        tasks: Array<WorkItemSpec & { taskSpec: TaskSpec }>,
        dependencyEdges: Array<{ from: string; to: string }>,
    ): void {
        if (tasks.length === 0) return;

        const scaffoldId = generateId("task");
        const description = `Initialize the project with the correct manifest file, entry point, and directory structure for its tech stack. Install dependencies. Create a verify.toml at the project root with a [checks] section listing the verification commands for this project. All other tasks depend on this.`;
        const successCriteria = ["Project installs dependencies and starts with the scaffold in place", "verify.toml exists with at least one check entry"];
        const scaffoldTask: WorkItemSpec & { taskSpec: TaskSpec } = {
            id: scaffoldId,
            level: "task",
            title: `Create project scaffold: manifest, entry point, directory structure`,
            // Names NO stack (ADR-046): the ProjectFrame carries the target and is
            // rendered ahead of the task, so restating it in an LLM-authored
            // description can only duplicate it — or, when derivation was weak,
            // contradict it with the model's default (ADR-045's prescriptive drift).
            description,
            successCriteria,
            parentId: tasks[0].parentId,
            dependsOn: [],
            taskSpec: {
                goal: description,
                endState: successCriteria.join("; "),
                scope: "The project root: its manifest, entry point, directory structure and verify.toml",
                deliverables: ["The project manifest", "The entry point", "verify.toml with a [checks] section"],
                checks: [],
                capability: "Strong",
                origin: "scaffold",
            },
        };

        for (const task of tasks) {
            dependencyEdges.push({ from: task.id, to: scaffoldId });
        }
        tasks.unshift(scaffoldTask);
    }

    /**
     * PURE pre-check (mig-run10) run inside the reliability ladder's attempt, so
     * an over-cap emission or a phantom `dependsOn` ref is re-asked with this
     * feedback rather than accepted. It mirrors {@link resolveTasks}'s failure
     * checks without assigning ids (generateId runs once, after this passes).
     */
    private validateTasks(rawTasks: readonly RawTask[], cap: number, parentId: string): StructuredValidation {
        if (rawTasks.length > cap) {
            return { ok: false, errors: [new TaskCapExceededError({ emitted: rawTasks.length, cap, parentId }).message] };
        }
        const refs = new Set<string>();
        const titles = new Set<string>();
        for (const t of rawTasks) {
            if (t.ref) refs.add(t.ref);
            titles.add(t.title);
        }

        const errors: string[] = [];
        for (const t of rawTasks) {
            for (const dep of t.dependsOn) {
                if (refs.has(dep) || titles.has(dep)) continue;
                errors.push(
                    new UnresolvableDependencyError({
                        dependentTaskTitle: t.title,
                        unresolvedRef: dep,
                        availableRefs: [...refs],
                        availableTitles: [...titles],
                        parentId,
                    }).message,
                );
            }
        }
        return errors.length === 0 ? { ok: true } : { ok: false, errors };
    }

    /**
     * Turns raw LLM tasks into task specs with deterministically resolved, stable
     * inter-task edges (G3). Each task is assigned a synthetic id; every
     * `dependsOn` entry is resolved to that id by `ref` first (primary), then
     * exact `title` (legacy fallback). Over-cap output and a dependency on
     * something never emitted both fail closed, so nothing the model produced is
     * dropped. This holds even for an LLM that ignores `validate`.
     */
    private resolveTasks(
        rawTasks: readonly RawTask[],
        cap: number,
        parentId: string,
    ): Array<WorkItemSpec & { taskSpec: TaskSpec }> {
        if (rawTasks.length > cap) {
            throw new TaskCapExceededError({ emitted: rawTasks.length, cap, parentId });
        }

        const refToId = new Map<string, string>();
        const titleToId = new Map<string, string>();
        const assigned = rawTasks.map((raw) => {
            const id = generateId("task");
            if (raw.ref) refToId.set(raw.ref, id);
            // First-writer-wins on duplicate titles so an edge resolves to the
            // earliest task with that title rather than being clobbered.
            if (!titleToId.has(raw.title)) titleToId.set(raw.title, id);
            return { raw, id };
        });

        return assigned.map(({ raw, id }) => ({
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
                checks: raw.checks,
                capability: "Strong",
                origin: "decomposition",
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
    ): Promise<Array<WorkItemSpec & { taskSpec: TaskSpec }>> {
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
        );

        const parsed = await this.llm.generateStructured(
            prompt,
            TaskOutputSchema,
            (value) => this.validateTasks(value.tasks, taskCap, epic.id),
        );
        return this.resolveTasks(parsed.tasks, taskCap, epic.id);
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
    ): string {
        const positiveConventions = conventions.map((c) => this.ensurePositiveFraming(c));
        const jsonFormat = '{"tasks": [{"ref": "t1", "title": "...", "description": "...", "successCriteria": ["..."], "dependsOn": ["t0"], "goal": "...", "endState": "...", "scope": "...", "deliverables": ["..."], "checks": ["..."]}]}';

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

        const examples = DECOMPOSITION_EXAMPLES;
        lines.push(
            ``,
            `Task Quality Requirements:`,
            `- Emit at most ${taskCap} tasks. A response with more is rejected, not truncated: merge related work instead.`,
            `- Each task title must be a specific, actionable verb phrase (e.g., ${examples.titleExample}) not generic (e.g., "Implement functionality").`,
            `- Description must name concrete files or modules to create or modify.`,
            `- successCriteria must include at least one executable verification (e.g., ${examples.checksExample}).`,
            `- endState, scope and deliverables are required for every task; a task missing any of them is rejected.`,
            `- deliverables must list specific file paths (e.g., ${examples.deliverablesExample}) not generic descriptions.`,
            `- endState must be an observable condition (e.g., ${examples.endStateExample}) not vague ("complete", "done", "works").`,
            `- scope must name specific directories or modules (e.g., ${examples.scopeExample}) not "the project".`,
            `- checks must include at least one runnable command to verify completion (e.g., ${examples.checksExample}).`,
            `- Give each task a short unique "ref" (e.g. "t1", "auth-mw"). In "dependsOn", list ONLY the "ref" values of OTHER tasks in THIS response that must complete first. Never paraphrase a title, never invent an id. A "dependsOn" entry that names no "ref" in this response is invalid.`,
            `- Do not create a project scaffold (manifest, entry point, directory structure) as a separate task — that is a project-level task created once, outside this decomposition.`,
            `- Each task must be a complete vertical slice: implement the feature AND make it reachable from the project's entry point, in whatever way the project's own structure requires, in the same task. Do not create a separate "wiring" or "integration" task — every task self-integrates by editing the entry point itself. Example: "${examples.verticalSliceExample}"`,
        );

        lines.push(
            ``,
            `IMPORTANT: Respond with ONLY valid JSON, no markdown, no explanation, no code fences.`,
            `Use exactly this format: ${jsonFormat}`,
        );

        return lines.join("\n");
    }


}

interface ContextExamples {
    readonly titleExample: string;
    readonly deliverablesExample: string;
    readonly endStateExample: string;
    readonly scopeExample: string;
    readonly checksExample: string;
    readonly verticalSliceExample: string;
}

const DECOMPOSITION_EXAMPLES: ContextExamples = {
    titleExample: '"Create the user registration feature with validation"',
    deliverablesExample: '"the relevant source files for this feature"',
    endStateExample: '"the feature works as specified and passes verification"',
    scopeExample: "\"the directories containing this feature's source files\"",
    checksExample: "\"the project's build and test commands pass\"",
    verticalSliceExample: "Implement the feature, wire it into the entry point, and verify it works end-to-end.",
};

let idCounter = 0;

function generateId(prefix: string): string {
    idCounter += 1;
    return `${prefix}-${idCounter.toString().padStart(4, "0")}`;
}

/** @testseam decomposition.test.ts restarts generated ids per case */
export function resetIdCounter(): void {
    idCounter = 0;
}
