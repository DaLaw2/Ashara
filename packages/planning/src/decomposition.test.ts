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
        expect(result.tasks.map((t) => t.taskSpec.origin)).toEqual(["scaffold", "decomposition", "decomposition"]);
        expect(result.tasks[2]?.taskSpec.endState).toBe("t2 is observable");
        expect(seen.verdicts).toEqual([{ ok: true }]);
        expect(seen.prompts[1]).toContain("Project Knowledge: none stated");
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
