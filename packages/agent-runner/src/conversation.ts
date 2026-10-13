import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { generateText, isStepCount } from "ai";
import type { LanguageModel } from "ai";
import type { CostMeasurement, ModelConfig, TokenUsage } from "@ashara/llm-gateway";
import { describeUnmeasuredCost, extractUsage, measureCost } from "@ashara/llm-gateway";
import { ASHARA_CONTROL_DIR } from "@ashara/shared";
import type { ToolRegistry } from "./tools/index.js";
import type { ToolResult } from "./tools/types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ConversationConfig {
    /** The brief's task, named in every warning this conversation logs. */
    readonly taskId: string;
    readonly maxTurns: number;
    readonly staticSystemPrompt: string;
    readonly dynamicSystemPrompt: string;
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
}

interface TurnToolCall {
    readonly id: string;
    readonly name: string;
    readonly input: Record<string, unknown>;
}

interface ConversationToolResult {
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

// ---------------------------------------------------------------------------
// AgentConversation
// ---------------------------------------------------------------------------

export class AgentConversation {
    private readonly model: LanguageModel;
    private readonly toolRegistry: ToolRegistry;
    private readonly config: ConversationConfig;
    /** Required: without the model's rates no step can be priced, and an unpriced step must not read as $0. */
    private readonly modelConfig: ModelConfig;
    private conversationLogInitialized = false;

    constructor(
        model: LanguageModel,
        toolRegistry: ToolRegistry,
        config: Partial<ConversationConfig> & Pick<ConversationConfig, "staticSystemPrompt" | "taskId">,
        modelConfig: ModelConfig,
    ) {
        this.model = model;
        this.toolRegistry = toolRegistry;
        this.config = {
            taskId: config.taskId,
            maxTurns: config.maxTurns ?? DEFAULT_MAX_TURNS,
            staticSystemPrompt: config.staticSystemPrompt,
            dynamicSystemPrompt: config.dynamicSystemPrompt ?? "",
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

    /** Native function-calling loop; the AI SDK drives the tool steps. */
    async run(initialMessage: string): Promise<ConversationResult> {
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

        try {
            const result = await generateText({
                model: this.model,
                system: fullSystemPrompt,
                messages: [{ role: "user" as const, content: initialMessage }],
                tools,
                maxRetries: 3,
                stopWhen: isStepCount(maxTurns),

                onStepEnd: (stepResult) => {
                    const cost = this.recordStepCost(
                        stepResult.usage,
                        stepResult.model.provider,
                        stepResult.stepNumber,
                    );
                    totalInput += cost.usage.inputTokens;
                    totalOutput += cost.usage.outputTokens;
                    if (cost.cost.measured) totalCost += cost.cost.totalCost;
                    else allCostsMeasured = false;

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
                    };
                    turns.push(turn);
                    this.logTurn(turn);
                },
            });

            const hitTurnLimit = result.steps.length >= maxTurns;
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
            // A throw from generateText may follow a request the provider billed
            // and never reported (a failed step reaches no onStepEnd), so the
            // sum so far is a lower bound, never the run's cost.
            const step = turns.length + 1;
            console.warn(
                `[AgentConversation] cost unmeasured: task=${this.config.taskId}, model=${this.modelConfig.id}, ` +
                    `step=${step}: the request threw (${errMsg}); the run's cost is reported as unmeasured`,
            );
            return this.buildErrorResult(turns, step, errMsg, {
                input: totalInput,
                output: totalOutput,
                cost: totalCost,
            }, lastModel);
        }
    }

    // -----------------------------------------------------------------------
    // Cost tracking
    // -----------------------------------------------------------------------

    private recordStepCost(
        sdkUsage: { inputTokens?: number; outputTokens?: number; raw?: unknown },
        provider: string,
        stepNumber: number,
    ): { usage: TokenUsage; cost: CostMeasurement } {
        const extraction = extractUsage(sdkUsage);
        const cost = measureCost(extraction.reported, this.modelConfig, new Date());
        if (!cost.measured) {
            console.warn(
                `[AgentConversation] ${describeUnmeasuredCost(cost, provider, this.modelConfig.id)}, ` +
                    `task=${this.config.taskId}, step=${stepNumber + 1}; the run's cost is reported as unmeasured`,
            );
        }
        return { usage: extraction.usage, cost };
    }

    // -----------------------------------------------------------------------
    // Shared helpers
    // -----------------------------------------------------------------------

    private buildErrorResult(
        turns: ConversationTurn[],
        turnNumber: number,
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
        });
        return {
            turns,
            finalMessage: `Gateway error: ${errMsg}`,
            finishReason: "error",
            totalTokens: { input: totals.input, output: totals.output },
            totalCost: totals.cost,
            costMeasured: false,
            model,
        };
    }
}
