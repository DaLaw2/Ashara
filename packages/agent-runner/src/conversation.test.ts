import { describe, expect, test, vi, beforeEach } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { AgentConversation } from "./conversation.js";
import { ToolRegistry } from "./tools/index.js";
import { NativeFCAdapter } from "./format-adapter.js";
import type { ToolResult } from "./tools/types.js";

// ---------------------------------------------------------------------------
// Helpers — V4 provider result builders
// ---------------------------------------------------------------------------

const USAGE = {
    inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 50, text: 50, reasoning: undefined },
};

function toolCallResult(name: string, id: string) {
    return {
        content: [
            { type: "tool-call" as const, toolCallId: id, toolName: name, input: "{}" },
        ],
        usage: USAGE,
        finishReason: { unified: "tool-calls" as const, raw: "tool_use" },
        warnings: [],
    };
}

function textResult(text: string) {
    return {
        content: [{ type: "text" as const, text }],
        usage: USAGE,
        finishReason: { unified: "stop" as const, raw: "end_turn" },
        warnings: [],
    };
}

function createMockRegistry(): ToolRegistry {
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
// Core conversation behavior
// ---------------------------------------------------------------------------

describe("AgentConversation — native FC path", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    test("conversation completes normally with tool calls then text", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        vi.spyOn(console, "log").mockImplementation(() => {});

        let callCount = 0;
        const model = new MockLanguageModelV4({
            doGenerate: async () => {
                callCount++;
                if (callCount <= 2) {
                    return toolCallResult("write_file", `tc-${callCount}`);
                }
                return textResult("task complete");
            },
        });

        const registry = createMockRegistry();
        const conversation = new AgentConversation(model, registry, {
            staticSystemPrompt: "test",
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

    test("conversation respects turn limit", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        vi.spyOn(console, "log").mockImplementation(() => {});

        let callCount = 0;
        const model = new MockLanguageModelV4({
            doGenerate: async () => {
                callCount++;
                return toolCallResult("write_file", `tc-${callCount}`);
            },
        });

        const registry = createMockRegistry();
        const conversation = new AgentConversation(model, registry, {
            staticSystemPrompt: "test",
            capability: "Strong" as const,
            adapter: new NativeFCAdapter(),
            maxTurns: 8,
            workingDir: "/workspace",
        });

        const result = await conversation.run("Create a project");

        expect(result.finishReason).toBe("turn_limit");
        expect(result.turns.length).toBe(8);
    });
});

// ---------------------------------------------------------------------------
// costMeasured flag propagation
// ---------------------------------------------------------------------------

describe("AgentConversation — costMeasured propagation", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    test("costMeasured is true when all calls report measured usage", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        vi.spyOn(console, "log").mockImplementation(() => {});

        let callCount = 0;
        const model = new MockLanguageModelV4({
            doGenerate: async () => {
                callCount++;
                if (callCount <= 2) {
                    return toolCallResult("write_file", `tc-${callCount}`);
                }
                return textResult("done");
            },
        });

        const registry = createMockRegistry();
        const conversation = new AgentConversation(model, registry, {
            staticSystemPrompt: "test",
            capability: "Strong" as const,
            adapter: new NativeFCAdapter(),
            maxTurns: 5,
        });

        const result = await conversation.run("Create a project");

        expect(result.finishReason).toBe("completed");
        expect(result.costMeasured).toBe(true);
    });

    test("costMeasured is false when any call has unmeasured usage", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        vi.spyOn(console, "log").mockImplementation(() => {});

        let callCount = 0;
        const model = new MockLanguageModelV4({
            doGenerate: async () => {
                callCount++;
                if (callCount === 1) {
                    return toolCallResult("write_file", "tc-1");
                }
                if (callCount === 2) {
                    return {
                        content: [
                            { type: "tool-call" as const, toolCallId: "tc-2", toolName: "write_file", input: "{}" },
                        ],
                        usage: {
                            inputTokens: {
                                total: undefined as unknown as number,
                                noCache: undefined as unknown as number,
                                cacheRead: undefined,
                                cacheWrite: undefined,
                            },
                            outputTokens: { total: 50, text: 50, reasoning: undefined },
                        },
                        finishReason: { unified: "tool-calls" as const, raw: "tool_use" },
                        warnings: [],
                    };
                }
                return textResult("done");
            },
        });

        const registry = createMockRegistry();
        const conversation = new AgentConversation(model, registry, {
            staticSystemPrompt: "test",
            capability: "Strong" as const,
            adapter: new NativeFCAdapter(),
            maxTurns: 5,
        });

        const result = await conversation.run("Create a project");

        expect(result.finishReason).toBe("completed");
        expect(result.costMeasured).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("AgentConversation — error handling", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    test("returns error result when model throws", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        vi.spyOn(console, "log").mockImplementation(() => {});

        const model = new MockLanguageModelV4({
            doGenerate: async () => {
                throw new Error("Provider unavailable");
            },
        });

        const registry = createMockRegistry();
        const conversation = new AgentConversation(model, registry, {
            staticSystemPrompt: "test",
            capability: "Strong" as const,
            adapter: new NativeFCAdapter(),
            maxTurns: 5,
        });

        const result = await conversation.run("Create a project");

        expect(result.finishReason).toBe("error");
        expect(result.finalMessage).toContain("Provider unavailable");
    });

    test("reports error when agent completes without using tools", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        vi.spyOn(console, "log").mockImplementation(() => {});

        const model = new MockLanguageModelV4({
            doGenerate: async () => textResult("I cannot do that"),
        });

        const registry = createMockRegistry();
        const conversation = new AgentConversation(model, registry, {
            staticSystemPrompt: "test",
            capability: "Strong" as const,
            adapter: new NativeFCAdapter(),
            maxTurns: 5,
        });

        const result = await conversation.run("Create a project");

        expect(result.finishReason).toBe("error");
        expect(result.finalMessage).toBe("Agent completed without using any tools");
    });
});
