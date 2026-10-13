import { describe, expect, test, beforeEach } from "vitest";
import type { WorkItemSpec } from "./decomposition-types.js";
import { DecompositionEngine, resetIdCounter } from "./decomposition.js";
import type { DecompositionLLM } from "./decomposition.js";

const unreachableLlm: DecompositionLLM = {
    generateStructured: () => Promise.reject(new Error("derive* heuristics must not call the LLM")),
};

describe("derive* heuristics for frontend and CLI patterns", () => {
    let engine: DecompositionEngine;

    beforeEach(() => {
        resetIdCounter();
        engine = new DecompositionEngine(unreachableLlm);
    });

    test("deriveObservableEndState: page/view/component triggers frontend fallback", () => {
        const task: WorkItemSpec = {
            id: "task-0001",
            level: "task",
            title: "Create login page",
            description: "Build the login page with email/password form",
            successCriteria: [],
            parentId: "epic-0001",
            dependsOn: [],
        };
        const spec = engine.generateTaskSpec(task, "decomposition");
        expect(spec.endState).toBe("Page loads and renders correctly in the browser");
    });

    test("deriveObservableEndState: cli/command triggers CLI fallback", () => {
        const task: WorkItemSpec = {
            id: "task-0001",
            level: "task",
            title: "Implement list command",
            description: "Add the list subcommand to the CLI",
            successCriteria: [],
            parentId: "epic-0001",
            dependsOn: [],
        };
        const spec = engine.generateTaskSpec(task, "decomposition");
        expect(spec.endState).toBe("Command executes successfully and produces expected output");
    });

    test("deriveObservableEndState: API pattern still matches first", () => {
        const task: WorkItemSpec = {
            id: "task-0001",
            level: "task",
            title: "Create API endpoint for registration",
            description: "POST /api/register route handler",
            successCriteria: [],
            parentId: "epic-0001",
            dependsOn: [],
        };
        const spec = engine.generateTaskSpec(task, "decomposition");
        expect(spec.endState).toBe("API endpoint responds with correct status codes and response body");
    });

    test("deriveScope: page/view/component triggers frontend scope", () => {
        const task: WorkItemSpec = {
            id: "task-0001",
            level: "task",
            title: "Create dashboard view",
            description: "Build the main dashboard UI",
            successCriteria: [],
            parentId: "epic-0001",
            dependsOn: [],
        };
        const spec = engine.generateTaskSpec(task, "decomposition");
        expect(spec.scope).toContain("UI-related");
    });

    test("deriveScope: command/cli triggers CLI scope", () => {
        const task: WorkItemSpec = {
            id: "task-0001",
            level: "task",
            title: "Add export command to CLI",
            description: "Implement the export subcommand",
            successCriteria: [],
            parentId: "epic-0001",
            dependsOn: [],
        };
        const spec = engine.generateTaskSpec(task, "decomposition");
        expect(spec.scope).toContain("CLI command");
    });

    test("deriveDeliverables: page task gets frontend deliverable", () => {
        const task: WorkItemSpec = {
            id: "task-0001",
            level: "task",
            title: "Build settings page",
            description: "Create the user settings page component",
            successCriteria: [],
            parentId: "epic-0001",
            dependsOn: [],
        };
        const spec = engine.generateTaskSpec(task, "decomposition");
        expect(spec.deliverables[0]).toContain("UI source file");
    });

    test("deriveDeliverables: CLI task gets commands deliverable", () => {
        const task: WorkItemSpec = {
            id: "task-0001",
            level: "task",
            title: "Add init command",
            description: "Implement the CLI init subcommand",
            successCriteria: [],
            parentId: "epic-0001",
            dependsOn: [],
        };
        const spec = engine.generateTaskSpec(task, "decomposition");
        expect(spec.deliverables[0]).toContain("CLI command handler");
    });

});
