import { describe, expect, test, beforeEach } from "vitest";
import type { DecompositionInput, WorkItemSpec } from "./decomposition-types.js";
import { DecompositionEngine, resetIdCounter } from "./decomposition.js";
import type { DecompositionLLM } from "./decomposition.js";

const unreachableLlm: DecompositionLLM = {
    generateStructured: () => Promise.reject(new Error("derive* heuristics must not call the LLM")),
};

function createTestInput(overrides?: Partial<DecompositionInput>): DecompositionInput {
    return {
        epicTitle: "User Authentication System",
        epicNorthStar: "Secure and seamless user identity management",
        epicDescription: "Build a complete authentication system with login, registration, and session management",
        conventions: ["Use typed errors"],
        ...overrides,
    };
}

describe("derive* heuristics for frontend and CLI patterns", () => {
    let engine: DecompositionEngine;

    beforeEach(() => {
        resetIdCounter();
        engine = new DecompositionEngine(unreachableLlm);
    });

    test("deriveObservableEndState: page/view/component triggers frontend fallback", () => {
        const input = createTestInput();
        const task: WorkItemSpec = {
            id: "task-0001",
            level: "task",
            title: "Create login page",
            description: "Build the login page with email/password form",
            successCriteria: [],
            parentId: "epic-0001",
            dependsOn: [],
        };
        const spec = engine.generateTaskSpec(task, input);
        expect(spec.endState).toBe("Page loads and renders correctly in the browser");
    });

    test("deriveObservableEndState: cli/command triggers CLI fallback", () => {
        const input = createTestInput();
        const task: WorkItemSpec = {
            id: "task-0001",
            level: "task",
            title: "Implement list command",
            description: "Add the list subcommand to the CLI",
            successCriteria: [],
            parentId: "epic-0001",
            dependsOn: [],
        };
        const spec = engine.generateTaskSpec(task, input);
        expect(spec.endState).toBe("Command executes successfully and produces expected output");
    });

    test("deriveObservableEndState: API pattern still matches first", () => {
        const input = createTestInput();
        const task: WorkItemSpec = {
            id: "task-0001",
            level: "task",
            title: "Create API endpoint for registration",
            description: "POST /api/register route handler",
            successCriteria: [],
            parentId: "epic-0001",
            dependsOn: [],
        };
        const spec = engine.generateTaskSpec(task, input);
        expect(spec.endState).toBe("API endpoint responds with correct status codes and response body");
    });

    test("deriveScope: page/view/component triggers frontend scope", () => {
        const input = createTestInput();
        const task: WorkItemSpec = {
            id: "task-0001",
            level: "task",
            title: "Create dashboard view",
            description: "Build the main dashboard UI",
            successCriteria: [],
            parentId: "epic-0001",
            dependsOn: [],
        };
        const spec = engine.generateTaskSpec(task, input);
        expect(spec.scope).toContain("UI-related");
    });

    test("deriveScope: command/cli triggers CLI scope", () => {
        const input = createTestInput();
        const task: WorkItemSpec = {
            id: "task-0001",
            level: "task",
            title: "Add export command to CLI",
            description: "Implement the export subcommand",
            successCriteria: [],
            parentId: "epic-0001",
            dependsOn: [],
        };
        const spec = engine.generateTaskSpec(task, input);
        expect(spec.scope).toContain("CLI command");
    });

    test("deriveDeliverables: page task gets frontend deliverable", () => {
        const input = createTestInput();
        const task: WorkItemSpec = {
            id: "task-0001",
            level: "task",
            title: "Build settings page",
            description: "Create the user settings page component",
            successCriteria: [],
            parentId: "epic-0001",
            dependsOn: [],
        };
        const spec = engine.generateTaskSpec(task, input);
        expect(spec.deliverables[0]).toContain("UI source file");
    });

    test("deriveDeliverables: CLI task gets commands deliverable", () => {
        const input = createTestInput();
        const task: WorkItemSpec = {
            id: "task-0001",
            level: "task",
            title: "Add init command",
            description: "Implement the CLI init subcommand",
            successCriteria: [],
            parentId: "epic-0001",
            dependsOn: [],
        };
        const spec = engine.generateTaskSpec(task, input);
        expect(spec.deliverables[0]).toContain("CLI command handler");
    });

});
