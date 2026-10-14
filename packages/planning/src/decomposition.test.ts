import { describe, expect, test, beforeEach } from "vitest";
import type { ZodType } from "zod";
import type { StructuredValidation } from "@ashara/llm-gateway";
import { DEFAULT_DECOMPOSITION_CONFIG, TaskCapExceededError, UntraceableTaskError, VisionItemsMissing } from "./decomposition-types.js";
import type { DecompositionInput } from "./decomposition-types.js";
import { DecompositionEngine, resetIdCounter } from "./decomposition.js";
import type { DecompositionLLM } from "./decomposition.js";

const INPUT: DecompositionInput = {
    epicTitle: "Studio bookings",
    epicNorthStar: "Members can book a seat in a class.",
    epicDescription: "Two studios merge their class schedules; members book seats in either.",
    conventions: [],
    environment: { kind: "new" },
    visionItems: [
        { id: "S1", text: "In: booking a seat in a class of either studio" },
        { id: "A1", text: "A class holds at most twenty members" },
    ],
};

function task(ref: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        ref,
        title: `Task ${ref}`,
        description: `Do ${ref}.`,
        endState: `${ref} is observable`,
        scope: `the ${ref} module`,
        deliverables: [`${ref} source`],
        visionItems: ["S1"],
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
        expect(result.tasks.map((t) => t.taskSpec.origin)).toEqual(["sprint0", "decomposition", "check", "decomposition", "check", "review"]);
        expect(result.tasks[3]?.taskSpec.endState).toBe("t2 is observable");
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

    test("every decomposed task gets one check task, after Sprint 0, naming it by checksFor; its text names no stack", async () => {
        const llm = scriptedLlm({ nodes: [], edges: [] }, { tasks: [task("t1"), task("t2", { dependsOn: ["t1"] })] }, seen);
        const result = await new DecompositionEngine(llm).decompose(INPUT);

        const sprint0Id = result.tasks.find((t) => t.taskSpec.origin === "sprint0")?.id;
        const decomposed = result.tasks.filter((t) => t.taskSpec.origin === "decomposition");
        const checks = result.tasks.filter((t) => t.taskSpec.origin === "check");
        expect(checks).toHaveLength(decomposed.length);
        for (const implementation of decomposed) {
            const own = checks.filter((c) => c.taskSpec.origin === "check" && c.taskSpec.checksFor === implementation.id);
            expect(own).toHaveLength(1);
            const check = own[0];
            // The plan's writer resolves checksFor by temp id, so the task comes before its check task.
            expect(result.tasks.indexOf(implementation)).toBeLessThan(result.tasks.findIndex((t) => t.id === check?.id));
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

    // Fourth run N13: check tasks depending only on Sprint 0 ran after earlier implementations changed
    // main, found their work already there, and the red-run rule left them no exit.
    test.each([
        ["a first plan", { kind: "new" } as const],
        ["a revision building on the environment already done", { kind: "existing", taskId: "env-done" } as const],
    ])("in %s every implementation task depends on every check task of the plan", async (_label, environment) => {
        const llm = scriptedLlm(
            { nodes: [], edges: [] },
            { tasks: [task("t1"), task("t2", { dependsOn: ["t1"] }), task("t3")] },
            seen,
        );
        const result = await new DecompositionEngine(llm).decompose({ ...INPUT, environment });

        const environmentId = environment.kind === "new" ? result.tasks.find((t) => t.taskSpec.origin === "sprint0")?.id : environment.taskId;
        const checkIds = result.tasks.filter((t) => t.taskSpec.origin === "check").map((t) => t.id);
        const decomposed = result.tasks.filter((t) => t.taskSpec.origin === "decomposition");
        expect(checkIds).toHaveLength(3);
        for (const implementation of decomposed) {
            const targets = result.dependencyEdges.filter((e) => e.from === implementation.id).map((e) => e.to);
            for (const checkId of checkIds) expect(targets).toContain(checkId);
            expect(targets).toContain(environmentId);
        }
        // The model's own ordering survives beside them.
        const [t1, t2] = decomposed;
        expect(result.dependencyEdges).toContainEqual({ from: t2?.id, to: t1?.id });
        for (const checkId of checkIds) {
            expect(result.dependencyEdges.filter((e) => e.from === checkId).map((e) => e.to)).toEqual([environmentId]);
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
    // Fifth run N21: the first task printed a column count the tender never asked for (ADR-074 addendum 2 d71 d).
    test.each([
        ["names no vision item", []],
        ["names an item the vision does not hold", ["S9"]],
    ])("a plan whose task %s is rejected through the ladder, never written", async (_label, named) => {
        const llm = scriptedLlm({ nodes: [], edges: [] }, { tasks: [task("t1"), task("t2", { visionItems: named })] }, seen);

        await expect(new DecompositionEngine(llm).decompose(INPUT)).rejects.toBeInstanceOf(UntraceableTaskError);
        expect(seen.verdicts).toHaveLength(1);
        expect(seen.verdicts[0]).toMatchObject({ ok: false });
        expect(seen.verdicts[0]?.ok === false ? seen.verdicts[0].errors.join("\n") : "").toContain('Task "Task t2"');
    });

    test("the task prompt lists every vision item by id and asks each task to name those it delivers", async () => {
        const llm = scriptedLlm({ nodes: [], edges: [] }, { tasks: [task("t1")] }, seen);
        await new DecompositionEngine(llm).decompose(INPUT);

        const prompt = seen.prompts[1] ?? "";
        expect(prompt).toContain("- S1: In: booking a seat in a class of either studio");
        expect(prompt).toContain("- A1: A class holds at most twenty members");
        expect(prompt).toContain('In "visionItems", list the ids of the vision items above that the task delivers');
    });

    test("a vision with no item is refused before any model call", async () => {
        const llm = scriptedLlm({ nodes: [], edges: [] }, { tasks: [task("t1")] }, seen);
        await expect(new DecompositionEngine(llm).decompose({ ...INPUT, visionItems: [] })).rejects.toBeInstanceOf(VisionItemsMissing);
        expect(seen.prompts).toEqual([]);
    });

    test("a task records the texts of the items it traces to, by id or exact text; its check task carries them in its brief", async () => {
        const llm = scriptedLlm(
            { nodes: [], edges: [] },
            { tasks: [task("t1", { visionItems: ["A1", "In: booking a seat in a class of either studio"] })] },
            seen,
        );
        const result = await new DecompositionEngine(llm).decompose(INPUT);

        const implementation = result.tasks.find((t) => t.taskSpec.origin === "decomposition");
        const traced = ["In: booking a seat in a class of either studio", "A class holds at most twenty members"];
        expect(implementation?.taskSpec).toMatchObject({ visionItems: traced });
        const check = result.tasks.find((t) => t.taskSpec.origin === "check");
        expect(check?.taskSpec).toMatchObject({ visionItems: traced });
        expect(check?.taskSpec.goal).toContain(`Vision items "Task t1" delivers (its checks may test only these, and the inputs they say to reject):`);
        for (const text of traced) expect(check?.taskSpec.goal).toContain(`- ${text}`);
    });

    // Fifth run N20: 36 stored checks no product could all pass (ADR-074 addendum 2 d71 c).
    test.each([
        ["a first plan", { kind: "new" } as const],
        ["a revision building on the environment already done", { kind: "existing", taskId: "env-done" } as const],
    ])("in %s one review task waits on every check task and every implementation waits on it", async (_label, environment) => {
        const llm = scriptedLlm({ nodes: [], edges: [] }, { tasks: [task("t1"), task("t2", { dependsOn: ["t1"] })] }, seen);
        const result = await new DecompositionEngine(llm).decompose({ ...INPUT, environment });

        const reviews = result.tasks.filter((t) => t.taskSpec.origin === "review");
        expect(reviews).toHaveLength(1);
        const review = reviews[0];
        const checkIds = result.tasks.filter((t) => t.taskSpec.origin === "check").map((t) => t.id);
        const environmentId = environment.kind === "new" ? result.tasks.find((t) => t.taskSpec.origin === "sprint0")?.id : environment.taskId;
        expect(review?.dependsOn).toEqual([environmentId, ...checkIds]);
        expect(result.dependencyEdges.filter((e) => e.from === review?.id).map((e) => e.to)).toEqual([environmentId, ...checkIds]);
        for (const implementation of result.tasks.filter((t) => t.taskSpec.origin === "decomposition")) {
            expect(result.dependencyEdges).toContainEqual({ from: implementation.id, to: review?.id });
        }
        // Nothing but implementations waits on the review: the check tasks run before it.
        const waiting = result.dependencyEdges.filter((e) => e.to === review?.id).map((e) => e.from);
        expect(waiting.sort()).toEqual(result.tasks.filter((t) => t.taskSpec.origin === "decomposition").map((t) => t.id).sort());
        expect(review?.taskSpec).toMatchObject({ visionItems: INPUT.visionItems.map((item) => item.text) });
    });
});
