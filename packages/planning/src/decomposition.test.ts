import { describe, expect, test, beforeEach } from "vitest";

import type { DecompositionInput, WorkItemSpec } from "./decomposition-types.js";
import { DecompositionEngine, buildContextAwareExamples, resetIdCounter } from "./decomposition.js";

function createTestInput(overrides?: Partial<DecompositionInput>): DecompositionInput {
    return {
        epicTitle: "User Authentication System",
        epicNorthStar: "Secure and seamless user identity management",
        epicDescription: "Build a complete authentication system with login, registration, and session management",
        conventions: ["Use typed errors"],
        ...overrides,
    };
}

describe("buildContextAwareExamples", () => {
    test("returns generic examples regardless of description", () => {
        const examples = buildContextAwareExamples("Build a simple frontend with login page");
        expect(examples.titleExample).toContain("user registration feature");
        expect(examples.deliverablesExample).toContain("relevant source files");
        expect(examples.endStateExample).toContain("works as specified");
        expect(examples.checksExample).toContain("build and test commands pass");
    });

    test("returns same examples for any description", () => {
        const frontend = buildContextAwareExamples("Build a simple frontend with login page");
        const cli = buildContextAwareExamples("Build a CLI tool with list subcommand");
        const api = buildContextAwareExamples("Build a REST API with user registration");
        expect(frontend.titleExample).toBe(cli.titleExample);
        expect(frontend.titleExample).toBe(api.titleExample);
    });
});

describe("derive* heuristics for frontend and CLI patterns", () => {
    let engine: DecompositionEngine;

    beforeEach(() => {
        resetIdCounter();
        engine = new DecompositionEngine(null);
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
        expect(spec.scope).toContain("public/");
        expect(spec.scope).toContain("src/pages/");
        expect(spec.scope).toContain("src/components/");
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
        expect(spec.scope).toContain("src/commands/");
        expect(spec.scope).toContain("src/cli/");
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
        expect(spec.deliverables[0]).toContain("public/index.html");
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
        expect(spec.deliverables[0]).toContain("src/commands/");
    });

    test("deriveChecks: page task gets markup check", () => {
        const input = createTestInput();
        const task: WorkItemSpec = {
            id: "task-0001",
            level: "task",
            title: "Create signup page",
            description: "Build the signup page UI",
            successCriteria: [],
            parentId: "epic-0001",
            dependsOn: [],
        };
        const spec = engine.generateTaskSpec(task, input);
        expect(spec.checks).toContain("Page file exists and contains expected markup");
    });

    test("deriveChecks: CLI command gets generic exit check", () => {
        const input = createTestInput({
            knowledge: {
                nodes: [{ id: "lang-rust", kind: "language", label: "Rust" }],
                edges: [],
            },
        });
        const task: WorkItemSpec = {
            id: "task-0001",
            level: "task",
            title: "Implement status command",
            description: "Add the status subcommand to the CLI",
            successCriteria: [],
            parentId: "epic-0001",
            dependsOn: [],
        };
        const spec = engine.generateTaskSpec(task, input);
        expect(spec.checks).toContain("CLI command exits 0");
    });
});
