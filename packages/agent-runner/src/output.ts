import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentOutputJson } from "@ashara/shared/agent-output";
import type { ConversationResult, ConversationTurn } from "./conversation.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ErrorDetail {
    readonly model: string | null;
    readonly turnCount: number;
    readonly lastToolCall: string | null;
    readonly message: string;
}

/**
 * Agent output collected after the conversation loop. `filesChanged` was
 * removed because the agent runs inside a container where git worktree
 * paths are host-absolute and unreachable — `git status` structurally
 * cannot work. The host (execution-service.ts) already computes the same
 * list via `getChangedFiles(workDir)` in the orchestrator process where
 * the worktree resolves normally, so the agent's copy was always redundant
 * and is now deleted rather than filled with a guess (Discipline D).
 */
export interface AgentOutput {
    readonly status: "done" | "blocked" | "failed";
    readonly summary: string;
    readonly findings: string[];
    readonly error: string | null;
    readonly errorDetail: ErrorDetail | null;
    readonly totalTokens: { input: number; output: number };
    readonly totalCost: number;
    /**
     * `true` when every gateway call in the conversation reported measured
     * token counts; `false` when at least one call was unmeasured. When
     * `false`, `totalCost` is understated — the orchestrator must treat the
     * cost as unknown and charge pessimistically.
     */
    readonly costMeasured: boolean;
    readonly turnCount: number;
    readonly finishReason: "completed" | "turn_limit" | "error";
}

// ---------------------------------------------------------------------------
// JSON serialization shape (snake_case for Rust compatibility)
// AgentOutputJson is the Published Language type from @ashara/shared — the
// single definition that both producer (here) and consumers (execution-service,
// orchestrator) compile against.
// ---------------------------------------------------------------------------

function toJson(output: AgentOutput): AgentOutputJson {
    return {
        status: output.status,
        summary: output.summary,
        findings: output.findings,
        error: output.error,
        error_detail: output.errorDetail
            ? { model: output.errorDetail.model, turn_count: output.errorDetail.turnCount, last_tool_call: output.errorDetail.lastToolCall, message: output.errorDetail.message }
            : null,
        total_tokens: output.totalTokens,
        total_cost: output.totalCost,
        cost_measured: output.costMeasured,
        turn_count: output.turnCount,
        finish_reason: output.finishReason,
    };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FINDING_PREFIXES = ["I found", "I discovered", "Note:", "Warning:", "Issue:"];

// ---------------------------------------------------------------------------
// OutputCollector
// ---------------------------------------------------------------------------

export class OutputCollector {
    constructor(private readonly workingDir: string) {}

    async collect(result: ConversationResult): Promise<AgentOutput> {
        const status = this.determineStatus(result);
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

        if (status === "blocked") {
            const lastToolCall = this.findLastToolCall(result.turns);
            const blockedMarker = this.findBlockedMarker(result.turns);
            const reasonLabel = blockedMarker !== null
                ? `BLOCKED: ${blockedMarker}`
                : "turn limit reached";
            const message = result.finalMessage
                ? `${reasonLabel} — ${result.finalMessage}`
                : reasonLabel;

            errorDetail = {
                model: result.model,
                turnCount,
                lastToolCall,
                message,
            };
            const modelLabel = result.model ?? "unknown";
            summary = `[${modelLabel}, turn ${turnCount}${lastToolCall ? `, last tool: ${lastToolCall}` : ""}] ${reasonLabel}`;
        }

        return {
            status,
            summary,
            findings,
            error: status === "failed" ? result.finalMessage : null,
            errorDetail,
            totalTokens: result.totalTokens,
            totalCost: result.totalCost,
            costMeasured: result.costMeasured,
            turnCount,
            finishReason: result.finishReason,
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

    /**
     * Scans tool results for an explicit BLOCKED: marker and extracts the
     * reason text. Returns the LAST marker found (most specific), or null
     * when blocking was caused by the turn limit rather than an explicit
     * signal. Mirrors the detection logic in {@link determineStatus} so
     * the two agree on what counts as a marker.
     */
    private findBlockedMarker(turns: readonly ConversationTurn[]): string | null {
        let last: string | null = null;
        for (const turn of turns) {
            for (const tr of turn.toolResults) {
                const fromOutput = extractBlockedText(tr.result.output);
                if (fromOutput !== null) last = fromOutput;
                if (tr.result.error) {
                    const fromError = extractBlockedText(tr.result.error);
                    if (fromError !== null) last = fromError;
                }
            }
        }
        return last;
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

}


/**
 * Extracts the reason text after a "BLOCKED:" marker. Returns null when
 * the marker is absent or the text after it is empty (a bare "BLOCKED:"
 * with no explanation). Takes the first line only — multi-line tool
 * output should not bleed into a single-line summary.
 */
function extractBlockedText(text: string): string | null {
    const idx = text.indexOf("BLOCKED:");
    if (idx === -1) return null;
    const rest = text.slice(idx + "BLOCKED:".length).trim();
    const firstLine = rest.split("\n")[0].trim();
    return firstLine.length > 0 ? firstLine : null;
}

