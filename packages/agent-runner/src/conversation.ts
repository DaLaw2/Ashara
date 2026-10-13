import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { generateText, isStepCount } from "ai";
import type { LanguageModel, ModelMessage, ToolSet, StepResult } from "ai";
import type { ModelConfig, CostBreakdown, TokenUsage } from "@ashara/llm-gateway";
import { extractUsage, calculateCost } from "@ashara/llm-gateway";
import type { CapabilityLevel } from "@ashara/shared";
import { ASHARA_CONTROL_DIR } from "@ashara/shared";
import type { ToolRegistry } from "./tools/index.js";
import type { FormatAdapter, FileWrite } from "./format-adapter.js";
import { NativeFCAdapter, CodeFenceAdapter } from "./format-adapter.js";
import type { ToolResult } from "./tools/types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ConversationConfig {
    readonly maxTurns: number;
    readonly maxNudges: number;
    readonly staticSystemPrompt: string;
    readonly dynamicSystemPrompt: string;
    readonly capability: CapabilityLevel;
    readonly adapter: FormatAdapter;
    readonly contextWindowTokens?: number;
    readonly maxOutputTokens?: number;
    readonly workingDir?: string;
    readonly conversationLogPath?: string;
    readonly allowedTools?: ReadonlySet<string>;
}

export interface ConversationTurn {
    readonly turnNumber: number;
    readonly assistantMessage: string;
    readonly toolCalls: TurnToolCall[];
    readonly toolResults: ConversationToolResult[];
    readonly tokenUsage: TokenUsage;
    readonly contextTokens: number;
    readonly maskedToolOutputs: number;
}

export interface TurnToolCall {
    readonly id: string;
    readonly name: string;
    readonly input: Record<string, unknown>;
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
    /**
     * `true` when EVERY gateway call in the conversation reported measured
     * token counts; `false` when at least one call was unmeasured. A `false`
     * here means `totalCost` is understated — downstream must treat the
     * whole run's cost as unknown rather than trusting the accumulated number.
     */
    readonly costMeasured: boolean;
    readonly model: string | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_TURNS = 25;
const DEFAULT_MAX_NUDGES = 3;

// ---------------------------------------------------------------------------
// AgentConversation
// ---------------------------------------------------------------------------

export class AgentConversation {
    private readonly model: LanguageModel;
    private readonly toolRegistry: ToolRegistry;
    private readonly config: ConversationConfig;
    private readonly modelConfig: ModelConfig | undefined;
    private conversationLogInitialized = false;

    constructor(
        model: LanguageModel,
        toolRegistry: ToolRegistry,
        config: Partial<ConversationConfig> & Pick<ConversationConfig, "staticSystemPrompt" | "capability">,
        modelConfig?: ModelConfig,
    ) {
        this.model = model;
        this.toolRegistry = toolRegistry;
        this.config = {
            maxTurns: config.maxTurns ?? DEFAULT_MAX_TURNS,
            maxNudges: config.maxNudges ?? DEFAULT_MAX_NUDGES,
            staticSystemPrompt: config.staticSystemPrompt,
            dynamicSystemPrompt: config.dynamicSystemPrompt ?? "",
            capability: config.capability,
            adapter: config.adapter ?? new NativeFCAdapter(),
            contextWindowTokens: config.contextWindowTokens,
            maxOutputTokens: config.maxOutputTokens,
            workingDir: config.workingDir,
            conversationLogPath: config.conversationLogPath,
            allowedTools: config.allowedTools,
        };
        this.modelConfig = modelConfig;
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
        if (this.config.adapter instanceof CodeFenceAdapter) {
            return this.runCodeFencePath(initialMessage);
        }
        return this.runNativeFCPath(initialMessage);
    }

    // -----------------------------------------------------------------------
    // Native function-calling path — delegates the tool loop to the AI SDK
    // -----------------------------------------------------------------------

    private async runNativeFCPath(initialMessage: string): Promise<ConversationResult> {
        const overflowDir = this.config.workingDir
            ? join(this.config.workingDir, ASHARA_CONTROL_DIR, "tool-overflow")
            : undefined;

        const tools = this.toolRegistry.asAiSdkTools({
            overflowDir,
            allowedTools: this.config.allowedTools,
        });
        const fullSystemPrompt = this.config.dynamicSystemPrompt
            ? this.config.staticSystemPrompt + "\n\n" + this.config.dynamicSystemPrompt
            : this.config.staticSystemPrompt;

        const turns: ConversationTurn[] = [];
        let totalInput = 0;
        let totalOutput = 0;
        let totalCost = 0;
        let allCostsMeasured = true;
        let lastModel: string | null = null;

        const maxTurns = this.config.maxTurns;
        const maxContextTokens = this.config.contextWindowTokens ?? 128_000;
        const compactionTarget = maxContextTokens - 33_000;

        try {
            const result = await generateText({
                model: this.model,
                system: fullSystemPrompt,
                messages: [{ role: "user" as const, content: initialMessage }],
                tools,
                maxRetries: 3,
                maxOutputTokens: this.config.maxOutputTokens,
                stopWhen: isStepCount(maxTurns),

                prepareStep: ({ messages, stepNumber }) => {
                    const tokenEstimate = estimateModelMessageTokens(messages);
                    if (tokenEstimate > compactionTarget && stepNumber > 0) {
                        console.log(
                            `[AgentConversation] step ${stepNumber}: compacting messages ` +
                            `(estimated ${tokenEstimate} tokens, target ${compactionTarget})`,
                        );
                        return { messages: compactModelMessages(messages, compactionTarget) };
                    }
                    return {};
                },

                onStepEnd: (stepResult) => {
                    const cost = this.recordStepCost(stepResult.usage, stepResult.providerMetadata);
                    totalInput += cost.usage.inputTokens;
                    totalOutput += cost.usage.outputTokens;
                    totalCost += cost.cost.totalCost;
                    if (!cost.cost.measured) allCostsMeasured = false;

                    lastModel = `${stepResult.model.provider}:${stepResult.model.modelId}`;

                    const toolCalls: TurnToolCall[] = stepResult.toolCalls.map((tc) => ({
                        id: tc.toolCallId,
                        name: tc.toolName,
                        input: (typeof tc.input === "object" && tc.input !== null
                            ? tc.input
                            : {}) as Record<string, unknown>,
                    }));

                    const toolResults: ConversationToolResult[] = stepResult.toolResults.map((tr) => {
                        const outputStr = typeof tr.output === "string"
                            ? tr.output
                            : JSON.stringify(tr.output);
                        const isError = outputStr.startsWith('{"type":"error"');
                        return {
                            toolCallId: tr.toolCallId,
                            toolName: tr.toolName,
                            result: {
                                success: !isError,
                                output: outputStr,
                                error: isError ? outputStr : undefined,
                            },
                        };
                    });

                    const turn: ConversationTurn = {
                        turnNumber: stepResult.stepNumber + 1,
                        assistantMessage: stepResult.text,
                        toolCalls,
                        toolResults,
                        tokenUsage: cost.usage,
                        contextTokens: 0,
                        maskedToolOutputs: 0,
                    };
                    turns.push(turn);
                    this.logTurn(turn);
                },
            });

            const hitTurnLimit = result.steps.length >= maxTurns;
            const lastStep = result.steps[result.steps.length - 1];
            const anyToolCalls = turns.some((t) => t.toolCalls.length > 0);
            const noToolsUsed = !anyToolCalls && Object.keys(tools).length > 0;

            return {
                turns,
                finalMessage: noToolsUsed
                    ? "Agent completed without using any tools"
                    : result.text,
                finishReason: hitTurnLimit
                    ? "turn_limit"
                    : noToolsUsed
                        ? "error"
                        : "completed",
                totalTokens: { input: totalInput, output: totalOutput },
                totalCost,
                costMeasured: allCostsMeasured,
                model: lastModel,
            };
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            return this.buildErrorResult(turns, turns.length + 1, errMsg, {
                input: totalInput,
                output: totalOutput,
                cost: totalCost,
                measured: allCostsMeasured,
            }, lastModel);
        }
    }

    // -----------------------------------------------------------------------
    // Code-fence fallback — manual loop for models without native FC
    // -----------------------------------------------------------------------

    private async runCodeFencePath(initialMessage: string): Promise<ConversationResult> {
        const messages: ModelMessage[] = [{ role: "user", content: initialMessage }];
        const turns: ConversationTurn[] = [];
        let totalInput = 0;
        let totalOutput = 0;
        let totalCost = 0;
        let allCostsMeasured = true;
        let lastText = "";
        let lastModel: string | null = null;

        const fullSystemPrompt = this.config.dynamicSystemPrompt
            ? this.config.staticSystemPrompt + "\n\n" + this.config.dynamicSystemPrompt
            : this.config.staticSystemPrompt;

        for (let turn = 0; turn < this.config.maxTurns; turn++) {
            const maxContextTokens = this.config.contextWindowTokens ?? 128_000;
            const compactionTarget = maxContextTokens - 33_000;
            const tokenEstimate = estimateModelMessageTokens(messages);

            if (tokenEstimate > compactionTarget && turn > 0) {
                console.log(
                    `[AgentConversation] code-fence turn ${turn + 1}: compacting messages ` +
                    `(estimated ${tokenEstimate} tokens, target ${compactionTarget})`,
                );
                const compacted = compactModelMessages(messages, compactionTarget);
                messages.length = 0;
                messages.push(...compacted);
            }

            let result;
            try {
                result = await generateText({
                    model: this.model,
                    system: fullSystemPrompt,
                    messages: [...messages],
                    maxRetries: 3,
                    maxOutputTokens: this.config.maxOutputTokens,
                });
            } catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                return this.buildErrorResult(turns, turn + 1, errMsg, {
                    input: totalInput,
                    output: totalOutput,
                    cost: totalCost,
                    measured: allCostsMeasured,
                }, lastModel);
            }

            const cost = this.recordStepCost(result.usage, result.providerMetadata);
            totalInput += cost.usage.inputTokens;
            totalOutput += cost.usage.outputTokens;
            totalCost += cost.cost.totalCost;
            if (!cost.cost.measured) allCostsMeasured = false;
            lastText = result.text;
            lastModel = `${result.finalStep.model.provider}:${result.finalStep.model.modelId}`;

            const parsed = this.config.adapter.parseResponse({
                content: result.text,
            });

            const fileWrites = parsed.fileWrites;
            if (fileWrites.length === 0) {
                const terminalTurn: ConversationTurn = {
                    turnNumber: turn + 1,
                    assistantMessage: result.text,
                    toolCalls: [],
                    toolResults: [],
                    tokenUsage: cost.usage,
                    contextTokens: 0,
                    maskedToolOutputs: 0,
                };
                turns.push(terminalTurn);
                this.logTurn(terminalTurn);
                return {
                    turns,
                    finalMessage: result.text,
                    finishReason: "completed",
                    totalTokens: { input: totalInput, output: totalOutput },
                    totalCost,
                    costMeasured: allCostsMeasured,
                    model: lastModel,
                };
            }

            const fileWriteResults = await this.executeFileWrites(fileWrites);
            messages.push({ role: "assistant", content: result.text });

            const resultSummary = fileWriteResults.map((fwr) =>
                fwr.result.success
                    ? `Wrote ${fwr.path} successfully`
                    : `Failed to write ${fwr.path}: ${fwr.result.error ?? "Unknown error"}`
            ).join("\n");
            messages.push({ role: "user", content: `File write results:\n${resultSummary}` });

            const syntheticToolCalls: TurnToolCall[] = fileWriteResults.map((fwr, i) => ({
                id: `file_write_${turn}_${i}`,
                name: "write_file",
                input: { path: fwr.path, content: fwr.content },
            }));

            const codeFenceTurn: ConversationTurn = {
                turnNumber: turn + 1,
                assistantMessage: result.text,
                toolCalls: syntheticToolCalls,
                toolResults: fileWriteResults.map((fwr, i) => ({
                    toolCallId: `file_write_${turn}_${i}`,
                    toolName: "write_file",
                    result: fwr.result,
                })),
                tokenUsage: cost.usage,
                contextTokens: 0,
                maskedToolOutputs: 0,
            };
            turns.push(codeFenceTurn);
            this.logTurn(codeFenceTurn);
        }

        return {
            turns,
            finalMessage: lastText,
            finishReason: "turn_limit",
            totalTokens: { input: totalInput, output: totalOutput },
            totalCost,
            costMeasured: allCostsMeasured,
            model: lastModel,
        };
    }

    // -----------------------------------------------------------------------
    // Cost tracking
    // -----------------------------------------------------------------------

    private recordStepCost(
        sdkUsage: { inputTokens?: number; outputTokens?: number } | undefined,
        providerMetadata: Record<string, Record<string, unknown>> | undefined,
    ): { usage: TokenUsage; cost: CostBreakdown } {
        const extraction = extractUsage(sdkUsage, providerMetadata);
        if (!this.modelConfig || !extraction.measured) {
            return {
                usage: extraction.usage,
                cost: {
                    inputCost: 0,
                    outputCost: 0,
                    cacheSavings: 0,
                    totalCost: 0,
                    measured: extraction.measured,
                },
            };
        }
        const cost = calculateCost(
            extraction.usage.inputTokens,
            extraction.usage.outputTokens,
            extraction.usage.cacheReadTokens,
            extraction.usage.cacheWriteTokens,
            this.modelConfig,
        );
        return {
            usage: extraction.usage,
            cost: { ...cost, measured: true },
        };
    }

    // -----------------------------------------------------------------------
    // Shared helpers
    // -----------------------------------------------------------------------

    private buildErrorResult(
        turns: ConversationTurn[],
        turnNumber: number,
        errMsg: string,
        totals: { input: number; output: number; cost: number; measured: boolean },
        model: string | null,
    ): ConversationResult {
        turns.push({
            turnNumber,
            assistantMessage: "",
            toolCalls: [],
            toolResults: [],
            tokenUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
            contextTokens: 0,
            maskedToolOutputs: 0,
        });
        return {
            turns,
            finalMessage: `Gateway error: ${errMsg}`,
            finishReason: "error",
            totalTokens: { input: totals.input, output: totals.output },
            totalCost: totals.cost,
            costMeasured: totals.measured,
            model,
        };
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
}

// ---------------------------------------------------------------------------
// Message compaction for ModelMessage[] — lightweight token management
// ---------------------------------------------------------------------------

function estimateModelMessageTokens(messages: readonly ModelMessage[]): number {
    let total = 0;
    for (const msg of messages) {
        if (typeof msg.content === "string") {
            total += Math.max(1, Math.ceil(msg.content.length / 4));
        } else if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
                if ("text" in part && typeof part.text === "string") {
                    total += Math.max(1, Math.ceil(part.text.length / 4));
                } else if ("result" in part && typeof part.result === "string") {
                    total += Math.max(1, Math.ceil(part.result.length / 4));
                } else {
                    total += 50;
                }
            }
        }
    }
    return total;
}

function compactModelMessages(messages: readonly ModelMessage[], targetTokens: number): ModelMessage[] {
    if (messages.length <= 3) return [...messages];

    const recentCount = Math.min(8, Math.floor(messages.length / 2));
    const first = messages[0];
    const recent = messages.slice(-recentCount);
    const old = messages.slice(1, messages.length - recentCount);

    const summary = buildModelMessageSummary(old);
    const result: ModelMessage[] = [
        first,
        { role: "user", content: summary },
        ...recent,
    ];

    const newEstimate = estimateModelMessageTokens(result);
    if (newEstimate > targetTokens && recentCount > 2) {
        return [
            first,
            { role: "user", content: summary },
            ...messages.slice(-2),
        ];
    }

    return result;
}

function buildModelMessageSummary(messages: readonly ModelMessage[]): string {
    const toolCalls: string[] = [];

    for (const msg of messages) {
        if (msg.role !== "assistant" || typeof msg.content === "string") continue;
        if (!Array.isArray(msg.content)) continue;
        for (const part of msg.content) {
            if ("type" in part && part.type === "tool-call" && "toolName" in part) {
                const name = (part as { toolName: string }).toolName;
                toolCalls.push(`- ${name}`);
            }
        }
    }

    const parts = ["Previous work (summarized):"];
    if (toolCalls.length > 0) {
        parts.push(`Tool calls:\n${toolCalls.join("\n")}`);
    } else {
        parts.push(`(${messages.length} earlier messages with no tracked tool activity)`);
    }
    return parts.join("\n");
}
