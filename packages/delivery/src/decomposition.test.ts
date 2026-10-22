import { describe, expect, test, beforeEach } from "vitest";
import type { ZodType } from "zod";
import { planningVisionOf } from "./acl/engagement-acl.js";
import type { StoredVision } from "./acl/engagement-acl.js";
import { checkDecides } from "./acl/engagement-vision-acl.js";
import { SchemaValidationError, modelCallFailureOf } from "./acl/finance-acl.js";
import type { StructuredProvider, StructuredValidation } from "./acl/finance-acl.js";
import { SCAFFOLD_PLACEHOLDER_MARKER } from "./acl/quality-acl.js";
import { DEFAULT_DECOMPOSITION_CONFIG, PlannedBehaviourInvalid, TaskCapExceededError, UncitedVisionItemsError, UntraceableTaskError, VisionItemsMissing } from "./decomposition-types.js";
import type { DecompositionInput, VisionItem } from "./decomposition-types.js";
import { DecompositionEngine, resetIdCounter } from "./decomposition.js";
import type { DecompositionLLM } from "./decomposition.js";
import { createGatewayDecompositionLLM } from "./gateway-adapters.js";

const A1: VisionItem = {
    type: "assumption",
    id: "A1",
    text: "A class holds at most twenty members",
    status: "Inferred",
    standing: "reported",
    kind: "client-visible",
};

// A1 is checked by work already done unless a test says otherwise, so the tests of other rules plan
// lines citing S1 alone (S1 is in scope, so a plan must cite it); the tests of the coverage rule
// clear checkedItems.
const INPUT: DecompositionInput = {
    epicTitle: "Studio bookings",
    epicNorthStar: "Members can book a seat in a class.",
    epicDescription: "Two studios merge their class schedules; members book seats in either.",
    environment: { kind: "new" },
    layout: { kind: "new" },
    checkedItems: [A1],
    interface: [],
    assumptionKeys: (count) => Array.from({ length: count }, (_, i) => `A${3 + i}`),
    visionItems: [
        { type: "scope", id: "S1", text: "In: booking a seat in a class of either studio", side: "in" },
        A1,
        {
            type: "assumption",
            id: "A2",
            text: "Bookings are recorded in one ledger",
            status: "Inferred",
            standing: "reported",
            kind: "internal-design",
        },
    ],
};

/** A task whose one deliverable and one acceptance line cite `sources`. */
function task(ref: string, extra: Record<string, unknown> = {}, sources: readonly string[] = ["S1"]): Record<string, unknown> {
    return {
        ref,
        title: `Task ${ref}`,
        description: `Do ${ref}.`,
        dependsOn: [],
        goal: `Deliver ${ref}`,
        endState: `${ref} is observable`,
        scope: `the ${ref} module`,
        deliverables: [{ text: `${ref} works`, sources }],
        acceptance: [{ text: `a member sees ${ref}`, sources }],
        capability: "Medium",
        capabilityReason: `${ref} is one well-specified behavior`,
        ...extra,
    };
}

interface Seen {
    readonly prompts: string[];
    readonly verdicts: StructuredValidation[];
}

/**
 * Answers the task call with `tasks`, parsing through the real schema and
 * recording the semantic verdict, as the ladder does.
 */
function scriptedLlm(tasks: unknown, seen: Seen): DecompositionLLM {
    return {
        async generateStructured<T>(
            prompt: string,
            schema: ZodType<T>,
            validate?: (value: T) => StructuredValidation,
        ): Promise<T> {
            seen.prompts.push(prompt);
            const value = schema.parse(tasks);
            if (validate) seen.verdicts.push(validate(value));
            return value;
        },
    };
}

/** Whether `from` waits on `to`, directly or through other tasks. */
function waitsOn(edges: ReadonlyArray<{ from: string; to: string }>, from: string, to: string): boolean {
    const seenIds = new Set<string>();
    const pending = [from];
    while (pending.length > 0) {
        const current = pending.pop() ?? "";
        for (const edge of edges.filter((e) => e.from === current)) {
            if (edge.to === to) return true;
            if (!seenIds.has(edge.to)) {
                seenIds.add(edge.to);
                pending.push(edge.to);
            }
        }
    }
    return false;
}

describe("DecompositionEngine", () => {
    let seen: Seen;

    beforeEach(() => {
        resetIdCounter();
        seen = { prompts: [], verdicts: [] };
    });

    test("a vision naming no stack decomposes with no stack in the prompt", async () => {
        const llm = scriptedLlm({ assumptions: [], tasks: [task("t1"), task("t2", { dependsOn: ["t1"] })] }, seen);
        const result = await new DecompositionEngine(llm).decompose(INPUT);

        expect(result.tasks.map((t) => t.taskSpec.origin)).toEqual([
            "sprint0", "product-scaffold", "decomposition", "check", "decomposition", "check", "review",
        ]);
        expect(result.tasks[4]?.taskSpec.endState).toBe("t2 is observable");
        expect(seen.verdicts).toEqual([{ ok: true }]);
        expect(seen.prompts[0]).toContain("choose no implementation stack the vision items below do not state");
        expect(result.droppedDependencies).toEqual([]);
    });

    test("the scaffold's refusal carries Quality's placeholder marker, and every check author is told the task retires it", async () => {
        const llm = scriptedLlm({ assumptions: [], tasks: [task("t1"), task("t2", { dependsOn: ["t1"] })] }, seen);
        const result = await new DecompositionEngine(llm).decompose(INPUT);

        const scaffold = result.tasks.find((t) => t.taskSpec.origin === "product-scaffold");
        expect(scaffold?.description).toContain(`Every refusal carries the exact text ${SCAFFOLD_PLACEHOLDER_MARKER}`);
        expect(scaffold?.taskSpec.deliverables).toContainEqual(expect.stringContaining(`each refusal carrying ${SCAFFOLD_PLACEHOLDER_MARKER}`));
        const checks = result.tasks.filter((t) => t.taskSpec.origin === "check");
        expect(checks).toHaveLength(2);
        for (const check of checks) {
            expect(check.description, check.title).toMatch(
                new RegExp(`refusal carrying ${SCAFFOLD_PLACEHOLDER_MARKER}, which "Task t\\d" removes from every entry it owns`),
            );
        }
    });

    test("a plan has exactly one Sprint 0 task, checked by the substrate, that every other task depends on; no task carries checks", async () => {
        const llm = scriptedLlm({ assumptions: [], tasks: [task("t1"), task("t2", { dependsOn: ["t1"] })] }, seen);
        const result = await new DecompositionEngine(llm).decompose(INPUT);

        const sprint0 = result.tasks.filter((t) => t.taskSpec.origin === "sprint0");
        expect(sprint0).toHaveLength(1);
        const sprint0Id = sprint0[0]?.id;
        expect(sprint0[0]?.taskSpec).toMatchObject({ checkedBy: "substrate" });
        expect(sprint0[0]?.dependsOn).toEqual([]);
        for (const t of result.tasks.filter((t) => t.id !== sprint0Id)) {
            expect(waitsOn(result.dependencyEdges, t.id, sprint0Id ?? ""), t.title).toBe(true);
        }
        expect(result.tasks.every((t) => !("checks" in t.taskSpec))).toBe(true);
    });

    // The product's layout is set by an implementer before any check names it.
    test("a first plan sets up the product's layout after Sprint 0 and before every check, traced to the items it enables", async () => {
        const llm = scriptedLlm(
            { assumptions: [], tasks: [task("t1", {}, ["S1"]), task("t2", { dependsOn: ["t1"] }, ["A1"])] },
            seen,
        );
        const result = await new DecompositionEngine(llm).decompose(INPUT);

        const sprint0Id = result.tasks.find((t) => t.taskSpec.origin === "sprint0")?.id;
        const scaffolds = result.tasks.filter((t) => t.taskSpec.origin === "product-scaffold");
        expect(scaffolds).toHaveLength(1);
        const scaffold = scaffolds[0];
        expect(scaffold?.dependsOn).toEqual([sprint0Id]);
        expect(result.dependencyEdges.filter((e) => e.from === scaffold?.id).map((e) => e.to)).toEqual([sprint0Id]);
        expect(scaffold?.taskSpec).toMatchObject({
            checkedBy: "substrate",
            visionItems: ["In: booking a seat in a class of either studio", "A class holds at most twenty members"],
        });
        for (const t of result.tasks.filter((t) => t.taskSpec.origin !== "sprint0" && t.id !== scaffold?.id)) {
            expect(waitsOn(result.dependencyEdges, t.id, scaffold?.id ?? ""), t.title).toBe(true);
        }
        // The scaffold writes down the public interface, and its placeholder starts and refuses each entry.
        expect(scaffold?.description).toContain("Write down the product's public interface in PUBLIC_INTERFACE.md");
        expect(scaffold?.successCriteria).toContainEqual(expect.stringMatching(/starts as the interface says .* never failing to start/));
        // Stack-free: the layout is the implementer's to choose in the environment's own terms.
        const text = `${scaffold?.title} ${scaffold?.description} ${JSON.stringify(scaffold?.taskSpec)}`;
        for (const literal of [/\bnpm\b/i, /cargo/i, /package\.json/i, /go\.mod/i, /python/i, /\bsrc\//i, /Makefile/]) {
            expect(text).not.toMatch(literal);
        }
        // A revision builds on the layout already merged: no second scaffold.
        resetIdCounter();
        const revision = await new DecompositionEngine(
            scriptedLlm({ assumptions: [], tasks: [task("t1")] }, { prompts: [], verdicts: [] }),
        ).decompose({ ...INPUT, environment: { kind: "existing", taskId: "env-done" }, layout: { kind: "existing", taskId: "layout-done" } });
        expect(revision.tasks.filter((t) => t.taskSpec.origin === "product-scaffold")).toEqual([]);
    });

    test("a revision on a merged layout red-runs on that layout's latest merge, never on the environment task merged before it", async () => {
        const decompose = (environment: DecompositionInput["environment"]) =>
            new DecompositionEngine(
                scriptedLlm({ assumptions: [], tasks: [task("t1")] }, { prompts: [], verdicts: [] }),
            ).decompose({ ...INPUT, environment, layout: { kind: "existing", taskId: "layout-latest" } });

        const onExisting = await decompose({ kind: "existing", taskId: "env-done" });
        const checkTasks = onExisting.tasks.filter((t) => t.taskSpec.origin === "check" || t.taskSpec.origin === "review");
        expect(checkTasks).toHaveLength(2);
        for (const t of checkTasks) {
            expect(t.dependsOn).toContain("layout-latest");
            expect(t.dependsOn).not.toContain("env-done");
        }
        const check = checkTasks.find((t) => t.taskSpec.origin === "check");
        expect(onExisting.dependencyEdges.filter((e) => e.from === check?.id).map((e) => e.to)).toEqual(["layout-latest"]);

        // A new environment task of the revision lands on that layout: its merge is the foundation then.
        const onNew = await decompose({ kind: "new" });
        const sprint0 = onNew.tasks.find((t) => t.taskSpec.origin === "sprint0");
        const newCheck = onNew.tasks.find((t) => t.taskSpec.origin === "check");
        expect(newCheck?.dependsOn).toEqual([sprint0?.id]);
    });

    test("every decomposed task gets one check task, after the product scaffold, naming it by checksFor; its text names no stack", async () => {
        const llm = scriptedLlm({ assumptions: [], tasks: [task("t1"), task("t2", { dependsOn: ["t1"] })] }, seen);
        const result = await new DecompositionEngine(llm).decompose(INPUT);

        const sprint0Id = result.tasks.find((t) => t.taskSpec.origin === "product-scaffold")?.id;
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
                `Write the checks that decide whether "${implementation.title}" is done: the observable behaviour its ` +
                    `acceptance lines ask for, each tested against the vision items it cites`,
            );
            for (const deliverable of implementation.taskSpec.deliverables) expect(check?.taskSpec.goal).toContain(deliverable);
            for (const criterion of implementation.successCriteria) expect(check?.taskSpec.goal).toContain(`[S1] ${criterion}`);
            // The check author tests the interface the scaffold wrote down, never a guessed one.
            expect(check?.taskSpec.goal).toContain("Read the product's public interface in PUBLIC_INTERFACE.md");
            expect(check?.taskSpec.goal).toMatch(/never try other ways to start, configure or call the product/);
        }
        // No check task decides another check task, and none depends on an implementation task.
        for (const check of checks) {
            expect(result.dependencyEdges.filter((e) => e.from === check.id).map((e) => e.to)).toEqual([sprint0Id]);
        }
    });

    // A check task depending only on Sprint 0 can run after earlier implementations
    // changed main and find its work already there; it must still have an exit under the red-run rule.
    test.each([
        ["a first plan", { kind: "new" } as const],
        ["a revision building on the environment already done", { kind: "existing", taskId: "env-done" } as const],
    ])("in %s every implementation task depends on every check task of the plan", async (_label, environment) => {
        const layout = environment.kind === "new" ? ({ kind: "new" } as const) : ({ kind: "existing", taskId: "layout-done" } as const);
        const llm = scriptedLlm(
            { assumptions: [], tasks: [task("t1"), task("t2", { dependsOn: ["t1"] }), task("t3")] },
            seen,
        );
        const result = await new DecompositionEngine(llm).decompose({ ...INPUT, environment, layout });

        const environmentId = environment.kind === "new" ? result.tasks.find((t) => t.taskSpec.origin === "product-scaffold")?.id : environment.taskId;
        // A revision's checks are red-run on the layout already merged, never on the environment task.
        const foundationId = layout.kind === "existing" ? layout.taskId : environmentId;
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
            expect(result.dependencyEdges.filter((e) => e.from === checkId).map((e) => e.to)).toEqual([foundationId]);
        }
    });

    test("the task prompt names no stack and demands no file path or command", async () => {
        const llm = scriptedLlm({ assumptions: [], tasks: [task("t1")] }, seen);
        await new DecompositionEngine(llm).decompose(INPUT);

        const prompt = seen.prompts[0] ?? "";
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
            { assumptions: [], tasks: [task("t1", { dependsOn: ["ghost"] }), task("t2", { dependsOn: ["t9"] })] },
            // Accepted: "ghost" dropped; "t9" fixed by emitting a task with that ref.
            { assumptions: [], tasks: [task("t1"), task("t2", { dependsOn: ["t9"] }), task("t9")] },
        ];
        const llm: DecompositionLLM = {
            async generateStructured<T>(
                prompt: string,
                schema: ZodType<T>,
                validate?: (value: T) => StructuredValidation,
            ): Promise<T> {
                seen.prompts.push(prompt);
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
        const llm = scriptedLlm({ assumptions: [], tasks }, seen);

        await expect(new DecompositionEngine(llm).decompose(INPUT)).rejects.toBeInstanceOf(TaskCapExceededError);
        expect(seen.prompts[0]).toContain(`Emit at most ${cap} tasks`);
        expect(seen.verdicts[0]).toMatchObject({ ok: false });
    });

    test.each(["endState", "scope", "deliverables", "acceptance"])("a task missing %s is rejected, not inferred", async (field) => {
        const llm = scriptedLlm({ assumptions: [], tasks: [task("t1", { [field]: undefined })] }, seen);
        await expect(new DecompositionEngine(llm).decompose(INPUT)).rejects.toThrow(field);
    });
    // A task must not ask for what the tender never asked for:
    // every deliverable and acceptance line names its own sources.
    test.each([
        ["an acceptance line that names no source", { acceptance: [{ text: "keys come back sorted", sources: [] }] }, "names no vision item it serves"],
        ["a deliverable that names no source", { deliverables: [{ text: "sorted listing", sources: [] }] }, "names no vision item it serves"],
        ["a line naming an item the vision does not hold", { acceptance: [{ text: "keys come back sorted", sources: ["S9"] }] }, '"S9", which is no vision item'],
    ])("a plan with %s is rejected through the ladder, never written", async (_label, broken, message) => {
        const llm = scriptedLlm({ assumptions: [], tasks: [task("t1"), task("t2", broken)] }, seen);

        await expect(new DecompositionEngine(llm).decompose(INPUT)).rejects.toBeInstanceOf(UntraceableTaskError);
        expect(seen.verdicts).toHaveLength(1);
        expect(seen.verdicts[0]).toMatchObject({ ok: false });
        const errors = seen.verdicts[0]?.ok === false ? seen.verdicts[0].errors.join("\n") : "";
        expect(errors).toContain('Task "Task t2"');
        expect(errors).toContain(message);
    });

    // An internal-design assumption guides the implementer; it is never what a check decides.
    test("an internal-design assumption cannot be the source of an acceptance line or a deliverable", async () => {
        for (const broken of [
            { acceptance: [{ text: "every booking lands in the ledger", sources: ["S1", "A2"] }] },
            { deliverables: [{ text: "one ledger", sources: ["A2"] }] },
        ]) {
            resetIdCounter();
            const verdicts: StructuredValidation[] = [];
            const llm = scriptedLlm({ assumptions: [], tasks: [task("t1", broken)] }, { prompts: [], verdicts });
            await expect(new DecompositionEngine(llm).decompose(INPUT)).rejects.toBeInstanceOf(UntraceableTaskError);
            expect(verdicts[0]?.ok === false ? verdicts[0].errors.join("\n") : "").toContain("names A2, an internal-design assumption");
        }
    });

    describe("behaviour a plan adds beyond what the vision states", () => {
        const G1: VisionItem = {
            type: "guarantee",
            id: "G1",
            text: "Overdue loans are listed in the report",
            observation: "output",
            interface: ["I1"],
            refutedBy: ["The report includes a loan that is not overdue"],
        };
        const WITH_GUARANTEE: DecompositionInput = { ...INPUT, visionItems: [...INPUT.visionItems, G1], checkedItems: [A1] };
        const ADDED = "A loan returned after its due date stays listed with its fine";

        test("a line citing a proposal rests on the assumption the contract records it under, and its check task and the review read it", async () => {
            const llm = scriptedLlm(
                {
                    assumptions: [{ ref: "n1", statement: ADDED, underpins: ["G1"] }],
                    tasks: [
                        task("t1", {
                            deliverables: [{ text: "the report lists overdue loans", sources: ["G1", "S1"] }],
                            acceptance: [{ text: "a loan returned late is listed with its fine", sources: ["G1", "n1"] }],
                        }),
                    ],
                },
                seen,
            );
            const result = await new DecompositionEngine(llm).decompose(WITH_GUARANTEE);

            expect(seen.verdicts).toEqual([{ ok: true }]);
            expect(result.assumptions).toEqual([{ key: "A3", statement: ADDED, underpins: ["G1"] }]);
            const decomposed = result.tasks.find((t) => t.taskSpec.origin === "decomposition");
            const added: VisionItem = { type: "assumption", id: "A3", text: ADDED, status: "Inferred", standing: "reported", kind: "client-visible" };
            expect(decomposed?.taskSpec).toMatchObject({
                acceptance: [{ line: "a loan returned late is listed with its fine", sources: ["G1", "A3"] }],
                sources: [{ id: "S1" }, G1, added],
                addedAssumptions: [{ key: "A3", statement: ADDED }],
            });
            const check = result.tasks.find((t) => t.taskSpec.origin === "check");
            expect(check?.description).toContain(`A3 (assumption; client-visible behaviour): ${ADDED}`);
            expect(check?.description).not.toContain("n1");
            const review = result.tasks.find((t) => t.taskSpec.origin === "review");
            expect(review?.taskSpec).toMatchObject({ sources: [...WITH_GUARANTEE.visionItems, added] });
        });

        test("a plan that adds nothing records no assumption", async () => {
            const llm = scriptedLlm({ assumptions: [], tasks: [task("t1", {}, ["G1", "S1"])] }, seen);
            const result = await new DecompositionEngine(llm).decompose(WITH_GUARANTEE);

            expect(result.assumptions).toEqual([]);
            expect(result.tasks.find((t) => t.taskSpec.origin === "decomposition")?.taskSpec).toMatchObject({ addedAssumptions: [] });
        });

        test("the prompt asks for unstated behaviour as a proposal, never a silent line", async () => {
            const llm = scriptedLlm({ assumptions: [], tasks: [task("t1", {}, ["G1", "S1"])] }, seen);
            await new DecompositionEngine(llm).decompose(WITH_GUARANTEE);

            expect(seen.prompts[0]).toContain("never write it silently: propose it in \"assumptions\"");
            expect(seen.prompts[0]).toContain('"assumptions": [{"ref": "n1"');
        });

        test.each([
            ["names no guarantee", { ref: "n1", statement: ADDED, underpins: [] }, "n1 names no guarantee"],
            ["names an assumption as what it underpins", { ref: "n1", statement: ADDED, underpins: ["A1"] }, 'n1 names "A1" in "underpins", which is no guarantee'],
            ["reuses a vision item's id", { ref: "S1", statement: ADDED, underpins: ["G1"] }, 'ref "S1" is already a vision item'],
        ])("a proposal that %s is rejected through the ladder, never written", async (_label, proposal, message) => {
            const llm = scriptedLlm(
                {
                    assumptions: [proposal],
                    tasks: [task("t1", { acceptance: [{ text: "a loan returned late is listed", sources: ["G1", proposal.ref] }] }, ["G1", "S1"])],
                },
                seen,
            );

            await expect(new DecompositionEngine(llm).decompose(WITH_GUARANTEE)).rejects.toBeInstanceOf(PlannedBehaviourInvalid);
            expect(seen.verdicts[0]?.ok === false ? seen.verdicts[0].errors.join("\n") : "").toContain(message);
        });

        test("a proposal no line cites is rejected", async () => {
            const llm = scriptedLlm({ assumptions: [{ ref: "n1", statement: ADDED, underpins: ["G1"] }], tasks: [task("t1", {}, ["G1", "S1"])] }, seen);

            await expect(new DecompositionEngine(llm).decompose(WITH_GUARANTEE)).rejects.toBeInstanceOf(PlannedBehaviourInvalid);
            expect(seen.verdicts[0]?.ok === false ? seen.verdicts[0].errors.join("\n") : "").toContain("n1 is cited by no line");
        });
    });

    test("the task prompt lists every vision item by id with its kind and asks each line to name its sources", async () => {
        const llm = scriptedLlm({ assumptions: [], tasks: [task("t1")] }, seen);
        await new DecompositionEngine(llm).decompose(INPUT);

        const prompt = seen.prompts[0] ?? "";
        expect(prompt).toContain("- S1 (in scope): In: booking a seat in a class of either studio");
        expect(prompt).toContain("- A1 (assumption; Inferred; reported to the client; client-visible behaviour): A class holds at most twenty members");
        expect(prompt).toContain("- A2 (assumption; Inferred; reported to the client; internal design, not citable): Bookings are recorded in one ledger");
        expect(prompt).toContain('Every deliverable and every acceptance line names in "sources" the ids of the citable vision items above it serves');
        expect(prompt).not.toContain('"visionItems"');
    });

    // An assumption is decided through what rests on it; the plan must cite only what a check decides.
    test("a plan in which no task cites a client-visible assumption is accepted; only what a check decides must be cited", async () => {
        const llm = scriptedLlm({ assumptions: [], tasks: [task("t1")] }, seen);

        await new DecompositionEngine(llm).decompose({ ...INPUT, checkedItems: [] });
        expect(seen.verdicts).toEqual([{ ok: true }]);
        expect(seen.prompts[0]).toContain('Every one of these items must be cited in "sources" by a line of the task whose work it is, whose checks then decide it; a plan that leaves one uncited is rejected: S1.');
    });

    // Citing gives the item a task whose check set must decide it; no line's text is read as checking it.
    test("a deliverable or an acceptance line citing the assumption, by id or exact text, gives it a task", async () => {
        const deliverableOnly = scriptedLlm({ assumptions: [], tasks: [task("t1", { deliverables: [{ text: "twenty seats", sources: ["S1", "A1"] }] })] }, seen);
        await new DecompositionEngine(deliverableOnly).decompose({ ...INPUT, checkedItems: [] });
        expect(seen.verdicts).toEqual([{ ok: true }]);
        for (const source of ["A1", "A class holds at most twenty members"]) {
            resetIdCounter();
            const verdicts: StructuredValidation[] = [];
            const llm = scriptedLlm({ assumptions: [], tasks: [task("t1"), task("t2", {}, ["S1", source])] }, { prompts: [], verdicts });
            await new DecompositionEngine(llm).decompose({ ...INPUT, checkedItems: [] });
            expect(verdicts).toEqual([{ ok: true }]);
        }
    });

    test("work already done checks an item only as the vision states it now", async () => {
        const noneCite = { assumptions: [], tasks: [task("t1", {}, ["A1"])] };
        const S1: VisionItem = { type: "scope", id: "S1", text: "In: booking a seat in a class of either studio", side: "in" };
        await new DecompositionEngine(scriptedLlm(noneCite, seen)).decompose({ ...INPUT, checkedItems: [S1] });
        expect(seen.verdicts).toEqual([{ ok: true }]);
        resetIdCounter();
        const changed: Seen = { prompts: [], verdicts: [] };
        const earlier: VisionItem = { ...S1, text: "In: booking a seat in a class of one studio" };
        await expect(new DecompositionEngine(scriptedLlm(noneCite, changed)).decompose({ ...INPUT, checkedItems: [earlier] })).rejects.toBeInstanceOf(UncitedVisionItemsError);
        expect(changed.prompts[0]).toContain("a plan that leaves one uncited is rejected: S1.");
    });

    // Every in-scope line becomes a check; whether one does is not the planner's choice.
    test("an in-scope line, or one of no recorded side, cited by no task is rejected; an out-of-scope one need not be cited", async () => {
        const items: VisionItem[] = [
            ...INPUT.visionItems,
            { type: "scope", id: "S2", text: "In: cancelling a booking", side: "in" },
            { type: "scope", id: "S3", text: "Members see their bookings", side: "unclassified" },
            { type: "scope", id: "S4", text: "Out: payments", side: "out" },
        ];
        const input = { ...INPUT, visionItems: items };
        await expect(new DecompositionEngine(scriptedLlm({ assumptions: [], tasks: [task("t1")] }, seen)).decompose(input)).rejects.toBeInstanceOf(UncitedVisionItemsError);
        expect(seen.prompts[0]).toContain("a plan that leaves one uncited is rejected: S1, S2, S3.");
        const errors = seen.verdicts[0]?.ok === false ? seen.verdicts[0].errors.join("\n") : "";
        expect(errors).toContain('No task cites S2 ("In: cancelling a booking"), S3 ("Members see their bookings")');
        expect(errors).not.toContain("S4");
        resetIdCounter();
        const verdicts: StructuredValidation[] = [];
        await new DecompositionEngine(scriptedLlm({ assumptions: [], tasks: [task("t1"), task("t2", {}, ["S2", "S3"])] }, { prompts: [], verdicts })).decompose(input);
        expect(verdicts).toEqual([{ ok: true }]);
    });

    // An assumption of no recorded kind is not evidence that no client could observe it.
    test("an unclassified assumption is citable like a client-visible one", async () => {
        const unclassified: VisionItem = { type: "assumption", id: "A3", text: "Empty names are refused", status: "Inferred", standing: "unrecorded", kind: "unclassified" };
        const input = { ...INPUT, visionItems: [...INPUT.visionItems, unclassified] };
        await new DecompositionEngine(scriptedLlm({ assumptions: [], tasks: [task("t1")] }, seen)).decompose(input);
        expect(seen.prompts[0]).toContain("- A3 (assumption; Inferred; whether the client was shown it is not on record; not classified): Empty names are refused");
        resetIdCounter();
        const verdicts: StructuredValidation[] = [];
        await new DecompositionEngine(scriptedLlm({ assumptions: [], tasks: [task("t1", {}, ["S1", "A3"])] }, { prompts: [], verdicts })).decompose(input);
        expect(verdicts).toEqual([{ ok: true }]);
    });

    test("a vision with no item, or with assumptions and no guarantee, is refused before any model call", async () => {
        const llm = scriptedLlm({ assumptions: [], tasks: [task("t1")] }, seen);
        await expect(new DecompositionEngine(llm).decompose({ ...INPUT, visionItems: [] })).rejects.toBeInstanceOf(VisionItemsMissing);
        await expect(new DecompositionEngine(llm).decompose({ ...INPUT, visionItems: INPUT.visionItems.filter((item) => item.type === "assumption") })).rejects.toBeInstanceOf(VisionItemsMissing);
        expect(seen.prompts).toEqual([]);
    });

    // The traced items are exactly the union of the lines' sources, never chosen beside them.
    test("a task's traced items are exactly the union of its lines' sources, by id or exact text; its check task carries them", async () => {
        const llm = scriptedLlm(
            {
                assumptions: [],
                tasks: [
                    task("t1", {
                        deliverables: [{ text: "a member can book", sources: ["In: booking a seat in a class of either studio"] }],
                        acceptance: [
                            { text: "a member books a seat", sources: ["S1"] },
                            { text: "the twenty-first booking is refused", sources: ["A1", "S1"] },
                        ],
                    }),
                ],
            },
            seen,
        );
        const result = await new DecompositionEngine(llm).decompose(INPUT);

        const implementation = result.tasks.find((t) => t.taskSpec.origin === "decomposition");
        const traced = ["In: booking a seat in a class of either studio", "A class holds at most twenty members"];
        expect(implementation?.taskSpec).toMatchObject({
            visionItems: traced,
            acceptance: [
                { line: "a member books a seat", sources: ["S1"] },
                { line: "the twenty-first booking is refused", sources: ["A1", "S1"] },
            ],
        });
        expect(implementation?.taskSpec.origin === "decomposition" ? implementation.taskSpec.sources.map((s) => s.id) : []).toEqual(["S1", "A1"]);
        expect(implementation?.successCriteria).toEqual(["a member books a seat", "the twenty-first booking is refused"]);
        const check = result.tasks.find((t) => t.taskSpec.origin === "check");
        expect(check?.taskSpec).toMatchObject({ visionItems: traced, acceptance: implementation?.taskSpec.origin === "decomposition" ? implementation.taskSpec.acceptance : [] });
        expect(check?.taskSpec.goal).toContain(`Vision items "Task t1" cites (its checks may test only what these ask for, and the inputs they say to reject; each needs at least one check that decides it, named in that check's "decides"; where each assumption stands with the client is under the assumptions work proceeds on):`);
        expect(check?.taskSpec.goal).toContain("- S1 (in scope): In: booking a seat in a class of either studio");
        expect(check?.taskSpec.goal).toContain("- A1 (assumption; client-visible behaviour): A class holds at most twenty members");
        expect(check?.taskSpec.goal).toContain("- [A1, S1] the twenty-first booking is refused");
        expect(check?.taskSpec.goal).not.toContain("Bookings are recorded in one ledger");
    });

    // Stored checks can together ask for what no product can pass.
    test.each([
        ["a first plan", { kind: "new" } as const],
        ["a revision building on the environment already done", { kind: "existing", taskId: "env-done" } as const],
    ])("in %s one review task waits on every check task and every implementation waits on it", async (_label, environment) => {
        const layout = environment.kind === "new" ? ({ kind: "new" } as const) : ({ kind: "existing", taskId: "layout-done" } as const);
        const llm = scriptedLlm({ assumptions: [], tasks: [task("t1"), task("t2", { dependsOn: ["t1"] })] }, seen);
        const result = await new DecompositionEngine(llm).decompose({ ...INPUT, environment, layout });

        const reviews = result.tasks.filter((t) => t.taskSpec.origin === "review");
        expect(reviews).toHaveLength(1);
        const review = reviews[0];
        const checkIds = result.tasks.filter((t) => t.taskSpec.origin === "check").map((t) => t.id);
        const foundationId = layout.kind === "existing" ? layout.taskId : result.tasks.find((t) => t.taskSpec.origin === "product-scaffold")?.id;
        expect(review?.dependsOn).toEqual([foundationId, ...checkIds]);
        expect(result.dependencyEdges.filter((e) => e.from === review?.id).map((e) => e.to)).toEqual([foundationId, ...checkIds]);
        for (const implementation of result.tasks.filter((t) => t.taskSpec.origin === "decomposition")) {
            expect(result.dependencyEdges).toContainEqual({ from: implementation.id, to: review?.id });
        }
        // Nothing but implementations waits on the review: the check tasks run before it.
        const waiting = result.dependencyEdges.filter((e) => e.to === review?.id).map((e) => e.from);
        expect(waiting.sort()).toEqual(result.tasks.filter((t) => t.taskSpec.origin === "decomposition").map((t) => t.id).sort());
        expect(review?.taskSpec).toMatchObject({ visionItems: INPUT.visionItems.map((item) => item.text), sources: INPUT.visionItems });
    });

    // The planner grades each task; the plan's own tasks keep a fixed level.
    test("each decomposed task keeps its grade and reason; checks never fall below Strong; the plan's own tasks are Strong", async () => {
        const llm = scriptedLlm(
            {
                assumptions: [],
                tasks: [
                    task("t1", { capability: "Light", capabilityReason: "a fully specified one-part change" }),
                    task("t2", { capability: "Frontier", capabilityReason: "a novel design cutting across the product" }),
                ],
            },
            seen,
        );
        const result = await new DecompositionEngine(llm).decompose(INPUT);

        const byTitle = new Map(result.tasks.map((t) => [t.title, t.taskSpec]));
        expect(byTitle.get("Task t1")).toMatchObject({ capability: "Light", capabilityReason: "a fully specified one-part change" });
        expect(byTitle.get("Task t2")).toMatchObject({ capability: "Frontier" });
        expect(byTitle.get('Write the checks for "Task t1"')?.capability).toBe("Strong");
        expect(byTitle.get('Write the checks for "Task t2"')?.capability).toBe("Frontier");
        for (const origin of ["sprint0", "product-scaffold", "review"]) {
            expect(result.tasks.find((t) => t.taskSpec.origin === origin)?.taskSpec.capability, origin).toBe("Strong");
        }
        expect(seen.prompts[0]).toContain('Grade every task\'s difficulty in "capability", one of Light, Medium, Strong, Frontier');
    });

    test.each([
        ["no grade", { capability: undefined }],
        ["a grade that is no level", { capability: "Expert" }],
        ["no reason", { capabilityReason: "" }],
    ])("a task with %s is re-asked through the ladder with the schema's complaint", async (_label, broken) => {
        const answers = [{ assumptions: [], tasks: [task("t1", broken)] }, { assumptions: [], tasks: [task("t1", { capability: "Strong" })] }];
        const taskPrompts: string[] = [];
        const provider: StructuredProvider = {
            async generateStructured(request) {
                taskPrompts.push(request.prompt);
                const parsed = request.schema.safeParse(answers[taskPrompts.length - 1]);
                if (!parsed.success) {
                    throw new SchemaValidationError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`), "fake");
                }
                return { data: parsed.data, model: "fake", provider: "fake", grade: "Strong" };
            },
        };
        const result = await new DecompositionEngine(createGatewayDecompositionLLM(provider, new AbortController().signal)).decompose(INPUT);

        expect(taskPrompts).toHaveLength(2);
        expect(taskPrompts[1]).toContain("Your previous response was REJECTED");
        expect(taskPrompts[1]).toMatch(/tasks\.0\.capability/);
        expect(result.tasks.find((t) => t.taskSpec.origin === "decomposition")?.taskSpec.capability).toBe("Strong");
    });

    test("a grade the model never gives exhausts the ladder: no plan is written on an assumed level", async () => {
        const provider: StructuredProvider = {
            async generateStructured(request) {
                const parsed = request.schema.safeParse({ assumptions: [], tasks: [task("t1", { capability: undefined })] });
                if (parsed.success) throw new Error("the schema accepted a task without a grade");
                throw new SchemaValidationError(parsed.error.issues.map((i) => i.message), "fake");
            },
        };
        await expect(
            new DecompositionEngine(createGatewayDecompositionLLM(provider, new AbortController().signal)).decompose(INPUT),
        ).rejects.toSatisfy((err: unknown) => modelCallFailureOf(err) === "model");
    });
});

const CONTRACT_TENDER = "A key-value store. Clients put and get values from the command line. Deleted keys are gone.";
const PUT_QUOTE = { kind: "tender", quote: "Clients put and get values from the command line." };

/** A stored vision version in the guarantees form: two interface entries, two guarantees, a client-visible and an internal-design assumption. */
const CONTRACT_VISION: StoredVision = {
    projectId: "00000000-0000-4000-8000-0000000000d1",
    version: 1,
    visionText: CONTRACT_TENDER,
    summary: "A key-value store.",
    scopeBoundaries: [],
    inferences: [
        { key: "A1", statement: "Values are text.", rationale: "tender", status: "Inferred", kind: "client-visible", disclosed: "asked", underpins: ["G1"] },
        { key: "A2", statement: "The data lives in one file.", rationale: "simplest", status: "Inferred", kind: "internal-design", disclosed: "reported" },
    ],
    openQuestions: [],
    contractForm: "guarantees",
    interface: [
        { id: "I1", text: "put KEY VALUE stores VALUE under KEY and exits 0", source: PUT_QUOTE },
        { id: "I2", text: "get KEY prints the value stored under KEY, or exits 1 when none is", source: PUT_QUOTE },
    ],
    guarantees: [
        {
            id: "G1",
            statement: "A get prints the value of the last put of its key.",
            observable: { interface: ["I1", "I2"], observation: "output" },
            refutedBy: ["a get after a put prints another value"],
            source: PUT_QUOTE,
        },
        {
            id: "G2",
            statement: "A get of a deleted key finds nothing.",
            observable: { interface: ["I2"], observation: "exit-status" },
            refutedBy: ["a get of a deleted key exits 0"],
            source: { kind: "tender", quote: "Deleted keys are gone." },
        },
    ],
    exclusions: [],
};

describe("a plan against a vision stated as guarantees", () => {
    beforeEach(() => resetIdCounter());

    const contractInput = (): DecompositionInput => {
        const vision = planningVisionOf(CONTRACT_VISION);
        return { ...INPUT, epicNorthStar: vision.northStar, visionItems: vision.items, interface: vision.interface, checkedItems: [] };
    };

    test("its vision items are its guarantees by key, never lines numbered by position, and a plan citing them is accepted", async () => {
        const input = contractInput();
        expect(input.visionItems.map((item) => [item.type, item.id])).toEqual([
            ["guarantee", "G1"],
            ["guarantee", "G2"],
            ["assumption", "A1"],
            ["assumption", "A2"],
        ]);
        expect(input.epicNorthStar).toContain("Guarantees:\n- G1: A get prints the value of the last put of its key.\n- G2: A get of a deleted key finds nothing.");
        const seen: Seen = { prompts: [], verdicts: [] };
        const result = await new DecompositionEngine(scriptedLlm({ assumptions: [], tasks: [task("t1", {}, ["G1", "A1"]), task("t2", {}, ["G2"])] }, seen)).decompose(input);
        expect(seen.verdicts).toEqual([{ ok: true }]);
        expect(seen.prompts[0]).toContain("- G2 (guarantee; observed in its exit-status at I2): A get of a deleted key finds nothing. Refuted by: a get of a deleted key exits 0");
        const cited = result.tasks.flatMap((t) => (t.taskSpec.origin === "decomposition" ? [t.taskSpec.sources.map((s) => s.id)] : []));
        expect(cited).toEqual([["G1", "A1"], ["G2"]]);
        // The check author's brief carries each cited guarantee's refuting observations.
        const check = result.tasks.find((t) => t.taskSpec.origin === "check");
        expect(check?.taskSpec.goal).toContain("Refuted by: a get after a put prints another value");
    });

    test("a plan leaving a guarantee uncited is refused with UncitedVisionItemsError naming that guarantee", async () => {
        const seen: Seen = { prompts: [], verdicts: [] };
        const refused: unknown = await new DecompositionEngine(scriptedLlm({ assumptions: [], tasks: [task("t1", {}, ["G1", "A1"])] }, seen))
            .decompose(contractInput())
            .catch((err: unknown) => err);
        expect(refused).toBeInstanceOf(UncitedVisionItemsError);
        expect(refused instanceof UncitedVisionItemsError ? refused.uncited : []).toEqual([{ id: "G2", text: "A get of a deleted key finds nothing." }]);
        expect(seen.prompts[0]).toContain("a plan that leaves one uncited is rejected: G1, G2.");
    });

    test("an assumption is no item a check decides: a plan citing every guarantee and no assumption is accepted", async () => {
        expect(checkDecides({ type: "assumption", kind: "client-visible" })).toBe(false);
        expect(checkDecides({ type: "assumption", kind: "unclassified" })).toBe(false);
        expect(checkDecides({ type: "guarantee" })).toBe(true);
        const seen: Seen = { prompts: [], verdicts: [] };
        await new DecompositionEngine(scriptedLlm({ assumptions: [], tasks: [task("t1", {}, ["G1"]), task("t2", {}, ["G2"])] }, seen)).decompose(contractInput());
        expect(seen.verdicts).toEqual([{ ok: true }]);
    });

    // A task judged through an interface entry another task builds needs that task merged first: its
    // checks exercise the entry before its own work could pass them.
    test("a task whose acceptance exercises an interface entry only another task's deliverables build depends on that task, never in a cycle", async () => {
        const judgedThroughOther = task("t1", {
            deliverables: [{ text: "deleted keys are gone", sources: ["G2"] }],
            acceptance: [{ text: "a get after a delete finds nothing", sources: ["G2", "G1"] }],
        });
        const derived = await new DecompositionEngine(
            scriptedLlm({ assumptions: [], tasks: [judgedThroughOther, task("t2", {}, ["G1"])] }, { prompts: [], verdicts: [] }),
        ).decompose(contractInput());
        const [t1, t2] = derived.tasks.filter((t) => t.taskSpec.origin === "decomposition");
        expect(derived.dependencyEdges).toContainEqual({ from: t1?.id, to: t2?.id });
        expect(derived.dependencyEdges).not.toContainEqual({ from: t2?.id, to: t1?.id });

        const plannedTheOtherWay = await new DecompositionEngine(
            scriptedLlm({ assumptions: [], tasks: [judgedThroughOther, task("t2", { dependsOn: ["t1"] }, ["G1"])] }, { prompts: [], verdicts: [] }),
        ).decompose(contractInput());
        const [u1, u2] = plannedTheOtherWay.tasks.filter((t) => t.taskSpec.origin === "decomposition");
        expect(plannedTheOtherWay.dependencyEdges).toContainEqual({ from: u2?.id, to: u1?.id });
        expect(plannedTheOtherWay.dependencyEdges).not.toContainEqual({ from: u1?.id, to: u2?.id });
    });

    test("the scaffold's brief carries every interface entry verbatim and its success criterion names each", async () => {
        const result = await new DecompositionEngine(
            scriptedLlm({ assumptions: [], tasks: [task("t1", {}, ["G1"]), task("t2", {}, ["G2"])] }, { prompts: [], verdicts: [] }),
        ).decompose(contractInput());
        const scaffold = result.tasks.find((t) => t.taskSpec.origin === "product-scaffold");
        for (const entry of ["put KEY VALUE stores VALUE under KEY and exits 0", "get KEY prints the value stored under KEY, or exits 1 when none is"]) {
            expect(scaffold?.description).toContain(entry);
            expect(scaffold?.taskSpec.goal).toContain(entry);
        }
        expect(scaffold?.description).toContain("- I1: put KEY VALUE stores VALUE under KEY and exits 0\n- I2: get KEY prints");
        expect(scaffold?.successCriteria).toContainEqual(expect.stringContaining("names every interface entry I1, I2 as the vision states it"));
        expect(scaffold?.description).not.toContain("Choose one form for each");
    });
});
