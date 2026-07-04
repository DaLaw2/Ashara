import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type { ConversationResult, ConversationTurn, ConversationToolResult } from "./conversation.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ErrorDetail {
    readonly model: string | null;
    readonly turnCount: number;
    readonly lastToolCall: string | null;
    readonly message: string;
}

export interface AgentOutput {
    readonly status: "done" | "blocked" | "failed";
    readonly summary: string;
    readonly filesChanged: string[];
    readonly findings: string[];
    readonly buildLog: string | null;
    readonly testLog: string | null;
    readonly error: string | null;
    readonly errorDetail: ErrorDetail | null;
    readonly totalTokens: { input: number; output: number };
    readonly totalCost: number;
    readonly turnCount: number;
}

// ---------------------------------------------------------------------------
// JSON serialization shape (snake_case for Rust compatibility)
// ---------------------------------------------------------------------------

interface ErrorDetailJson {
    readonly model: string | null;
    readonly turn_count: number;
    readonly last_tool_call: string | null;
    readonly message: string;
}

interface AgentOutputJson {
    readonly status: "done" | "blocked" | "failed";
    readonly summary: string;
    readonly files_changed: string[];
    readonly findings: string[];
    readonly build_log: string | null;
    readonly test_log: string | null;
    readonly error: string | null;
    readonly error_detail: ErrorDetailJson | null;
    readonly total_tokens: { input: number; output: number };
    readonly total_cost: number;
    readonly turn_count: number;
}

function toJson(output: AgentOutput): AgentOutputJson {
    return {
        status: output.status,
        summary: output.summary,
        files_changed: output.filesChanged,
        findings: output.findings,
        build_log: output.buildLog,
        test_log: output.testLog,
        error: output.error,
        error_detail: output.errorDetail
            ? { model: output.errorDetail.model, turn_count: output.errorDetail.turnCount, last_tool_call: output.errorDetail.lastToolCall, message: output.errorDetail.message }
            : null,
        total_tokens: output.totalTokens,
        total_cost: output.totalCost,
        turn_count: output.turnCount,
    };
}

function fromJson(json: AgentOutputJson): AgentOutput {
    return {
        status: json.status,
        summary: json.summary,
        filesChanged: json.files_changed,
        findings: json.findings,
        buildLog: json.build_log,
        testLog: json.test_log,
        error: json.error,
        errorDetail: json.error_detail
            ? { model: json.error_detail.model, turnCount: json.error_detail.turn_count, lastToolCall: json.error_detail.last_tool_call, message: json.error_detail.message }
            : null,
        totalTokens: json.total_tokens,
        totalCost: json.total_cost,
        turnCount: json.turn_count,
    };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BUILD_PATTERNS = ["build", "compile", "cargo build", "bun build", "npm run build"];
const TEST_PATTERNS = ["test", "cargo test", "bun test", "npm test", "jest", "vitest"];

const FINDING_PREFIXES = ["I found", "I discovered", "Note:", "Warning:", "Issue:"];

// ---------------------------------------------------------------------------
// OutputCollector
// ---------------------------------------------------------------------------

export class OutputCollector {
    constructor(private readonly workingDir: string) {}

    async collect(result: ConversationResult): Promise<AgentOutput> {
        const status = this.determineStatus(result);
        const filesChanged = this.detectChangedFiles(result.turns);
        const buildLog = this.extractBuildLog(result.turns);
        const testLog = this.extractTestLog(result.turns);
        const findings = this.extractFindings(result.turns);
        const turnCount = result.turns.length;

        let errorDetail: ErrorDetail | null = null;
        let summary = result.finalMessage;

        if (status === "failed") {
            const lastToolCall = this.findLastToolCall(result.turns);
            errorDetail = {
                model: result.model,
                turnCount,
                lastToolCall,
                message: result.finalMessage,
            };
            const modelLabel = result.model ?? "unknown";
            summary = `[${modelLabel}, turn ${turnCount}${lastToolCall ? `, last tool: ${lastToolCall}` : ""}] ${result.finalMessage}`;
        }

        return {
            status,
            summary,
            filesChanged,
            findings,
            buildLog,
            testLog,
            error: status === "failed" ? result.finalMessage : null,
            errorDetail,
            totalTokens: result.totalTokens,
            totalCost: result.totalCost,
            turnCount,
        };
    }

    private findLastToolCall(turns: readonly ConversationTurn[]): string | null {
        for (let i = turns.length - 1; i >= 0; i--) {
            const tc = turns[i].toolCalls;
            if (tc.length > 0) {
                return tc[tc.length - 1].name;
            }
        }
        return null;
    }

    detectChangedFiles(turns: readonly ConversationTurn[]): string[] {
        const files = new Set<string>();
        for (const turn of turns) {
            for (const tc of turn.toolCalls) {
                if (tc.name === "write_file" || tc.name === "edit_file") {
                    const path = tc.input["path"];
                    if (typeof path === "string" && path.length > 0) {
                        files.add(path);
                    }
                }
            }
        }
        return [...files];
    }

    extractBuildLog(turns: readonly ConversationTurn[]): string | null {
        return this.extractLogByPatterns(turns, BUILD_PATTERNS);
    }

    extractTestLog(turns: readonly ConversationTurn[]): string | null {
        return this.extractLogByPatterns(turns, TEST_PATTERNS);
    }

    extractFindings(turns: readonly ConversationTurn[]): string[] {
        const findings: string[] = [];

        for (const turn of turns) {
            if (turn.assistantMessage.length === 0) {
                continue;
            }
            const lines = turn.assistantMessage.split("\n");
            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed.length === 0) {
                    continue;
                }
                // Check for known finding prefixes
                if (FINDING_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) {
                    findings.push(trimmed);
                    continue;
                }
                // Check for bullet points (lines starting with "- " in longer messages)
                if (trimmed.startsWith("- ") && trimmed.length > 4) {
                    findings.push(trimmed);
                }
            }
        }

        return findings;
    }

    determineStatus(result: ConversationResult): "done" | "blocked" | "failed" {
        // Check for BLOCKED marker in any tool result
        for (const turn of result.turns) {
            for (const tr of turn.toolResults) {
                if (tr.result.output.includes("BLOCKED:") || (tr.result.error && tr.result.error.includes("BLOCKED:"))) {
                    return "blocked";
                }
            }
        }

        switch (result.finishReason) {
            case "completed":
                return "done";
            case "turn_limit":
                return "blocked";
            case "error":
                return "failed";
        }
    }

    async writeOutput(output: AgentOutput, outputPath: string): Promise<void> {
        const dir = dirname(outputPath);
        await mkdir(dir, { recursive: true });
        const json = toJson(output);
        await writeFile(outputPath, JSON.stringify(json, null, 2) + "\n", "utf-8");
    }

    static async readOutput(outputPath: string): Promise<AgentOutput> {
        const raw = await readFile(outputPath, "utf-8");
        const json = JSON.parse(raw) as AgentOutputJson;
        return fromJson(json);
    }

    // -----------------------------------------------------------------------
    // Private helpers
    // -----------------------------------------------------------------------

    private extractLogByPatterns(turns: readonly ConversationTurn[], patterns: readonly string[]): string | null {
        const logs: string[] = [];

        for (const turn of turns) {
            for (const tr of turn.toolResults) {
                if (!isRunCommandResult(tr, turn)) {
                    continue;
                }
                const command = getCommandFromTurn(tr, turn);
                if (command === null) {
                    continue;
                }
                const lower = command.toLowerCase();
                if (patterns.some((p) => lower.includes(p))) {
                    logs.push(tr.result.output);
                }
            }
        }

        return logs.length > 0 ? logs.join("\n---\n") : null;
    }

}


function isRunCommandResult(tr: ConversationToolResult, _turn: ConversationTurn): boolean {
    return tr.toolName === "run_command";
}

function getCommandFromTurn(tr: ConversationToolResult, turn: ConversationTurn): string | null {
    // Find the matching tool call to retrieve the command argument
    for (const tc of turn.toolCalls) {
        if (tc.id === tr.toolCallId) {
            const input = tc.input as Record<string, unknown>;
            if (typeof input["command"] === "string") {
                return input["command"];
            }
        }
    }
    return null;
}
