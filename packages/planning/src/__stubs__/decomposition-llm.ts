import type { ZodType } from "zod";

import type { StructuredValidation } from "@ashara/llm-gateway";

import type { DecompositionLLM } from "../decomposition.js";

export class StubDecompositionLLM implements DecompositionLLM {
    async generateStructured<T>(
        prompt: string,
        schema: ZodType<T>,
        _validate?: (value: T) => StructuredValidation,
    ): Promise<T> {
        if (prompt.includes("decompose this epic into tasks")) {
            return schema.parse({
                tasks: [
                    {
                        title: "Set up project structure",
                        description: "Initialize the project with required dependencies and configuration",
                        successCriteria: ["Project builds successfully", "Dependencies installed"],
                        dependsOn: [],
                        goal: "Initialize project scaffold",
                        endState: "Project compiles and runs",
                        scope: "Root project directory",
                        deliverables: ["package.json", "tsconfig.json"],
                        checks: ["npm test passes"],
                    },
                    {
                        title: "Implement core logic",
                        description: "Build the main functionality described in the epic",
                        successCriteria: ["Core logic works end-to-end", "All edge cases handled"],
                        dependsOn: ["Set up project structure"],
                        goal: "Implement primary functionality",
                        endState: "Feature works as specified",
                        scope: "src/ directory",
                        deliverables: ["src/index.ts"],
                        checks: ["npm test passes", "no type errors"],
                    },
                    {
                        title: "Add tests and documentation",
                        description: "Write tests and minimal documentation",
                        successCriteria: ["Tests cover main paths", "README exists"],
                        dependsOn: ["Implement core logic"],
                        goal: "Ensure quality and usability",
                        endState: "Tests pass and docs are readable",
                        scope: "src/ and docs/",
                        deliverables: ["src/__tests__/index.test.ts", "README.md"],
                        checks: ["npm test passes"],
                    },
                ],
            });
        }

        if (prompt.includes("decompose this epic into stories")) {
            return schema.parse({
                stories: [
                    {
                        title: "Core infrastructure setup",
                        description: "Set up the foundational infrastructure for the epic",
                        northStar: "Reliable and scalable foundation",
                        successCriteria: ["Infrastructure is provisioned", "CI/CD pipeline runs successfully"],
                    },
                    {
                        title: "Primary feature implementation",
                        description: "Implement the main feature set described in the epic",
                        northStar: "Feature delivers user value",
                        successCriteria: ["Feature is functional", "All acceptance criteria met"],
                    },
                ],
            });
        }

        if (prompt.includes("decompose this story into tasks")) {
            return schema.parse({
                tasks: [
                    {
                        title: "Implement story functionality",
                        description: "Build the main functionality for this story",
                        successCriteria: ["Functionality works end-to-end"],
                        dependsOn: [],
                        goal: "Deliver story value",
                        endState: "Story acceptance criteria met",
                        scope: "src/ directory",
                        deliverables: ["src/feature.ts"],
                        checks: ["npm test passes"],
                    },
                    {
                        title: "Add story tests",
                        description: "Write tests for story functionality",
                        successCriteria: ["Tests cover success and error paths"],
                        dependsOn: ["Implement story functionality"],
                        goal: "Ensure story quality",
                        endState: "All tests pass",
                        scope: "src/__tests__/",
                        deliverables: ["src/__tests__/feature.test.ts"],
                        checks: ["npm test passes"],
                    },
                ],
            });
        }

        if (prompt.includes("decompose this story into features")) {
            return schema.parse({
                features: [
                    {
                        title: "API endpoint implementation",
                        description: "Implement the REST API endpoints",
                        successCriteria: ["API returns 200 with valid JSON", "Error responses follow standard format"],
                    },
                    {
                        title: "Data validation layer",
                        description: "Add input validation for all endpoints",
                        successCriteria: ["Invalid input returns 400", "Validation errors include field names"],
                    },
                ],
            });
        }

        if (prompt.includes("decompose this feature into tasks")) {
            return schema.parse({
                tasks: [
                    {
                        title: "Implement request handler",
                        description: "Create the HTTP handler for the endpoint",
                        successCriteria: ["Handler processes requests correctly", "Response format matches spec"],
                        dependsOn: [],
                        goal: "Create HTTP request handler for the API endpoint",
                        endState: "API endpoint returns 200 with valid JSON response body",
                        scope: "Only modify files in src/api/",
                        deliverables: ["src/api/handler.ts", "src/api/routes.ts"],
                        checks: ["npm test passes", "no type errors"],
                    },
                    {
                        title: "Add integration tests",
                        description: "Write integration tests for the endpoint",
                        successCriteria: ["Tests cover success and error paths", "Tests run in CI"],
                        dependsOn: ["Implement request handler"],
                        goal: "Write integration tests covering all endpoint behaviors",
                        endState: "Test suite passes with coverage above 80%",
                        scope: "Only modify files in src/api/__tests__/",
                        deliverables: ["src/api/__tests__/handler.test.ts"],
                        checks: ["npm test passes", "coverage threshold met"],
                    },
                ],
            });
        }

        return schema.parse({});
    }
}
