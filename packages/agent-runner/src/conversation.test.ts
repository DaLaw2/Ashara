import { describe, expect, test, vi, beforeEach } from "vitest";
import type { CompletionResponse } from "@ashara/llm-gateway";
import type { ToolResult } from "./tools/types.js";

// Mock workdir-observer so snapshotWorkdir throws (simulating container git failure).
// Use importOriginal to preserve WorkdirObservationError and other real exports.
const snapshotWorkdirMock = vi.fn();
vi.mock("./workdir-observer.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./workdir-observer.js")>();
    return {
        ...actual,
        snapshotWorkdir: (...args: unknown[]) => snapshotWorkdirMock(...args),
        hasProgressSince: vi.fn().mockReturnValue(false),
    };
});

// Import after mocking
const { AgentConversation } = await import("./conversation.js");
const { ToolRegistry } = await import("./tools/index.js");
const { NativeFCAdapter } = await import("./format-adapter.js");
const { WorkdirObservationError } = await import("./workdir-observer.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USAGE = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 };
const COST = { inputCost: 0, outputCost: 0, cacheSavings: 0, totalCost: 0.001 };

function toolCallResponse(name: string, id: string): CompletionResponse {
    return {
        content: "",
        toolCalls: [{ id, name, input: {} }],
        usage: USAGE,
        cost: COST,
        provider: "test",
        model: "test-model",
        finishReason: "tool_use",
    };
}

function textResponse(text: string): CompletionResponse {
    return {
        content: text,
        usage: USAGE,
        cost: COST,
        provider: "test",
        model: "test-model",
        finishReason: "end_turn",
    };
}

function createMockRegistry(): InstanceType<typeof ToolRegistry> {
    const registry = new ToolRegistry();
    registry.register({
        definition: {
            name: "write_file",
            description: "Write a file",
            inputSchema: { type: "object", properties: {}, required: [] },
        },
        executor: {
            execute: async (_input: Record<string, unknown>): Promise<ToolResult> => ({
                success: true,
                output: "File written successfully",
            }),
        },
    });
    return registry;
}

// ---------------------------------------------------------------------------
// Nudge unavailability — logged once, not per turn
// ---------------------------------------------------------------------------

describe("AgentConversation — workdir observation unavailability", () => {
    beforeEach(() => {
        snapshotWorkdirMock.mockReset();
        vi.restoreAllMocks();
    });

    test("snapshotWorkdir failure is logged once, not repeated on every turn", async () => {
        // Simulate the container scenario: git status fails because
        // worktree .git file points to a host-absolute path.
        snapshotWorkdirMock.mockRejectedValue(
            new WorkdirObservationError("/workspace", "git status", new Error(
                "fatal: not a git repository: /tmp/ashara-work/projects/abc/.git/worktrees/task-xyz",
            )),
        );

        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

        let callCount = 0;
        const gateway = {
            complete: async (): Promise<CompletionResponse> => {
                callCount++;
                // Turns 1-2: tool calls (triggers progress check)
                // Turn 3: text completion (exits the loop)
                if (callCount <= 2) {
                    return toolCallResponse("write_file", `tc-${callCount}`);
                }
                return textResponse("task complete");
            },
        };

        const registry = createMockRegistry();
        const conversation = new AgentConversation(gateway, registry, {
            staticSystemPrompt: "test",
            tools: [{ name: "write_file", description: "Write a file", parameters: {} }],
            capability: "Strong" as const,
            adapter: new NativeFCAdapter(),
            maxTurns: 5,
            workingDir: "/workspace",
        });

        const result = await conversation.run("Create a project");

        // The conversation must complete (not crash)
        expect(result.finishReason).toBe("completed");
        expect(result.turns.length).toBe(3);

        // snapshotWorkdir was called on turn 1, failed, and never retried
        expect(snapshotWorkdirMock).toHaveBeenCalledTimes(1);

        // The unavailability warning was logged exactly once
        const unavailabilityWarnings = warnSpy.mock.calls.filter(
            (args) => typeof args[0] === "string"
                && args[0].includes("progress detection is unavailable"),
        );
        expect(unavailabilityWarnings).toHaveLength(1);
        expect(unavailabilityWarnings[0][0]).toContain("turn 1");
        expect(unavailabilityWarnings[0][0]).toContain("Workdir observation disabled for remaining turns");
    });

    test("no workdir observation attempted when workingDir is not set", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});

        let callCount = 0;
        const gateway = {
            complete: async (): Promise<CompletionResponse> => {
                callCount++;
                if (callCount <= 2) {
                    return toolCallResponse("write_file", `tc-${callCount}`);
                }
                return textResponse("done");
            },
        };

        const registry = createMockRegistry();
        const conversation = new AgentConversation(gateway, registry, {
            staticSystemPrompt: "test",
            tools: [{ name: "write_file", description: "Write a file", parameters: {} }],
            capability: "Strong" as const,
            adapter: new NativeFCAdapter(),
            maxTurns: 5,
            // workingDir deliberately omitted
        });

        const result = await conversation.run("Create a project");

        expect(result.finishReason).toBe("completed");
        // snapshotWorkdir must never be called when there is no workingDir
        expect(snapshotWorkdirMock).toHaveBeenCalledTimes(0);
    });

    test("after first failure, madeProgress is true and nudge does not fire", async () => {
        snapshotWorkdirMock.mockRejectedValue(
            new WorkdirObservationError("/workspace", "git status", new Error("not a git repo")),
        );

        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

        // Run enough turns to trigger the nudge threshold (5 turns without
        // progress), but the observation failure should set madeProgress=true
        // on every turn, preventing the nudge from ever firing.
        let callCount = 0;
        const gateway = {
            complete: async (): Promise<CompletionResponse> => {
                callCount++;
                if (callCount <= 6) {
                    return toolCallResponse("write_file", `tc-${callCount}`);
                }
                return textResponse("done");
            },
        };

        const registry = createMockRegistry();
        const conversation = new AgentConversation(gateway, registry, {
            staticSystemPrompt: "test",
            tools: [{ name: "write_file", description: "Write a file", parameters: {} }],
            capability: "Strong" as const,
            adapter: new NativeFCAdapter(),
            maxTurns: 10,
            workingDir: "/workspace",
        });

        const result = await conversation.run("Create a project");

        expect(result.finishReason).toBe("completed");

        // The nudge message should NOT appear — observation failure means
        // "assume progress" to avoid misleading the agent.
        const nudgeWarnings = warnSpy.mock.calls.filter(
            (args) => typeof args[0] === "string"
                && args[0].includes("without visible progress"),
        );
        expect(nudgeWarnings).toHaveLength(0);
    });

    test("observation works normally when git is available (non-container)", async () => {
        snapshotWorkdirMock.mockResolvedValue({
            files: new Map([["main.rs", "hash1"]]),
            truncated: false,
            totalPaths: 1,
        });

        vi.spyOn(console, "warn").mockImplementation(() => {});

        let callCount = 0;
        const gateway = {
            complete: async (): Promise<CompletionResponse> => {
                callCount++;
                if (callCount <= 2) {
                    return toolCallResponse("write_file", `tc-${callCount}`);
                }
                return textResponse("done");
            },
        };

        const registry = createMockRegistry();
        const conversation = new AgentConversation(gateway, registry, {
            staticSystemPrompt: "test",
            tools: [{ name: "write_file", description: "Write a file", parameters: {} }],
            capability: "Strong" as const,
            adapter: new NativeFCAdapter(),
            maxTurns: 5,
            workingDir: "/workspace",
        });

        await conversation.run("Create a project");

        // snapshotWorkdir was called on every tool-call turn (2 times)
        expect(snapshotWorkdirMock).toHaveBeenCalledTimes(2);
    });
});
