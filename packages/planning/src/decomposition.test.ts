import { describe, expect, test, beforeEach } from "vitest";
import type { ZodType } from "zod";
import type { StructuredValidation } from "@ashara/llm-gateway";
import { DEFAULT_DECOMPOSITION_CONFIG, TaskCapExceededError } from "./decomposition-types.js";
import type { DecompositionInput } from "./decomposition-types.js";
import { DecompositionEngine, resetIdCounter } from "./decomposition.js";
import type { DecompositionLLM } from "./decomposition.js";

const INPUT: DecompositionInput = {
    epicTitle: "Studio bookings",
    epicNorthStar: "Members can book a seat in a class.",
    epicDescription: "Two studios merge their class schedules; members book seats in either.",
    conventions: [],
};

function task(ref: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        ref,
        title: `Task ${ref}`,
        description: `Do ${ref}.`,
        endState: `${ref} is observable`,
        scope: `the ${ref} module`,
        deliverables: [`${ref} source`],
        ...extra,
    };
}

interface Seen {
    readonly prompts: string[];
    readonly verdicts: StructuredValidation[];
}

/**
 * Answers the graph call with `graph` and the task call with `tasks`, parsing
 * through the real schema and recording the semantic verdict, as the ladder does.
 */
function scriptedLlm(graph: unknown, tasks: unknown, seen: Seen): DecompositionLLM {
    return {
        async generateStructured<T>(
            prompt: string,
            schema: ZodType<T>,
            validate?: (value: T) => StructuredValidation,
        ): Promise<T> {
            seen.prompts.push(prompt);
            const value = schema.parse(prompt.includes("structured knowledge graph") ? graph : tasks);
            if (validate) seen.verdicts.push(validate(value));
            return value;
        },
    };
}

describe("DecompositionEngine", () => {
    let seen: Seen;

    beforeEach(() => {
        resetIdCounter();
        seen = { prompts: [], verdicts: [] };
    });

    test("a vision naming no stack decomposes with no stack node and no stack in the prompt", async () => {
        const llm = scriptedLlm({ nodes: [], edges: [] }, { tasks: [task("t1"), task("t2", { dependsOn: ["t1"] })] }, seen);
        const result = await new DecompositionEngine(llm).decompose(INPUT);

        expect(result.knowledge.nodes).toEqual([]);
        expect(result.tasks.map((t) => t.taskSpec.origin)).toEqual(["sprint0", "check", "decomposition", "check", "decomposition"]);
        expect(result.tasks[4]?.taskSpec.endState).toBe("t2 is observable");
        expect(seen.verdicts).toEqual([{ ok: true }]);
        expect(seen.prompts[1]).toContain("Project Knowledge: none stated");
        expect(result.droppedDependencies).toEqual([]);
    });

    test("a plan has exactly one Sprint 0 task, checked by the substrate, that every other task depends on; no task carries checks", async () => {
        const llm = scriptedLlm({ nodes: [], edges: [] }, { tasks: [task("t1"), task("t2", { dependsOn: ["t1"] })] }, seen);
        const result = await new DecompositionEngine(llm).decompose(INPUT);

        const sprint0 = result.tasks.filter((t) => t.taskSpec.origin === "sprint0");
        expect(sprint0).toHaveLength(1);
        const sprint0Id = sprint0[0]?.id;
        expect(sprint0[0]?.taskSpec).toMatchObject({ checkedBy: "substrate" });
        expect(sprint0[0]?.dependsOn).toEqual([]);
        for (const t of result.tasks.filter((t) => t.id !== sprint0Id)) {
            expect(result.dependencyEdges).toContainEqual({ from: t.id, to: sprint0Id });
        }
        expect(result.tasks.every((t) => !("checks" in t.taskSpec))).toBe(true);
    });

    test("every decomposed task gets one check task, after Sprint 0 and before the task; its text names no stack", async () => {
        const llm = scriptedLlm({ nodes: [], edges: [] }, { tasks: [task("t1"), task("t2", { dependsOn: ["t1"] })] }, seen);
        const result = await new DecompositionEngine(llm).decompose(INPUT);

        const sprint0Id = result.tasks.find((t) => t.taskSpec.origin === "sprint0")?.id;
        const decomposed = result.tasks.filter((t) => t.taskSpec.origin === "decomposition");
        const checks = result.tasks.filter((t) => t.taskSpec.origin === "check");
        expect(checks).toHaveLength(decomposed.length);
        for (const implementation of decomposed) {
            const own = checks.filter((c) => result.dependencyEdges.some((e) => e.from === implementation.id && e.to === c.id));
            expect(own).toHaveLength(1);
            const check = own[0];
            expect(check?.dependsOn).toEqual([sprint0Id]);
            expect(result.dependencyEdges).toContainEqual({ from: check?.id, to: sprint0Id });
            expect(check?.title).toBe(`Write the checks for "${implementation.title}"`);
            expect(check?.taskSpec.goal).toContain(
                `Write the checks that decide whether "${implementation.title}" is done: observable behaviour from its deliverables ` +
                    `and acceptance; each check is a command the project environment can run`,
            );
            for (const deliverable of implementation.taskSpec.deliverables) expect(check?.taskSpec.goal).toContain(deliverable);
            for (const criterion of implementation.successCriteria) expect(check?.taskSpec.goal).toContain(criterion);
        }
        // No check task decides another check task, and none depends on an implementation task.
        for (const check of checks) {
            expect(result.dependencyEdges.filter((e) => e.from === check.id).map((e) => e.to)).toEqual([sprint0Id]);
        }
    });

    test("the task prompt names no stack and demands no file path or command", async () => {
        const llm = scriptedLlm({ nodes: [], edges: [] }, { tasks: [task("t1")] }, seen);
        await new DecompositionEngine(llm).decompose(INPUT);

        const prompt = seen.prompts[1] ?? "";
        expect(prompt).toContain("Plan only the product's behavior here.");
        const forbidden = [
            /file path/i, /\bfiles?\b/i, /director(y|ies)/i, /\bcommands?\b/i, /runnable/i, /executable/i,
            /entry point/i, /manifest/i, /verify\.toml/i, /"checks"/, /\bnpm\b/i, /cargo/i, /package\.json/i,
            /python/i, /typescript/i, /javascript/i, /\bnode\b/i, /\bjava\b/i, /\bphp\b/i, /\bgo\b/i, /rust/i,
            /docker/i, /react/i, /\bsql\b/i, /\bsrc\//i,
        ];
        expect(forbidden.filter((pattern) => pattern.test(prompt)).map(String)).toEqual([]);
    });

    test("an edge the re-ask drops is recorded on the plan, and a ref it then fixes is not", async () => {
        const answers = [
            // Rejected: "ghost" and "t9" name no task.
            { tasks: [task("t1", { dependsOn: ["ghost"] }), task("t2", { dependsOn: ["t9"] })] },
            // Accepted: "ghost" dropped; "t9" fixed by emitting a task with that ref.
            { tasks: [task("t1"), task("t2", { dependsOn: ["t9"] }), task("t9")] },
        ];
        const llm: DecompositionLLM = {
            async generateStructured<T>(
                prompt: string,
                schema: ZodType<T>,
                validate?: (value: T) => StructuredValidation,
            ): Promise<T> {
                seen.prompts.push(prompt);
                if (prompt.includes("structured knowledge graph")) return schema.parse({ nodes: [], edges: [] });
                for (const answer of answers) {
                    const value = schema.parse(answer);
                    const verdict = validate ? validate(value) : { ok: true as const };
                    seen.verdicts.push(verdict);
                    if (verdict.ok) return value;
                }
                throw new Error("scripted answers exhausted");
            },
        };

        const result = await new DecompositionEngine(llm).decompose(INPUT);

        expect(seen.verdicts.map((v) => v.ok)).toEqual([false, true]);
        expect(result.droppedDependencies).toEqual([{ dependentTaskTitle: "Task t1", unresolvedRef: "ghost" }]);
        const byTitle = new Map(result.tasks.map((t) => [t.title, t.id]));
        expect(result.dependencyEdges).toContainEqual({ from: byTitle.get("Task t2"), to: byTitle.get("Task t9") });
    });

    test("states the per-epic cap and rejects an over-cap response instead of truncating it", async () => {
        const cap = DEFAULT_DECOMPOSITION_CONFIG.maxTasksPerEpic;
        const tasks = Array.from({ length: cap + 1 }, (_, i) => task(`t${i}`));
        const llm = scriptedLlm({ nodes: [], edges: [] }, { tasks }, seen);

        await expect(new DecompositionEngine(llm).decompose(INPUT)).rejects.toBeInstanceOf(TaskCapExceededError);
        expect(seen.prompts[1]).toContain(`Emit at most ${cap} tasks`);
        expect(seen.verdicts[0]).toMatchObject({ ok: false });
    });

    test.each(["endState", "scope", "deliverables"])("a task missing %s is rejected, not inferred", async (field) => {
        const llm = scriptedLlm({ nodes: [], edges: [] }, { tasks: [task("t1", { [field]: undefined })] }, seen);
        await expect(new DecompositionEngine(llm).decompose(INPUT)).rejects.toThrow(field);
    });
});
