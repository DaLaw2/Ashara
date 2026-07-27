import { describe, expect, test, vi, beforeEach } from "vitest";
import type { CompletionResponse } from "@ashara/llm-gateway";
import type { ToolResult } from "./tools/types.js";

// Mock workdir-observer to spy on observation calls. With the nudge
// unconditionally disabled (ADR-060 part 2), observation should never
// run — the mock verifies this.
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
// Nudge policy — ADR-060 part 2
// ---------------------------------------------------------------------------

describe("AgentConversation — nudge policy (ADR-060 part 2)", () => {
    beforeEach(() => {
        snapshotWorkdirMock.mockReset();
        vi.restoreAllMocks();
    });

    test("neither nudge path fires — unconditional policy", async () => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

        // 6 tool-call turns (exceeding the threshold of 5) then a text turn.
        // Both nudge paths are off by policy — this is not contingent on
        // observation failure or any environment condition.
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
            maxNudges: 3,
            workingDir: "/workspace",
        });

        const result = await conversation.run("Create a project");

        expect(result.finishReason).toBe("completed");

        // Progress nudge must not fire
        const progressNudgeWarnings = warnSpy.mock.calls.filter(
            (args) => typeof args[0] === "string"
                && args[0].includes("without visible progress"),
        );
        expect(progressNudgeWarnings).toHaveLength(0);

        // No-tool-calls nudge must not fire
        const noToolCallsWarnings = warnSpy.mock.calls.filter(
            (args) => typeof args[0] === "string"
                && args[0].includes("model returned text without tool calls"),
        );
        expect(noToolCallsWarnings).toHaveLength(0);

        // Observation must not run (gated behind nudge availability)
        expect(snapshotWorkdirMock).toHaveBeenCalledTimes(0);
    });

    test("workdir observation does not run when nudges disabled", async () => {
        // Even with workingDir set and snapshotWorkdir available, the
        // observation is gated behind nudge availability and does not run.
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

        // snapshotWorkdir never called — observation is gated on nudge policy
        expect(snapshotWorkdirMock).toHaveBeenCalledTimes(0);
    });

    test("no workdir observation when workingDir not set", async () => {
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
        expect(snapshotWorkdirMock).toHaveBeenCalledTimes(0);
    });

    test("conversation completes normally with tool calls then text", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});

        let callCount = 0;
        const gateway = {
            complete: async (): Promise<CompletionResponse> => {
                callCount++;
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

        expect(result.finishReason).toBe("completed");
        expect(result.turns.length).toBe(3);
        expect(result.turns[0].toolCalls.length).toBe(1);
        expect(result.turns[2].assistantMessage).toBe("task complete");
    });

    test("nudge does not fire at turn limit despite many turns without progress", async () => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

        // Fill the turn budget with tool calls that produce no observed
        // progress. Without the policy disablement, the progress nudge
        // would fire after turn 5. With it, the conversation runs to the
        // turn limit undisturbed.
        let callCount = 0;
        const gateway = {
            complete: async (): Promise<CompletionResponse> => {
                callCount++;
                return toolCallResponse("write_file", `tc-${callCount}`);
            },
        };

        const registry = createMockRegistry();
        const conversation = new AgentConversation(gateway, registry, {
            staticSystemPrompt: "test",
            tools: [{ name: "write_file", description: "Write a file", parameters: {} }],
            capability: "Strong" as const,
            adapter: new NativeFCAdapter(),
            maxTurns: 8,
            maxNudges: 3,
            workingDir: "/workspace",
        });

        const result = await conversation.run("Create a project");

        expect(result.finishReason).toBe("turn_limit");
        expect(result.turns.length).toBe(8);

        // No nudge of any kind fired despite 8 turns without progress
        const allNudgeWarnings = warnSpy.mock.calls.filter(
            (args) => typeof args[0] === "string"
                && (args[0].includes("without visible progress")
                    || args[0].includes("model returned text without tool calls")),
        );
        expect(allNudgeWarnings).toHaveLength(0);
    });
});
