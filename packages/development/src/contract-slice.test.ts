import { describe, test, expect } from "vitest";
import type { ProjectContract, ProjectId } from "@ashara/shared";
import { formatContractSlice } from "./contract-slice.js";

const TASK_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TASK_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TASK_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const minimalKnowledge = { nodes: [], edges: [] };

function makeContract(overrides?: Partial<ProjectContract>): ProjectContract {
    return {
        projectId: "test-project" as ProjectId,
        version: 1,
        knowledge: minimalKnowledge,
        endpoints: [],
        modules: [],
        mounts: [],
        ...overrides,
    };
}

describe("formatContractSlice — sibling endpoint visibility", () => {
    test("completed siblings appear in 'already built' section", () => {
        const contract = makeContract({
            endpoints: [
                { ref: "auth.register", method: "POST", path: "/api/register", purpose: "Register", declaredBy: TASK_B },
            ],
        });
        const result = formatContractSlice(contract, TASK_A, new Set([TASK_B]));
        expect(result).toContain("## Endpoints already built by other tasks");
        expect(result).toContain("POST /api/register");
        expect(result).not.toContain("planned by other tasks");
    });

    test("non-completed siblings appear in 'planned' section", () => {
        const contract = makeContract({
            endpoints: [
                { ref: "auth.login", method: "POST", path: "/api/login", purpose: "Login", declaredBy: TASK_B },
            ],
        });
        const result = formatContractSlice(contract, TASK_A, new Set());
        expect(result).toContain("## Endpoints planned by other tasks");
        expect(result).toContain("POST /api/login");
        expect(result).not.toContain("already built by other tasks");
    });

    test("mix of completed and planned siblings shows both sections", () => {
        const contract = makeContract({
            endpoints: [
                { ref: "auth.register", method: "POST", path: "/api/register", purpose: "Register", declaredBy: TASK_B },
                { ref: "auth.login", method: "POST", path: "/api/login", purpose: "Login", declaredBy: TASK_C },
            ],
        });
        const result = formatContractSlice(contract, TASK_A, new Set([TASK_B]));
        expect(result).toContain("## Endpoints already built by other tasks");
        expect(result).toContain("POST /api/register");
        expect(result).toContain("## Endpoints planned by other tasks");
        expect(result).toContain("POST /api/login");
    });

    test("no siblings — neither section appears", () => {
        const contract = makeContract({
            endpoints: [
                { ref: "auth.register", method: "POST", path: "/api/register", purpose: "Register", declaredBy: TASK_A },
            ],
        });
        const result = formatContractSlice(contract, TASK_A, new Set());
        expect(result).not.toContain("already built by other tasks");
        expect(result).not.toContain("planned by other tasks");
    });

    test("completedTaskIds undefined — all non-self endpoints shown as planned", () => {
        const contract = makeContract({
            endpoints: [
                { ref: "auth.register", method: "POST", path: "/api/register", purpose: "Register", declaredBy: TASK_B },
                { ref: "auth.login", method: "POST", path: "/api/login", purpose: "Login", declaredBy: TASK_C },
            ],
        });
        const result = formatContractSlice(contract, TASK_A, undefined);
        expect(result).toContain("## Endpoints planned by other tasks");
        expect(result).toContain("POST /api/register");
        expect(result).toContain("POST /api/login");
        expect(result).not.toContain("already built by other tasks");
    });

    test("endpoints without declaredBy are skipped from sibling sections", () => {
        const contract = makeContract({
            endpoints: [
                { ref: "spec.derived", method: "GET", path: "/api/health", purpose: "Health check" },
            ],
        });
        const result = formatContractSlice(contract, TASK_A, new Set());
        expect(result).toBeUndefined();
    });

    test("planned endpoints cause the slice to be returned even with nothing else", () => {
        const contract = makeContract({
            endpoints: [
                { ref: "auth.register", method: "POST", path: "/api/register", purpose: "Register", declaredBy: TASK_B },
            ],
        });
        const result = formatContractSlice(contract, TASK_A, new Set());
        expect(result).toBeDefined();
        expect(result).toContain("planned by other tasks");
    });
});
