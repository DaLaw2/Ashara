import { z, type ZodType } from "zod";

import type { CapabilityLevel, ProjectKnowledge } from "@ashara/shared";
import { ProjectKnowledgeSchema, nodeLabels } from "@ashara/shared";
import type { StructuredValidation } from "@ashara/llm-gateway";

import type {
    DecompositionConfig,
    DecompositionInput,
    DecompositionResult,
    ExistingWorkItemSummary,
    PriorEpicResult,
    TaskSpec,
    WorkItemSpec,
} from "./decomposition-types.js";
import {
    DEFAULT_DECOMPOSITION_CONFIG,
    TaskOutputSchema,
    UnresolvableDependencyError,
} from "./decomposition-types.js";

export interface DecompositionLLM {
    /**
     * `validate` (mig-run10) is an optional post-parse SEMANTIC check run INSIDE
     * the reliability ladder attempt: a `false` verdict (e.g. a phantom
     * `dependsOn` ref) is a retryable failure whose feedback is re-asked and
     * escalated, so one malformed emission is corrected on retry rather than
     * exploding the whole decomposition. A stub/unladdered LLM may ignore it.
     */
    generateStructured<T>(
        prompt: string,
        schema: ZodType<T, z.ZodTypeDef, any>,
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

export function inferCapability(_task: { title: string; description?: string; level: string }): CapabilityLevel {
    return "Strong";
}

/**
 * SEMANTIC gate on the derived knowledge graph, run inside the reliability
 * ladder's attempt so a barren answer is RE-ASKED instead of accepted (ADR-046).
 * `{"nodes":[],"edges":[]}` parses cleanly against ProjectKnowledgeSchema, so
 * without this the very first attempt was taken as the project's answer — and a
 * graph with no language and no runtime says nothing about what to build, which
 * every downstream reader then fills in from its own prior.
 */
function validateKnowledgeGraph(graph: ProjectKnowledge): StructuredValidation {
    const stated = nodeLabels(graph, "language").length > 0 || nodeLabels(graph, "runtime").length > 0;
    if (stated) return { ok: true };
    return {
        ok: false,
        errors: [
            `The knowledge graph names neither a "language" nor a "runtime" node ` +
                `(${graph.nodes.length} node(s): ${graph.nodes.map((n) => `${n.kind}=${n.label}`).join(", ") || "none"}). ` +
                `The project's implementation language is stated or implied by the vision — emit it.`,
        ],
    };
}

export class DecompositionEngine {
    private readonly llm: DecompositionLLM | null;
    private readonly config: DecompositionConfig;

    constructor(llm: DecompositionLLM | null, config?: Partial<DecompositionConfig>) {
        this.llm = llm;
        this.config = { ...DEFAULT_DECOMPOSITION_CONFIG, ...config };
    }

    async decompose(input: DecompositionInput): Promise<DecompositionResult> {
        if (!this.llm) {
            console.warn("[DecompositionEngine] No LLM configured — skipping decomposition");
            return this.emptyResult(input);
        }
        return this.decomposeInternal(input);
    }

    private get requiredLlm(): DecompositionLLM {
        if (!this.llm) throw new Error("DecompositionEngine: LLM required but not configured");
        return this.llm;
    }

    private emptyResult(input: DecompositionInput): DecompositionResult {
        const epicId = generateId("epic");
        return {
            epic: {
                id: epicId,
                level: "epic",
                title: input.epicTitle,
                description: input.epicDescription,
                northStar: input.epicNorthStar,
                successCriteria: [],
                dependsOn: [],
            },
            stories: [],
            features: [],
            tasks: [],
            dependencyEdges: [],
        };
    }

    generateTaskSpec(task: WorkItemSpec, context: DecompositionInput): TaskSpec {
        const priorWorkPointers = task.dependsOn.length > 0
            ? task.dependsOn
            : context.priorEpicResults?.map((r) => r.epicId) ?? [];

        return {
            goal: task.goal || task.description || task.title,
            endState: task.endState || this.deriveObservableEndState(task),
            scope: task.scope || this.deriveScope(task),
            deliverables: task.deliverables && task.deliverables.length > 0
                ? task.deliverables
                : this.deriveDeliverables(task),
            checks: task.checks && task.checks.length > 0 ? task.checks : this.deriveChecks(task, context),
            priorWorkPointers,
            capability: inferCapability(task),
        };
    }

    ensurePositiveFraming(text: string): string {
        return POSITIVE_FRAMING_RULES.reduce((result, [pattern, replacement]) => result.replace(pattern, replacement), text);
    }

    async deriveKnowledge(
        visionTitle: string,
        visionDescription: string,
        northStar?: string,
        manifestContext?: string,
    ): Promise<ProjectKnowledge | undefined> {
        if (!this.llm) return undefined;

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
            `Produce nodes for any of these kinds that apply: language, runtime, framework, database, subsystem, entry_point, check, build_tool.`,
            `- entry_point nodes MUST have meta.mountKind set to "http", "cli", or "lib"`,
            `- check nodes MUST have meta.command set to a string array (the shell command to run)`,
            ``,
            `Produce edges between nodes using these relationship types: uses, depends_on, serves, reads_writes, targets.`,
            ``,
            `Each node needs a unique id (short slug, e.g. "lang-go", "db-sqlite"), a kind, and a human-readable label.`,
            ``,
            `IMPORTANT: Respond with ONLY valid JSON, no markdown, no explanation, no code fences.`,
        ].join("\n");

        return this.llm.generateStructured(prompt, ProjectKnowledgeSchema, validateKnowledgeGraph);
    }

    private async decomposeInternal(input: DecompositionInput): Promise<DecompositionResult> {
        // Config's maxDepth is authoritative (forced to 2 by default — coarse
        // vertical-slice strategy) and deliberately ignores any per-vision
        // complexity classification, which would otherwise fan complex visions
        // out to 3-4 layers and reproduce the 40-item explosion this strategy
        // exists to avoid.
        const maxDepth = this.config.maxDepth;
        const maxTotalItems = this.config.maxTotalItems;

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

        const tasks = await this.decomposeEpicIntoTasks(epic, input);
        for (const task of this.capItems(tasks, maxTotalItems, 1)) {
            const taskSpec = this.generateTaskSpec(task, input);
            allTasks.push({ ...task, taskSpec });
            for (const dep of task.dependsOn) {
                dependencyEdges.push({ from: task.id, to: dep });
            }
        }

        if (allTasks.length > 0) {
            this.ensureScaffoldTask(allTasks, dependencyEdges, input);
        }

        return {
            epic,
            stories: [],
            features: [],
            tasks: allTasks,
            dependencyEdges,
        };
    }

    private capItems(items: WorkItemSpec[], maxTotalItems: number, currentCount: number): WorkItemSpec[] {
        if (maxTotalItems <= 0) {
            return items;
        }
        const remaining = Math.max(0, maxTotalItems - currentCount);
        return items.slice(0, remaining);
    }

    /**
     * Guarantees exactly one project-level scaffold task exists whenever the decomposition
     * produces any tasks at all, regardless of whether it fanned out through stories/features
     * (maxDepth > 2) or went straight from epic to tasks (maxDepth <= 2). Per-story/per-feature
     * prompts no longer mandate a scaffold (see buildDecomposePrompt), so it must be created
     * once here instead of once per story.
     *
     * There is no equivalent `ensureWiringTask` — wiring is not a separate task. Every
     * generated task is a vertical slice that mounts its own deliverable into the entry
     * point in the same session (see buildDecomposePrompt's Task Quality Requirements),
     * so no dedicated integration task exists to be starved by the dispatch queue.
     */
    private ensureScaffoldTask(
        tasks: Array<WorkItemSpec & { taskSpec: TaskSpec }>,
        dependencyEdges: Array<{ from: string; to: string }>,
        input: DecompositionInput,
    ): void {
        if (tasks.length === 0) return;

        const scaffoldId = generateId("task");
        const scaffoldBase: WorkItemSpec = {
            id: scaffoldId,
            level: "task",
            title: `Create project scaffold: manifest, entry point, directory structure`,
            // Names NO stack (ADR-046): the ProjectFrame carries the target and is
            // rendered ahead of the task, so restating it in an LLM-authored
            // description can only duplicate it — or, when derivation was weak,
            // contradict it with the model's default (ADR-045's prescriptive drift).
            description: `Initialize the project with the correct manifest file, entry point, and directory structure for its tech stack. Install dependencies. Create a verify.toml at the project root with a [checks] section listing the verification commands for this project. All other tasks depend on this.`,
            successCriteria: ["Project installs dependencies and starts with the scaffold in place", "verify.toml exists with at least one check entry"],
            parentId: tasks[0].parentId,
            dependsOn: [],
        };
        const scaffoldTask: WorkItemSpec & { taskSpec: TaskSpec } = {
            ...scaffoldBase,
            taskSpec: this.generateTaskSpec(scaffoldBase, input),
        };

        for (const task of tasks) {
            dependencyEdges.push({ from: task.id, to: scaffoldId });
        }
        tasks.unshift(scaffoldTask);
    }

    /**
     * Turns raw LLM tasks into WorkItemSpecs with deterministically resolved,
     * stable inter-task edges (G3). Each kept task is assigned a synthetic id;
     * every `dependsOn` entry is resolved to that id by `ref` first (primary),
     * then exact `title` (legacy fallback). A dependency on a sibling that was
     * emitted but capped out of `cap` is dropped as a capacity decision (warned);
     * a dependency on something never emitted fails closed with
     * {@link UnresolvableDependencyError} rather than being silently discarded.
     */
    /**
     * PURE pre-check (mig-run10) mirroring {@link resolveDependsOn}'s phantom-ref
     * detection WITHOUT assigning ids — so it can run repeatedly inside the
     * reliability ladder's retry loop with no side effects (generateId is only
     * called once, in resolveTasks, after this passes). Returns the same
     * UnresolvableDependencyError message resolveDependsOn would throw, so the
     * ladder's re-ask feeds the model the offending dep plus the available
     * refs/titles. Capped-out siblings (emitted but sliced by `cap`) are NOT
     * errors here — resolveDependsOn drops those edges as a capacity decision.
     */
    validateTaskRefs(rawTasks: readonly RawTask[], cap: number, parentId: string): StructuredValidation {
        const kept = rawTasks.slice(0, cap);
        const keptRefs = new Set<string>();
        const keptTitles = new Set<string>();
        for (const t of kept) {
            if (t.ref) keptRefs.add(t.ref);
            keptTitles.add(t.title);
        }
        const emittedRefs = new Set<string>();
        const emittedTitles = new Set<string>();
        for (const t of rawTasks) {
            if (t.ref) emittedRefs.add(t.ref);
            emittedTitles.add(t.title);
        }

        const errors: string[] = [];
        for (const t of kept) {
            for (const dep of t.dependsOn) {
                if (keptRefs.has(dep) || keptTitles.has(dep)) continue; // resolvable sibling
                if (emittedRefs.has(dep) || emittedTitles.has(dep)) continue; // capped sibling (edge dropped)
                errors.push(
                    new UnresolvableDependencyError({
                        dependentTaskTitle: t.title,
                        unresolvedRef: dep,
                        availableRefs: [...keptRefs],
                        availableTitles: [...keptTitles],
                        parentId,
                    }).message,
                );
            }
        }
        return errors.length === 0 ? { ok: true } : { ok: false, errors };
    }

    private resolveTasks(rawTasks: readonly RawTask[], cap: number, parentId: string): WorkItemSpec[] {
        const kept = rawTasks.slice(0, cap);

        const refToId = new Map<string, string>();
        const titleToId = new Map<string, string>();
        const assigned = kept.map((raw) => {
            const id = generateId("task");
            if (raw.ref) refToId.set(raw.ref, id);
            // First-writer-wins on duplicate titles so an edge resolves to the
            // earliest task with that title rather than being clobbered.
            if (!titleToId.has(raw.title)) titleToId.set(raw.title, id);
            return { raw, id };
        });

        // Everything the LLM emitted, including tasks capped off above: a
        // dependency on one of these is a capacity drop, not a phantom ref.
        const emittedRefs = new Set<string>();
        const emittedTitles = new Set<string>();
        for (const t of rawTasks) {
            if (t.ref) emittedRefs.add(t.ref);
            emittedTitles.add(t.title);
        }

        return assigned.map(({ raw, id }) => ({
            id,
            level: "task" as const,
            title: raw.title,
            description: raw.description,
            successCriteria: raw.successCriteria,
            parentId,
            dependsOn: this.resolveDependsOn(raw, id, refToId, titleToId, emittedRefs, emittedTitles, parentId),
            goal: raw.goal || undefined,
            endState: raw.endState || undefined,
            scope: raw.scope || undefined,
            deliverables: raw.deliverables.length > 0 ? raw.deliverables : undefined,
            checks: raw.checks.length > 0 ? raw.checks : undefined,
        }));
    }

    private resolveDependsOn(
        raw: RawTask,
        selfId: string,
        refToId: ReadonlyMap<string, string>,
        titleToId: ReadonlyMap<string, string>,
        emittedRefs: ReadonlySet<string>,
        emittedTitles: ReadonlySet<string>,
        parentId: string,
    ): string[] {
        const resolved: string[] = [];
        for (const dep of raw.dependsOn) {
            const target = refToId.get(dep) ?? titleToId.get(dep);
            if (target !== undefined) {
                // Skip a self-reference so a task never depends on itself.
                if (target !== selfId && !resolved.includes(target)) resolved.push(target);
                continue;
            }
            if (emittedRefs.has(dep) || emittedTitles.has(dep)) {
                console.warn(
                    `[DecompositionEngine] dependency "${dep}" of "${raw.title}" points to a capped-out sibling; edge dropped`,
                );
                continue;
            }
            throw new UnresolvableDependencyError({
                dependentTaskTitle: raw.title,
                unresolvedRef: dep,
                availableRefs: [...refToId.keys()],
                availableTitles: [...titleToId.keys()],
                parentId,
            });
        }
        return resolved;
    }

    private async decomposeEpicIntoTasks(
        epic: WorkItemSpec,
        input: DecompositionInput,
    ): Promise<WorkItemSpec[]> {
        const taskCap = this.config.maxTasksPerEpic;
        const priorContext = this.buildPriorContext(input.priorEpicResults);
        const prompt = this.buildDecomposePrompt(
            "decompose this epic into tasks",
            epic.title,
            epic.description,
            input.knowledge,
            input.conventions,
            priorContext,
            [],
            input.epicNorthStar,
            input.manifestContext,
        );

        const parsed = await this.requiredLlm.generateStructured(
            prompt,
            TaskOutputSchema,
            (value) => this.validateTaskRefs(value.tasks, taskCap, epic.id),
        );
        return this.resolveTasks(parsed.tasks, taskCap, epic.id);
    }

    async decomposeStoryIntoTasks(
        story: WorkItemSpec,
        input: DecompositionInput,
        existingItems: ReadonlyArray<ExistingWorkItemSummary> = [],
    ): Promise<WorkItemSpec[]> {
        if (!this.llm) {
            console.warn("[DecompositionEngine] No LLM configured — skipping story decomposition");
            return [];
        }
        const prompt = this.buildDecomposePrompt(
            "decompose this story into tasks",
            story.title,
            story.description,
            input.knowledge,
            input.conventions,
            undefined,
            existingItems,
            undefined,
            input.manifestContext,
        );

        const parsed = await this.requiredLlm.generateStructured(
            prompt,
            TaskOutputSchema,
            (value) => this.validateTaskRefs(value.tasks, this.config.maxTasksPerStory, story.id),
        );
        return this.resolveTasks(parsed.tasks, this.config.maxTasksPerStory, story.id);
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
        priorContext?: string,
        existingItems: ReadonlyArray<ExistingWorkItemSummary> = [],
        northStar?: string,
        manifestContext?: string,
    ): string {
        const positiveConventions = conventions.map((c) => this.ensurePositiveFraming(c));
        const isTaskDecomposition = instruction.includes("tasks");

        const jsonFormat = instruction.includes("stories")
            ? '{"stories": [{"title": "...", "description": "...", "successCriteria": ["..."]}]}'
            : instruction.includes("features")
              ? '{"features": [{"title": "...", "description": "...", "successCriteria": ["..."]}]}'
              : '{"tasks": [{"ref": "t1", "title": "...", "description": "...", "successCriteria": ["..."], "dependsOn": ["t0"], "goal": "...", "endState": "...", "scope": "...", "deliverables": ["..."], "checks": ["..."]}]}';

        const lines = [
            `${instruction}.`,
            ``,
            `Title: ${title}`,
            `Description: ${description}`,
        ];

        // Carries any answers/assumptions captured during alignment (ADR-019)
        // into the decomposition prompt itself, not just onto the output
        // epic's `northStar` field -- mirrors the same conditional pattern
        // already used by `buildSpecDerivationPrompt` (spec-derivation.ts).
        if (northStar && northStar.trim().length > 0) {
            lines.push(`North Star: ${northStar}`);
        }

        if (knowledge && knowledge.nodes.length > 0) {
            const labels = knowledge.nodes.map(n => `${n.label} (${n.kind})`).join(", ");
            lines.push(`Project Knowledge: ${labels}`);
        }

        lines.push(
            `Conventions: ${positiveConventions.join("; ")}`,
            priorContext ?? "",
        );

        if (manifestContext && manifestContext.trim().length > 0) {
            lines.push(``, `Project manifest files found:`, manifestContext);
        }

        if (existingItems.length > 0) {
            lines.push(
                ``,
                `Existing Work Items (already planned or created elsewhere in this project — these EXIST, do not re-emit them, their prerequisites, or duplicate work already covered; the project scaffold is handled once at the project level, not per story). These are CONTEXT ONLY: never list their ids in "dependsOn" — cross-story ordering is handled at the story level, not by task dependencies:`,
                ...existingItems.map((i) => `- ${i.id} [${i.level}] ${i.title} (${i.status})`),
            );
        }

        if (isTaskDecomposition) {
            const examples = buildContextAwareExamples(description);
            lines.push(
                ``,
                `Task Quality Requirements:`,
                `- Each task title must be a specific, actionable verb phrase (e.g., ${examples.titleExample}) not generic (e.g., "Implement functionality").`,
                `- Description must name concrete files or modules to create or modify.`,
                `- successCriteria must include at least one executable verification (e.g., ${examples.checksExample}).`,
                `- deliverables must list specific file paths (e.g., ${examples.deliverablesExample}) not generic descriptions.`,
                `- endState must be an observable condition (e.g., ${examples.endStateExample}) not vague ("complete", "done", "works").`,
                `- scope must name specific directories or modules (e.g., ${examples.scopeExample}) not "the project".`,
                `- checks must include at least one runnable command to verify completion (e.g., ${examples.checksExample}).`,
                `- Give each task a short unique "ref" (e.g. "t1", "auth-mw"). In "dependsOn", list ONLY the "ref" values of OTHER tasks in THIS response that must complete first. Never paraphrase a title, never invent an id, and never reference an Existing Work Item id (e.g. "task-0017") — those are context, not dependencies. A "dependsOn" entry that names no "ref" in this response is invalid.`,
                `- Do not create a project scaffold (package.json, entry point, directory structure) as a separate task — that is a project-level task created once, outside this decomposition.`,
                `- Each task must be a complete vertical slice: implement the feature AND mount/wire it into the entry point (e.g. app.use(), route registration, module import) in the same task. Do not create a separate "wiring" or "integration" task — every task self-integrates by editing the entry point itself. Example: "${examples.verticalSliceExample}"`,
            );
        }

        lines.push(
            ``,
            `IMPORTANT: Respond with ONLY valid JSON, no markdown, no explanation, no code fences.`,
            `Use exactly this format: ${jsonFormat}`,
        );

        return lines.join("\n");
    }

    private deriveObservableEndState(task: WorkItemSpec): string {
        if (task.successCriteria.length > 0) {
            return task.successCriteria[0];
        }

        const lower = `${task.title} ${task.description}`.toLowerCase();

        if (/\bendpoint\b|\broute\b|\bapi\b/.test(lower)) {
            return "API endpoint responds with correct status codes and response body";
        }
        if (/\bpage\b|\bview\b|\bcomponent\b|\bui\b/.test(lower)) {
            return "Page loads and renders correctly in the browser";
        }
        if (/\bcommand\b|\bcli\b|\bsubcommand\b/.test(lower)) {
            return "Command executes successfully and produces expected output";
        }
        if (/\bmigration\b/.test(lower)) {
            return "Database migration applies cleanly and schema matches expected state";
        }
        if (/\btest\b/.test(lower)) {
            return "All new tests pass and cover the target functionality";
        }
        if (/\bconfig\b|\bconfigur/.test(lower)) {
            return "Configuration is applied and the system starts with new settings";
        }

        if (task.description) {
            return task.description;
        }
        return `${task.title} is complete and verified`;
    }

    private deriveDeliverables(task: WorkItemSpec): string[] {
        const text = `${task.title} ${task.description}`;
        const deliverables: string[] = [];

        const pathMatches = text.match(/\b(?:[\w@-]+\/)+[\w.-]+\b/g);
        if (pathMatches) {
            deliverables.push(...new Set(pathMatches));
        }

        const endpointMatches = text.match(/\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/[\w/:-]+/gi);
        if (endpointMatches) {
            for (const ep of endpointMatches) {
                deliverables.push(`${ep} endpoint`);
            }
        }

        if (deliverables.length > 0) {
            return [...new Set(deliverables)];
        }

        const lower = text.toLowerCase();
        if (/\bpage\b|\bview\b|\bcomponent\b/.test(lower)) {
            return [`public/index.html or src/pages/ component for ${task.title}`];
        }
        if (/\bcommand\b|\bcli\b|\bsubcommand\b/.test(lower)) {
            return [`src/commands/ handler for ${task.title}`];
        }

        return [task.description || task.title];
    }

    private deriveScope(task: WorkItemSpec): string {
        const text = `${task.title} ${task.description}`;

        const dirMatches = text.match(/\b(?:[\w@-]+\/)+/g);
        if (dirMatches && dirMatches.length > 0) {
            const dirs = [...new Set(dirMatches.map((d) => d.replace(/\/$/, "")))];
            return `Only modify files in ${dirs.join(", ")}`;
        }

        const lower = text.toLowerCase();
        if (/\bendpoint\b|\broute\b|\bapi\b/.test(lower)) {
            return "Only modify API route handlers and their direct dependencies";
        }
        if (/\bpage\b|\bview\b|\bcomponent\b|\bui\b/.test(lower)) {
            return "Only modify files in public/, src/pages/, and src/components/";
        }
        if (/\bcommand\b|\bcli\b|\bsubcommand\b/.test(lower)) {
            return "Only modify files in src/commands/ and src/cli/";
        }
        if (/\bmigration\b|\bschema\b|\bdatabase\b/.test(lower)) {
            return "Only modify database migration and schema files";
        }
        if (/\btest\b/.test(lower)) {
            return "Only modify test files and test utilities";
        }
        if (/\bconfig\b|\bconfigur/.test(lower)) {
            return "Only modify configuration files";
        }

        return this.ensurePositiveFraming(`Only modify files related to ${task.title.toLowerCase()}`);
    }

    private deriveChecks(task: WorkItemSpec, _context: DecompositionInput): string[] {
        const checks: string[] = [];

        const lower = `${task.title} ${task.description}`.toLowerCase();
        if (/\bendpoint\b|\broute\b|\bapi\b/.test(lower)) {
            checks.push("API endpoint returns expected status code");
        }
        if (/\bpage\b|\bview\b|\bcomponent\b|\bui\b/.test(lower)) {
            checks.push("Page file exists and contains expected markup");
        }
        if (/\bcommand\b|\bcli\b|\bsubcommand\b/.test(lower)) {
            checks.push("CLI command exits 0");
        }
        if (/\bmigration\b/.test(lower)) {
            checks.push("Database migration applies without errors");
        }
        if (/\bvalidat/.test(lower)) {
            checks.push("Invalid input is rejected with appropriate error response");
        }

        checks.push(...task.successCriteria);

        return checks;
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

export function buildContextAwareExamples(_description: string): ContextExamples {
    return {
        titleExample: '"Create the user registration feature with validation"',
        deliverablesExample: '"the relevant source files for this feature"',
        endStateExample: '"the feature works as specified and passes verification"',
        scopeExample: "\"the directories containing this feature's source files\"",
        checksExample: "\"the project's build and test commands pass\"",
        verticalSliceExample: "Implement the feature, wire it into the entry point, and verify it works end-to-end.",
    };
}

let idCounter = 0;

function generateId(prefix: string): string {
    idCounter += 1;
    return `${prefix}-${idCounter.toString().padStart(4, "0")}`;
}

export function resetIdCounter(): void {
    idCounter = 0;
}
