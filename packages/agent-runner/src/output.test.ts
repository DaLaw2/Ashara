import { describe, expect, test, vi } from "vitest";
import type { ConversationResult, ConversationTurn, ConversationToolResult } from "./conversation.js";
import type { AgentOutput, ErrorDetail } from "./output.js";
import { OutputCollector } from "./output.js";

// OutputCollector.detectChangedFiles calls observeChangedFiles (git status).
// These tests exercise collect(), not the filesystem — mock the observation.
vi.mock("./workdir-observer.js", () => ({
    observeChangedFiles: vi.fn().mockResolvedValue([]),
    snapshotWorkdir: vi.fn().mockResolvedValue({ files: new Map(), truncated: false, totalPaths: 0 }),
    hasProgressSince: vi.fn().mockReturnValue(false),
    EMPTY_SNAPSHOT: { files: new Map(), truncated: false, totalPaths: 0 },
    MAX_OBSERVABLE_FILES: 500,
}));

// ---------------------------------------------------------------------------
// Helpers — build ConversationResult fixtures with minimal boilerplate
// ---------------------------------------------------------------------------

function toolCall(name: string, id = "tc-1"): ConversationTurn["toolCalls"][number] {
    return { id, name, input: {} };
}

function toolResult(
    toolName: string,
    output: string,
    opts?: { error?: string; toolCallId?: string },
): ConversationToolResult {
    return {
        toolCallId: opts?.toolCallId ?? "tc-1",
        toolName,
        result: { success: true, output, ...(opts?.error !== undefined ? { error: opts.error } : {}) },
    };
}

function turn(
    turnNumber: number,
    opts: {
        assistantMessage?: string;
        toolCalls?: ConversationTurn["toolCalls"];
        toolResults?: ConversationToolResult[];
    } = {},
): ConversationTurn {
    return {
        turnNumber,
        assistantMessage: opts.assistantMessage ?? "",
        toolCalls: opts.toolCalls ?? [],
        toolResults: opts.toolResults ?? [],
        tokenUsage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
        contextTokens: 0,
        maskedToolOutputs: 0,
    };
}

function conversationResult(overrides: Partial<ConversationResult> = {}): ConversationResult {
    return {
        turns: [],
        finalMessage: "",
        finishReason: "completed",
        totalTokens: { input: 1000, output: 500 },
        totalCost: 0.01,
        model: "test-model-v1",
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// blocked diagnostic enrichment
// ---------------------------------------------------------------------------

describe("OutputCollector.collect — blocked diagnostic enrichment", () => {
    const collector = new OutputCollector("/tmp/fake-workdir");

    test("Run 40 shape: turn-limit blocked with empty finalMessage and tool-call-only last turn", async () => {
        // Reproduce Run 40 exactly: 25 turns, last turn is run_command
        // tool-call-only (no assistant text), finishReason turn_limit,
        // finalMessage empty because the LLM produced no text content.
        const turns: ConversationTurn[] = [];
        for (let i = 0; i < 24; i++) {
            turns.push(turn(i + 1, {
                assistantMessage: i < 5 ? "working on it" : "",
                toolCalls: [toolCall("run_command", `tc-${i}`)],
                toolResults: [toolResult("run_command", "ok", { toolCallId: `tc-${i}` })],
            }));
        }
        // Turn 25: tool-call-only, no text — the incident case
        turns.push(turn(25, {
            assistantMessage: "",
            toolCalls: [toolCall("run_command", "tc-24")],
            toolResults: [toolResult("run_command", "cargo build finished", { toolCallId: "tc-24" })],
        }));

        const result = conversationResult({
            turns,
            finalMessage: "",
            finishReason: "turn_limit",
            model: "claude-3-5-sonnet-20241022",
        });

        const output: AgentOutput = await collector.collect(result);

        expect(output.status).toBe("blocked");

        // The summary must be diagnostic ON ITS OWN — not relying on
        // finalMessage which is empty in this case.
        expect(output.summary).toContain("claude-3-5-sonnet-20241022");
        expect(output.summary).toContain("turn 25");
        expect(output.summary).toContain("last tool: run_command");
        expect(output.summary).toContain("turn limit reached");
        // Must NOT be empty — that was the entire incident
        expect(output.summary.length).toBeGreaterThan(0);

        // errorDetail must be populated (it was null before this fix)
        expect(output.errorDetail).not.toBeNull();
        const detail = output.errorDetail as ErrorDetail;
        expect(detail.model).toBe("claude-3-5-sonnet-20241022");
        expect(detail.turnCount).toBe(25);
        expect(detail.lastToolCall).toBe("run_command");
        expect(detail.message).toBe("turn limit reached");
    });

    test("BLOCKED marker: extracts the explicit reason from tool output", async () => {
        const turns = [
            turn(1, {
                toolCalls: [toolCall("run_command", "tc-1")],
                toolResults: [toolResult("run_command", "ok", { toolCallId: "tc-1" })],
            }),
            turn(2, {
                toolCalls: [toolCall("run_command", "tc-2")],
                toolResults: [
                    toolResult("run_command", "BLOCKED: dependency libpq not found in system paths", { toolCallId: "tc-2" }),
                ],
            }),
        ];

        const result = conversationResult({
            turns,
            finalMessage: "I cannot proceed",
            finishReason: "completed",
            model: "claude-3-haiku-20241022",
        });

        const output = await collector.collect(result);

        expect(output.status).toBe("blocked");
        expect(output.summary).toContain("BLOCKED: dependency libpq not found in system paths");
        expect(output.summary).toContain("claude-3-haiku-20241022");
        expect(output.summary).toContain("last tool: run_command");

        const detail = output.errorDetail as ErrorDetail;
        expect(detail.model).toBe("claude-3-haiku-20241022");
        // Non-empty finalMessage appended to the structural reason
        expect(detail.message).toContain("dependency libpq not found in system paths");
        expect(detail.message).toContain("I cannot proceed");
    });

    test("BLOCKED marker in error field (not output) is still extracted", async () => {
        const turns = [
            turn(1, {
                toolCalls: [toolCall("run_command", "tc-1")],
                toolResults: [{
                    toolCallId: "tc-1",
                    toolName: "run_command",
                    result: { success: false, output: "", error: "BLOCKED: git checkout failed — branch does not exist" },
                }],
            }),
        ];

        const result = conversationResult({
            turns,
            finalMessage: "",
            finishReason: "completed",
            model: "test-model",
        });

        const output = await collector.collect(result);

        expect(output.status).toBe("blocked");
        expect(output.summary).toContain("BLOCKED: git checkout failed");
        expect(output.errorDetail).not.toBeNull();
        expect((output.errorDetail as ErrorDetail).message).toContain("git checkout failed");
    });

    test("turn-limit blocked with non-empty finalMessage includes it in errorDetail.message", async () => {
        const turns = [
            turn(1, {
                assistantMessage: "I will try a different approach",
                toolCalls: [toolCall("edit_file", "tc-1")],
                toolResults: [toolResult("edit_file", "ok", { toolCallId: "tc-1" })],
            }),
        ];

        const result = conversationResult({
            turns,
            finalMessage: "I was still working on the build configuration",
            finishReason: "turn_limit",
            model: "test-model",
        });

        const output = await collector.collect(result);

        expect(output.status).toBe("blocked");
        // Summary carries the structural reason, not the raw finalMessage
        expect(output.summary).toContain("turn limit reached");
        // errorDetail.message merges both
        const detail = output.errorDetail as ErrorDetail;
        expect(detail.message).toContain("turn limit reached");
        expect(detail.message).toContain("I was still working on the build configuration");
    });

    test("null model is reported honestly, not fabricated", async () => {
        const result = conversationResult({
            turns: [turn(1)],
            finalMessage: "",
            finishReason: "turn_limit",
            model: null,
        });

        const output = await collector.collect(result);

        expect(output.status).toBe("blocked");
        // "unknown" is the same fallback the failed path uses — honest
        // about the gap rather than inventing a model name
        expect(output.summary).toContain("unknown");
        expect((output.errorDetail as ErrorDetail).model).toBeNull();
    });

    test("failed status still works as before (regression guard)", async () => {
        const turns = [
            turn(1, {
                toolCalls: [toolCall("write_file", "tc-1")],
                toolResults: [toolResult("write_file", "ok", { toolCallId: "tc-1" })],
            }),
        ];

        const result = conversationResult({
            turns,
            finalMessage: "compilation error in main.rs",
            finishReason: "error",
            model: "test-model",
        });

        const output = await collector.collect(result);

        expect(output.status).toBe("failed");
        expect(output.summary).toContain("test-model");
        expect(output.summary).toContain("compilation error in main.rs");
        expect(output.errorDetail).not.toBeNull();
        expect((output.errorDetail as ErrorDetail).message).toBe("compilation error in main.rs");
    });

    test("done status has no errorDetail (regression guard)", async () => {
        const result = conversationResult({
            turns: [turn(1)],
            finalMessage: "task complete",
            finishReason: "completed",
        });

        const output = await collector.collect(result);

        expect(output.status).toBe("done");
        expect(output.errorDetail).toBeNull();
        expect(output.summary).toBe("task complete");
    });
});
