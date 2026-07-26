import { appendFileSync, mkdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import type {
    CompletionRequest,
    CompletionResponse,
    ContentBlock,
    Message,
    StreamOptions,
    ToolCall,
    TokenUsage,
    ToolDefinition as GatewayToolDefinition,
} from "@ashara/llm-gateway";
import type { CapabilityLevel } from "@ashara/shared";
import { ASHARA_CONTROL_DIR } from "@ashara/shared";

import type { ToolResult } from "./tools/types.js";
import type { ToolRegistry } from "./tools/index.js";
import { ConversationContextManager } from "./context-manager.js";
import type { FormatAdapter, FileWrite } from "./format-adapter.js";
import { NativeFCAdapter } from "./format-adapter.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ConversationConfig {
    readonly maxTurns: number;
    readonly maxNudges: number;
    readonly staticSystemPrompt: string;
    readonly dynamicSystemPrompt: string;
    readonly tools: GatewayToolDefinition[];
    readonly capability: CapabilityLevel;
    readonly adapter: FormatAdapter;
    readonly contextWindowTokens?: number;
    readonly preserveRecentTools?: number;
    readonly maxOutputTokens?: number;
    readonly workingDir?: string;
    readonly conversationLogPath?: string;
}

export interface ConversationTurn {
    readonly turnNumber: number;
    readonly assistantMessage: string;
    readonly toolCalls: ToolCall[];
    readonly toolResults: ConversationToolResult[];
    readonly tokenUsage: TokenUsage;
    readonly contextTokens: number;
    readonly maskedToolOutputs: number;
}

export interface ConversationToolResult {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly result: ToolResult;
}

export interface ConversationResult {
    readonly turns: ConversationTurn[];
    readonly finalMessage: string;
    readonly finishReason: "completed" | "turn_limit" | "error";
    readonly totalTokens: { input: number; output: number };
    readonly totalCost: number;
    readonly model: string | null;
}

// ---------------------------------------------------------------------------
// Gateway interface (for testability — accepts LLMGateway or any mock)
// ---------------------------------------------------------------------------

export interface Gateway {
    complete(request: CompletionRequest): Promise<CompletionResponse>;
    streamComplete?(request: CompletionRequest, options?: StreamOptions): Promise<CompletionResponse>;
}

// ---------------------------------------------------------------------------
// AgentConversation
// ---------------------------------------------------------------------------

const DEFAULT_MAX_TURNS = 25;
const DEFAULT_MAX_NUDGES = 3;
const MAX_CONTEXT_PRUNES = 2;
const NUDGE_AFTER_TURNS_WITHOUT_WRITE = 5;
const READ_ONLY_TOOLS = new Set(["read_file", "list_directory", "search_codebase"]);
const MAX_OUTPUT_RECOVERY_ATTEMPTS = 3;
const OUTPUT_TOKEN_ESCALATION = [16_384, 32_768, 65_536];
const RECOVERY_MESSAGE =
    "Your previous response was cut off due to length limits. " +
    "Continue exactly where you stopped. Do not recap or repeat anything.";

const ERROR_TEMPLATES = {
    no_tool_calls:
        "You have explored enough. Now implement the changes by writing files. " +
        "Call write_file or edit_file to create or modify files.",
    no_tool_calls_prune:
        "Your previous responses were removed because you did not call any tools. " +
        "You MUST call tools to complete this task. Call write_file now.",
    run_command_loop:
        "STOP. You have been calling run_command repeatedly without writing any files. " +
        "Do NOT start servers or long-running processes. Do NOT run the application. " +
        "Your job is to write code using write_file/edit_file and verify with build/test commands only. " +
        "Call write_file or edit_file NOW.",
    tool_not_found: (name: string, available: string) =>
        `Tool '${name}' does not exist. Available tools: ${available}. ` +
        `Use only tools from this list. Do not invent tool names.`,
    tool_error: (name: string, error: string) =>
        `Tool '${name}' failed: ${error}. ` +
        `Try a different approach — do not retry the identical failing call.`,
} as const;

export class AgentConversation {
    private readonly gateway: Gateway;
    private readonly toolRegistry: ToolRegistry;
    private readonly config: ConversationConfig;
    private readonly contextManager: ConversationContextManager;
    private conversationLogInitialized = false;

    constructor(
        gateway: Gateway,
        toolRegistry: ToolRegistry,
        config: Partial<ConversationConfig> & Pick<ConversationConfig, "staticSystemPrompt" | "tools" | "capability">,
    ) {
        this.gateway = gateway;
        this.toolRegistry = toolRegistry;
        this.config = {
            maxTurns: config.maxTurns ?? DEFAULT_MAX_TURNS,
            maxNudges: config.maxNudges ?? DEFAULT_MAX_NUDGES,
            staticSystemPrompt: config.staticSystemPrompt,
            dynamicSystemPrompt: config.dynamicSystemPrompt ?? "",
            tools: config.tools,
            capability: config.capability,
            adapter: config.adapter ?? new NativeFCAdapter(),
            contextWindowTokens: config.contextWindowTokens,
            preserveRecentTools: config.preserveRecentTools,
            maxOutputTokens: config.maxOutputTokens,
            workingDir: config.workingDir,
            conversationLogPath: config.conversationLogPath,
        };
        this.contextManager = new ConversationContextManager({
            contextWindowTokens: config.contextWindowTokens,
            preserveRecentTools: config.preserveRecentTools,
        });
    }

    private logTurn(turn: ConversationTurn): void {
        const logPath = this.config.conversationLogPath;
        if (!logPath) return;

        if (!this.conversationLogInitialized) {
            mkdirSync(dirname(logPath), { recursive: true });
            this.conversationLogInitialized = true;
        }

        const entry = {
            turn: turn.turnNumber,
            role: "assistant" as const,
            content: turn.assistantMessage,
            toolCalls: turn.toolCalls.map((tc) => ({
                id: tc.id,
                name: tc.name,
                input: tc.input,
            })),
            tokenUsage: turn.tokenUsage,
            contextTokens: turn.contextTokens,
            timestamp: new Date().toISOString(),
        };
        appendFileSync(logPath, JSON.stringify(entry) + "\n");

        if (turn.toolResults.length > 0) {
            const resultsEntry = {
                turn: turn.turnNumber,
                role: "tool" as const,
                toolResults: turn.toolResults.map((tr) => ({
                    name: tr.toolName,
                    success: tr.result.success,
                    output: tr.result.output.slice(0, 2000),
                    error: tr.result.error ?? null,
                })),
                timestamp: new Date().toISOString(),
            };
            appendFileSync(logPath, JSON.stringify(resultsEntry) + "\n");
        }
    }

    async run(initialMessage: string): Promise<ConversationResult> {
        const messages: Message[] = [{ role: "user", content: initialMessage }];
        const turns: ConversationTurn[] = [];
        let totalInput = 0;
        let totalOutput = 0;
        let totalCost = 0;
        let lastText = "";
        let lastModel: string | null = null;
        let nudgeCount = 0;
        let turnsWithoutWrite = 0;
        let pruneCount = 0;

        for (let turn = 0; turn < this.config.maxTurns; turn++) {
            const maxContextTokens = this.config.contextWindowTokens ?? 128_000;
            const targetTokens = maxContextTokens - 33_000;
            const compacted = this.contextManager.compact(messages, targetTokens);

            if (compacted.level !== "none") {
                console.log(
                    `[AgentConversation] turn ${turn + 1}: compacted at level "${compacted.level}" ` +
                        `(removed=${compacted.removedMessages}, compacted=${compacted.compactedMessages}, ` +
                        `tokens=${compacted.totalTokens})`,
                );
            }

            const fullSystemPrompt = this.config.dynamicSystemPrompt
                ? this.config.staticSystemPrompt + "\n\n" + this.config.dynamicSystemPrompt
                : this.config.staticSystemPrompt;

            const request: CompletionRequest = {
                capability: this.config.capability,
                messages: [...compacted.messages],
                systemPrompt: fullSystemPrompt,
                tools: this.config.tools,
                maxTokens: this.config.maxOutputTokens,
                cachePrefixLength: this.config.dynamicSystemPrompt
                    ? this.config.staticSystemPrompt.length
                    : undefined,
                site: "agent-runner",
            };

            let response: CompletionResponse;
            const earlyToolResults = new Map<string, Promise<ToolResult>>();
            const useStreaming = !!this.gateway.streamComplete;

            const streamOptions: StreamOptions | undefined = useStreaming
                ? {
                      onToolCall: (tc: ToolCall) => {
                          if (READ_ONLY_TOOLS.has(tc.name)) {
                              earlyToolResults.set(tc.id, this.executeTool(tc));
                          }
                      },
                  }
                : undefined;

            const callGateway = (req: CompletionRequest) =>
                streamOptions
                    ? this.streamCompleteWithRetry(req, streamOptions)
                    : this.completeWithRetry(req);

            try {
                response = await callGateway(request);
            } catch (err) {
                if (isPromptTooLong(err)) {
                    const reactiveTarget = Math.floor(targetTokens * 0.5);
                    const reactiveCompacted = this.contextManager.compact(messages, reactiveTarget);
                    console.warn(
                        `[AgentConversation] turn ${turn + 1}: prompt too long, reactive compaction ` +
                            `to level "${reactiveCompacted.level}" (tokens=${reactiveCompacted.totalTokens})`,
                    );
                    try {
                        response = await callGateway({
                            ...request,
                            messages: [...reactiveCompacted.messages],
                        });
                    } catch (retryErr) {
                        const errMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
                        return this.buildErrorResult(
                            turns,
                            turn + 1,
                            reactiveCompacted,
                            errMsg,
                            { input: totalInput, output: totalOutput, cost: totalCost },
                            lastModel,
                        );
                    }
                } else {
                    const errMsg = err instanceof Error ? err.message : String(err);
                    return this.buildErrorResult(
                        turns,
                        turn + 1,
                        compacted,
                        errMsg,
                        { input: totalInput, output: totalOutput, cost: totalCost },
                        lastModel,
                    );
                }
            }

            // Output token recovery: detect truncation and retry with escalated limits
            if (response.finishReason === "max_tokens") {
                let recoveryAttempts = 0;
                while (response.finishReason === "max_tokens" && recoveryAttempts < MAX_OUTPUT_RECOVERY_ATTEMPTS) {
                    const escalatedTokens =
                        OUTPUT_TOKEN_ESCALATION[Math.min(recoveryAttempts, OUTPUT_TOKEN_ESCALATION.length - 1)];
                    console.warn(
                        `[AgentConversation] turn ${turn + 1}: output truncated, ` +
                            `escalating maxTokens to ${escalatedTokens} ` +
                            `(attempt ${recoveryAttempts + 1}/${MAX_OUTPUT_RECOVERY_ATTEMPTS})`,
                    );

                    totalInput += response.usage.inputTokens;
                    totalOutput += response.usage.outputTokens;
                    totalCost += response.cost.totalCost;

                    messages.push({ role: "assistant", content: response.content });
                    messages.push({ role: "user", content: RECOVERY_MESSAGE });

                    response = await this.completeWithRetry({
                        ...request,
                        maxTokens: escalatedTokens,
                        messages: [...messages],
                    });

                    recoveryAttempts++;
                }

                if (recoveryAttempts > 0 && response.finishReason !== "max_tokens") {
                    console.log(
                        `[AgentConversation] turn ${turn + 1}: output recovery completed ` +
                            `after ${recoveryAttempts} attempt(s)`,
                    );
                } else if (recoveryAttempts >= MAX_OUTPUT_RECOVERY_ATTEMPTS) {
                    console.warn(
                        `[AgentConversation] turn ${turn + 1}: output recovery exhausted ` +
                            `after ${MAX_OUTPUT_RECOVERY_ATTEMPTS} attempts, proceeding with partial response`,
                    );
                }
            }

            totalInput += response.usage.inputTokens;
            totalOutput += response.usage.outputTokens;
            totalCost += response.cost.totalCost;
            lastText = response.content;
            lastModel = response.model;

            const parsed = this.config.adapter.parseResponse(response);
            const toolCalls = parsed.toolCalls;
            const fileWrites = parsed.fileWrites;
            const hasToolCalls = toolCalls.length > 0;
            const hasFileWrites = fileWrites.length > 0;

            if (hasFileWrites && !hasToolCalls) {
                const fileWriteResults = await this.executeFileWrites(fileWrites);

                messages.push({ role: "assistant", content: response.content });

                const resultBlocks: ContentBlock[] = fileWriteResults.map((fwr, i) => ({
                    type: "tool_result" as const,
                    tool_use_id: `file_write_${turn}_${i}`,
                    name: "write_file",
                    content: fwr.result.success ? fwr.result.output : (fwr.result.error ?? "Unknown error"),
                    is_error: !fwr.result.success,
                }));
                messages.push({ role: "tool", content: resultBlocks });

                if (fileWriteResults.some((fwr) => fwr.result.success)) {
                    turnsWithoutWrite = 0;
                }

                const syntheticToolCalls: ToolCall[] = fileWriteResults.map((fwr, i) => ({
                    id: `file_write_${turn}_${i}`,
                    name: "write_file",
                    input: { path: fwr.path, content: fwr.content },
                }));

                const fileWriteTurn: ConversationTurn = {
                    turnNumber: turn + 1,
                    assistantMessage: response.content,
                    toolCalls: syntheticToolCalls,
                    toolResults: fileWriteResults.map((fwr, i) => ({
                        toolCallId: `file_write_${turn}_${i}`,
                        toolName: "write_file",
                        result: fwr.result,
                    })),
                    tokenUsage: response.usage,
                    contextTokens: compacted.totalTokens,
                    maskedToolOutputs: compacted.compactedMessages,
                };
                turns.push(fileWriteTurn);
                this.logTurn(fileWriteTurn);
                continue;
            }

            if (!hasToolCalls && !hasFileWrites) {
                turnsWithoutWrite++;
                const shouldNudge =
                    response.content.length > 0 &&
                    this.config.tools.length > 0 &&
                    turnsWithoutWrite >= NUDGE_AFTER_TURNS_WITHOUT_WRITE &&
                    nudgeCount < this.config.maxNudges;

                if (shouldNudge) {
                    nudgeCount++;
                    console.warn(
                        `[AgentConversation] turn ${turn + 1}: model returned text without tool calls or file writes, nudging (${nudgeCount}/${this.config.maxNudges})`,
                    );
                    messages.push({ role: "assistant", content: response.content });
                    messages.push({ role: "user", content: ERROR_TEMPLATES.no_tool_calls });
                    continue;
                }

                // Nudges exhausted — try context pruning before giving up
                if (nudgeCount > 0 && nudgeCount >= this.config.maxNudges && pruneCount < MAX_CONTEXT_PRUNES) {
                    pruneCount++;
                    const pruned = this.pruneFailedTurns(messages);
                    console.warn(
                        `[AgentConversation] turn ${turn + 1}: nudges exhausted, pruning ${pruned} failed turns from context (prune ${pruneCount}/${MAX_CONTEXT_PRUNES})`,
                    );
                    messages.push({ role: "user", content: ERROR_TEMPLATES.no_tool_calls_prune });
                    nudgeCount = 0;
                    turnsWithoutWrite = 0;
                    continue;
                }

                const anyToolCallsInHistory = turns.some((t) => t.toolCalls.length > 0);
                const isFailedCompletion = !anyToolCallsInHistory && this.config.tools.length > 0;

                const terminalTurn: ConversationTurn = {
                    turnNumber: turn + 1,
                    assistantMessage: response.content,
                    toolCalls: [],
                    toolResults: [],
                    tokenUsage: response.usage,
                    contextTokens: compacted.totalTokens,
                    maskedToolOutputs: compacted.compactedMessages,
                };
                turns.push(terminalTurn);
                this.logTurn(terminalTurn);
                return {
                    turns,
                    finalMessage: isFailedCompletion
                        ? "Agent completed without using any tools"
                        : response.content,
                    finishReason: isFailedCompletion ? "error" : "completed",
                    totalTokens: { input: totalInput, output: totalOutput },
                    totalCost,
                    model: lastModel,
                };
            }

            // Append assistant message with tool_use blocks to history
            const assistantBlocks: ContentBlock[] = [];
            if (response.content) {
                assistantBlocks.push({ type: "text", text: response.content });
            }
            for (const tc of toolCalls) {
                assistantBlocks.push({
                    type: "tool_use",
                    id: tc.id,
                    name: tc.name,
                    input: tc.input,
                });
            }
            messages.push({ role: "assistant", content: assistantBlocks });

            // Execute each tool call and collect results.
            // When streaming, read-only tools may already be running from the
            // onToolCall callback. Reuse those early results and execute remaining
            // tools. If a write/destructive tool fails, cancel pending work.
            const toolResults: ConversationToolResult[] = [];
            const resultBlocks: ContentBlock[] = [];
            let aborted = false;

            for (const tc of toolCalls) {
                if (aborted) {
                    const cancelError = "Cancelled: a prior write tool failed";
                    toolResults.push({
                        toolCallId: tc.id,
                        toolName: tc.name,
                        result: { success: false, output: "", error: cancelError },
                    });
                    resultBlocks.push({
                        type: "tool_result",
                        tool_use_id: tc.id,
                        name: tc.name,
                        content: cancelError,
                        is_error: true,
                    });
                    continue;
                }

                const earlyPromise = earlyToolResults.get(tc.id);
                const result = earlyPromise
                    ? await earlyPromise
                    : await this.executeTool(tc);

                toolResults.push({
                    toolCallId: tc.id,
                    toolName: tc.name,
                    result,
                });
                resultBlocks.push({
                    type: "tool_result",
                    tool_use_id: tc.id,
                    name: tc.name,
                    content: result.success ? result.output : (result.error ?? "Unknown error"),
                    is_error: !result.success,
                });

                if (!result.success && !READ_ONLY_TOOLS.has(tc.name)) {
                    aborted = true;
                }
            }

            // Append tool results as a single tool message
            messages.push({ role: "tool", content: resultBlocks });

            const hasWriteOrEdit =
                toolCalls.some((tc) => tc.name === "write_file" || tc.name === "edit_file") || hasFileWrites;
            if (hasWriteOrEdit) {
                turnsWithoutWrite = 0;
            } else {
                turnsWithoutWrite++;
            }

            if (
                !hasWriteOrEdit &&
                turnsWithoutWrite >= NUDGE_AFTER_TURNS_WITHOUT_WRITE &&
                nudgeCount < this.config.maxNudges
            ) {
                nudgeCount++;
                console.warn(
                    `[AgentConversation] turn ${turn + 1}: ${turnsWithoutWrite} turns without write_file/edit_file, ` +
                        `nudging (${nudgeCount}/${this.config.maxNudges})`,
                );
                messages.push({ role: "user", content: ERROR_TEMPLATES.run_command_loop });
            }

            const toolTurn: ConversationTurn = {
                turnNumber: turn + 1,
                assistantMessage: response.content,
                toolCalls,
                toolResults,
                tokenUsage: response.usage,
                contextTokens: compacted.totalTokens,
                maskedToolOutputs: compacted.compactedMessages,
            };
            turns.push(toolTurn);
            this.logTurn(toolTurn);
        }

        // Turn limit reached
        return {
            turns,
            finalMessage: lastText,
            finishReason: "turn_limit",
            totalTokens: { input: totalInput, output: totalOutput },
            totalCost,
            model: lastModel,
        };
    }

    private buildErrorResult(
        turns: ConversationTurn[],
        turnNumber: number,
        compacted: { totalTokens: number; compactedMessages: number },
        errMsg: string,
        totals: { input: number; output: number; cost: number },
        model: string | null,
    ): ConversationResult {
        turns.push({
            turnNumber,
            assistantMessage: "",
            toolCalls: [],
            toolResults: [],
            tokenUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
            contextTokens: compacted.totalTokens,
            maskedToolOutputs: compacted.compactedMessages,
        });
        return {
            turns,
            finalMessage: `Gateway error: ${errMsg}`,
            finishReason: "error",
            totalTokens: { input: totals.input, output: totals.output },
            totalCost: totals.cost,
            model,
        };
    }

    private pruneFailedTurns(messages: Message[]): number {
        let pruned = 0;
        // Walk backwards and remove consecutive text-only assistant+user(nudge) pairs
        // Stop at the first message that contains tool_use or tool results
        while (messages.length > 1) {
            const last = messages[messages.length - 1];
            // Remove user nudge messages
            if (last.role === "user" && typeof last.content === "string") {
                messages.pop();
                pruned++;
                continue;
            }
            // Remove text-only assistant messages (no tool_use blocks)
            if (last.role === "assistant") {
                const hasToolUse = Array.isArray(last.content)
                    && last.content.some((b) => b.type === "tool_use");
                if (!hasToolUse) {
                    messages.pop();
                    pruned++;
                    continue;
                }
            }
            break;
        }
        return pruned;
    }

    private async retryWithBackoff<T>(
        fn: () => Promise<T>,
        label: string,
        maxRetries = 3,
    ): Promise<T> {
        let lastError: unknown;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                return await fn();
            } catch (err) {
                lastError = err;
                if (attempt < maxRetries && isTransientError(err)) {
                    const delayMs = 1000 * Math.pow(2, attempt);
                    const errMsg = err instanceof Error ? err.message : String(err);
                    console.warn(
                        `[AgentConversation] transient ${label}error (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delayMs}ms: ${errMsg}`,
                    );
                    await new Promise((resolve) => setTimeout(resolve, delayMs));
                    continue;
                }
                if (attempt === maxRetries) {
                    const errMsg = err instanceof Error ? err.message : String(err);
                    console.warn(`[AgentConversation] all ${maxRetries + 1} ${label}attempts exhausted: ${errMsg}`);
                }
                throw err;
            }
        }
        throw lastError;
    }

    private completeWithRetry(request: CompletionRequest, maxRetries = 3): Promise<CompletionResponse> {
        return this.retryWithBackoff(() => this.gateway.complete(request), "", maxRetries);
    }

    private streamCompleteWithRetry(
        request: CompletionRequest,
        streamOptions: StreamOptions,
        maxRetries = 3,
    ): Promise<CompletionResponse> {
        return this.retryWithBackoff(
            () => this.gateway.streamComplete!(request, streamOptions),
            "stream ",
            maxRetries,
        );
    }

    private async executeFileWrites(
        fileWrites: FileWrite[],
    ): Promise<Array<{ path: string; content: string; result: ToolResult }>> {
        const results: Array<{ path: string; content: string; result: ToolResult }> = [];
        for (const fw of fileWrites) {
            const registered = this.toolRegistry.get("write_file");
            if (!registered?.executor) {
                results.push({
                    path: fw.path,
                    content: fw.content,
                    result: { success: false, output: "", error: "write_file tool not available" },
                });
                continue;
            }
            try {
                const result = await registered.executor.execute({ path: fw.path, content: fw.content });
                results.push({ path: fw.path, content: fw.content, result });
            } catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                results.push({
                    path: fw.path,
                    content: fw.content,
                    result: { success: false, output: "", error: `File write failed: ${errMsg}` },
                });
            }
        }
        return results;
    }

    private async executeTool(toolCall: ToolCall): Promise<ToolResult> {
        const registered = this.toolRegistry.get(toolCall.name);
        if (!registered) {
            const available = this.toolRegistry.names().join(", ");
            return {
                success: false,
                output: "",
                error: ERROR_TEMPLATES.tool_not_found(toolCall.name, available),
            };
        }
        if (!registered.executor) {
            return {
                success: false,
                output: "",
                error: ERROR_TEMPLATES.tool_error(toolCall.name, "no executor attached"),
            };
        }
        try {
            const result = await registered.executor.execute(toolCall.input);
            const maxChars = registered.maxResultSizeChars;
            if (maxChars && result.success && result.output.length > maxChars && this.config.workingDir) {
                return this.truncateResult(result, maxChars, toolCall.id);
            }
            return result;
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            return {
                success: false,
                output: "",
                error: ERROR_TEMPLATES.tool_error(toolCall.name, errMsg),
            };
        }
    }

    private async truncateResult(result: ToolResult, maxChars: number, toolCallId: string): Promise<ToolResult> {
        const overflowDir = join(this.config.workingDir!, ASHARA_CONTROL_DIR, "tool-overflow");
        await mkdir(overflowDir, { recursive: true });
        const overflowPath = join(overflowDir, `${toolCallId}.txt`);
        await writeFile(overflowPath, result.output, "utf-8");

        const preview = result.output.slice(0, maxChars);
        const relativePath = relative(this.config.workingDir!, overflowPath);
        return {
            success: result.success,
            output:
                preview +
                `\n[...truncated ${result.output.length - maxChars} chars. Full output: ${relativePath}. Use read_file to see it.]`,
            overflowPath,
        };
    }
}

const TRANSIENT_STATUS_CODES = [429, 500, 502, 503, 504];
const TRANSIENT_MESSAGE_PATTERNS = [
    /\b429\b/,
    /rate.?limit/i,
    /\b500\b/,
    /\b502\b/,
    /\b503\b/,
    /\b504\b/,
    /ECONNREFUSED/,
    /ETIMEDOUT/,
    /ECONNRESET/,
    /fetch failed/i,
];

function isTransientError(err: unknown): boolean {
    if (err !== null && typeof err === "object" && "status" in err) {
        const status = (err as { status: unknown }).status;
        if (typeof status === "number" && TRANSIENT_STATUS_CODES.includes(status)) {
            return true;
        }
    }
    const message = err instanceof Error ? err.message : String(err);
    return TRANSIENT_MESSAGE_PATTERNS.some((pattern) => pattern.test(message));
}

const PROMPT_TOO_LONG_PATTERNS = [/\b413\b/, /prompt.?too.?long/i, /context.?length.?exceed/i, /token.?limit/i];

function isPromptTooLong(err: unknown): boolean {
    if (err !== null && typeof err === "object" && "status" in err) {
        const status = (err as { status: unknown }).status;
        if (status === 413) return true;
    }
    const message = err instanceof Error ? err.message : String(err);
    return PROMPT_TOO_LONG_PATTERNS.some((pattern) => pattern.test(message));
}
