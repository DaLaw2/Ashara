import { describe, expect, test, vi, beforeEach } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import type { ModelConfig } from "@ashara/llm-gateway";
import { AgentConversation } from "./conversation.js";
import { ToolRegistry } from "./tools/index.js";
import type { ToolResult } from "./tools/types.js";

// ---------------------------------------------------------------------------
// Helpers — V4 provider result builders
// ---------------------------------------------------------------------------

const USAGE = {
    inputTokens: { total: 100, noCache: 70, cacheRead: 20, cacheWrite: 10 },
    outputTokens: { total: 50, text: 50, reasoning: undefined },
    raw: { input_tokens: 70, output_tokens: 50, cache_read_input_tokens: 20, cache_creation_input_tokens: 10 },
};

const MODEL_CONFIG: ModelConfig = {
    id: "test-model",
    apiModelId: "test-model",
    provider: "anthropic",
    capabilityLevel: "Strong",
    inputCostPer1M: 3,
    outputCostPer1M: 15,
    maxContextTokens: 100_000,
    cacheReadCostPer1M: 0.3,
    cacheWriteCostPer1M: 3.75,
    priceWindows: [],
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
            taskId: "task-1",
            staticSystemPrompt: "test",
            maxTurns: 5,
            workingDir: "/workspace",
        }, MODEL_CONFIG);

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
            taskId: "task-1",
            staticSystemPrompt: "test",
            maxTurns: 8,
            workingDir: "/workspace",
        }, MODEL_CONFIG);

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
            taskId: "task-1",
            staticSystemPrompt: "test",
            maxTurns: 5,
        }, MODEL_CONFIG);

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
            taskId: "task-1",
            staticSystemPrompt: "test",
            maxTurns: 5,
        }, MODEL_CONFIG);

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
            taskId: "task-1",
            staticSystemPrompt: "test",
            maxTurns: 5,
        }, MODEL_CONFIG);

        const result = await conversation.run("Create a project");

        expect(result.finishReason).toBe("error");
        expect(result.finalMessage).toContain("Provider unavailable");
        expect(result.costMeasured).toBe(false);
    });

    test("a request that throws after a priced step leaves the run unmeasured, warned with task, model and step", async () => {
        vi.spyOn(console, "log").mockImplementation(() => {});
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        let callCount = 0;
        const model = new MockLanguageModelV4({
            doGenerate: async () => {
                callCount++;
                if (callCount === 1) return toolCallResult("write_file", "tc-1");
                throw new Error("Provider unavailable");
            },
        });

        const result = await new AgentConversation(model, createMockRegistry(), {
            taskId: "task-7",
            staticSystemPrompt: "test",
            maxTurns: 5,
        }, MODEL_CONFIG).run("Create a project");

        expect(result.finishReason).toBe("error");
        expect(result.totalCost).toBeGreaterThan(0);
        expect(result.costMeasured).toBe(false);
        expect(warn).toHaveBeenCalledWith(
            expect.stringMatching(/cost unmeasured: task=task-7, model=test-model, step=2: the request threw/),
        );
    });

    test("reports error when agent completes without using tools", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        vi.spyOn(console, "log").mockImplementation(() => {});

        const model = new MockLanguageModelV4({
            doGenerate: async () => textResult("I cannot do that"),
        });

        const registry = createMockRegistry();
        const conversation = new AgentConversation(model, registry, {
            taskId: "task-1",
            staticSystemPrompt: "test",
            maxTurns: 5,
        }, MODEL_CONFIG);

        const result = await conversation.run("Create a project");

        expect(result.finishReason).toBe("error");
        expect(result.finalMessage).toBe("Agent completed without using any tools");
    });
});

// ---------------------------------------------------------------------------
// Step pricing
// ---------------------------------------------------------------------------

describe("AgentConversation — step pricing", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    function twoStepModel(): MockLanguageModelV4 {
        let callCount = 0;
        return new MockLanguageModelV4({
            doGenerate: async () => {
                callCount++;
                return callCount === 1 ? toolCallResult("write_file", "tc-1") : textResult("done");
            },
        });
    }

    test("cache tokens are priced at the model's cache rates", async () => {
        vi.spyOn(console, "log").mockImplementation(() => {});
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        const result = await new AgentConversation(twoStepModel(), createMockRegistry(), {
            taskId: "task-1",
            staticSystemPrompt: "test",
            maxTurns: 5,
        }, MODEL_CONFIG).run("Create a project");

        expect(result.costMeasured).toBe(true);
        expect(result.totalCost).toBeCloseTo(2 * (70 * 3 + 20 * 0.3 + 10 * 3.75 + 50 * 15) / 1_000_000, 12);
        expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("cost unmeasured"));
    });

    test("a reported cache class with no rate leaves the run unmeasured and logs it at warn", async () => {
        vi.spyOn(console, "log").mockImplementation(() => {});
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        const result = await new AgentConversation(twoStepModel(), createMockRegistry(), {
            taskId: "task-1",
            staticSystemPrompt: "test",
            maxTurns: 5,
        }, { ...MODEL_CONFIG, cacheReadCostPer1M: null }).run("Create a project");

        expect(result.costMeasured).toBe(false);
        expect(warn).toHaveBeenCalledWith(
            expect.stringMatching(/cost unmeasured: provider=mock-provider, model=test-model, .*no rate=\[cacheReadTokens\]/),
        );
    });
});
