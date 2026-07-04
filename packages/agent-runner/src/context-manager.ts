import type { Message as GatewayMessage, ContentBlock } from "@ashara/llm-gateway";
import { ObservationMasker } from "@ashara/development";
import type { Message as MaskerMessage, MaskingResult as MaskerMaskingResult } from "@ashara/development";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ContextManagerConfig {
    readonly contextWindowTokens: number;
    readonly preserveRecentTools: number;
}

interface MaskedResult {
    readonly messages: GatewayMessage[];
    readonly totalTokens: number;
    readonly maskedCount: number;
}

export type CompactionLevel = "none" | "microcompact" | "mask" | "summarize";

export interface CompactionResult {
    readonly messages: GatewayMessage[];
    readonly totalTokens: number;
    readonly level: CompactionLevel;
    readonly removedMessages: number;
    readonly compactedMessages: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_PRESERVE_RECENT = 3;
const DEFAULT_MAX_RESULT_CHARS = 4_000;
const DEFAULT_PARTIAL_RECENT_TURNS = 8;
const MICROCOMPACT_HEAD_CHARS = 2_000;
const MICROCOMPACT_TAIL_CHARS = 500;

// ---------------------------------------------------------------------------
// ConversationContextManager
// ---------------------------------------------------------------------------

/**
 * Bridges the ObservationMasker (which uses its own Message type with
 * string content and tokenCount) with the LLM gateway Message type
 * (which uses `content: string | ContentBlock[]`).
 *
 * Converts gateway messages to masker format, runs masking, and converts back.
 * System prompt and the initial user message are never masked.
 */
export class ConversationContextManager {
    private readonly masker: ObservationMasker;
    private readonly config: ContextManagerConfig;

    constructor(config?: Partial<ContextManagerConfig>) {
        this.config = {
            contextWindowTokens: config?.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW,
            preserveRecentTools: config?.preserveRecentTools ?? DEFAULT_PRESERVE_RECENT,
        };
        this.masker = new ObservationMasker({
            maxContextTokens: this.config.contextWindowTokens,
            preserveRecentTools: this.config.preserveRecentTools,
        });
    }

    // -----------------------------------------------------------------------
    // Public API: compact — multi-layer context compaction
    // -----------------------------------------------------------------------

    compact(messages: readonly GatewayMessage[], targetTokens: number): CompactionResult {
        if (messages.length === 0) {
            return { messages: [], totalTokens: 0, level: "none", removedMessages: 0, compactedMessages: 0 };
        }

        const rawTokens = this.estimateAllTokens(messages);
        if (rawTokens <= targetTokens) {
            return { messages: [...messages], totalTokens: rawTokens, level: "none", removedMessages: 0, compactedMessages: 0 };
        }

        const mc = this.microcompact(messages);
        const mcTokens = this.estimateAllTokens(mc.messages);
        if (mcTokens <= targetTokens) {
            return {
                messages: mc.messages,
                totalTokens: mcTokens,
                level: "microcompact",
                removedMessages: 0,
                compactedMessages: mc.compactedCount,
            };
        }

        const masked = this.maskHistory(mc.messages);
        if (masked.totalTokens <= targetTokens) {
            return {
                messages: masked.messages,
                totalTokens: masked.totalTokens,
                level: "mask",
                removedMessages: 0,
                compactedMessages: mc.compactedCount + masked.maskedCount,
            };
        }

        const recent = this.summarize(messages, DEFAULT_PARTIAL_RECENT_TURNS);
        const recentTokens = this.estimateAllTokens(recent.messages);
        if (recentTokens <= targetTokens) {
            return {
                messages: recent.messages,
                totalTokens: recentTokens,
                level: "summarize",
                removedMessages: recent.removedCount,
                compactedMessages: recent.compactedCount,
            };
        }

        const full = this.summarize(messages, 0);
        const fullTokens = this.estimateAllTokens(full.messages);
        return {
            messages: full.messages,
            totalTokens: fullTokens,
            level: "summarize",
            removedMessages: full.removedCount,
            compactedMessages: full.compactedCount,
        };
    }

    // -----------------------------------------------------------------------
    // maskHistory — delegates to ObservationMasker, also used internally by compact
    // -----------------------------------------------------------------------

    private maskHistory(messages: readonly GatewayMessage[]): MaskedResult {
        if (messages.length === 0) {
            return { messages: [], totalTokens: 0, maskedCount: 0 };
        }

        // Convert gateway messages to masker messages
        const maskerMessages = messages.map((msg) => this.toMaskerMessage(msg));

        // Run masking
        const result: MaskerMaskingResult = this.masker.mask(maskerMessages);

        // Convert back to gateway messages.
        // We need to pair the masked masker messages with the original gateway
        // messages so we can preserve the original structure for non-masked messages.
        const maskedGatewayMessages: GatewayMessage[] = result.messages.map((maskerMsg, idx) => {
            const original = messages[idx];
            // If this message was masked, the content was replaced with a placeholder.
            // We detect this by checking if the masker message content differs from
            // what the original would have produced.
            if (original.role === "tool" && maskerMsg.content !== this.contentToString(original.content)) {
                if (Array.isArray(original.content)) {
                    return {
                        role: original.role,
                        content: original.content.map((block: ContentBlock) => ({
                            ...block,
                            content: `[masked — ${Math.max(1, Math.ceil((block.content ?? "").length / 4))} tokens]`,
                        })),
                        tool_call_id: original.tool_call_id,
                    };
                }
                return {
                    role: original.role,
                    content: maskerMsg.content,
                    tool_call_id: original.tool_call_id,
                };
            }
            // Not masked — return original as-is to preserve ContentBlock structure
            return original;
        });

        return {
            messages: maskedGatewayMessages,
            totalTokens: result.totalTokens,
            maskedCount: result.maskedCount,
        };
    }

    /**
     * Estimate token count for a gateway message using the ~4 chars/token heuristic.
     */
    private estimateTokens(message: GatewayMessage): number {
        const text = this.contentToString(message.content);
        return Math.max(1, Math.ceil(text.length / 4));
    }

    // -----------------------------------------------------------------------
    // Compaction strategies
    // -----------------------------------------------------------------------

    private microcompact(
        messages: readonly GatewayMessage[],
        maxResultChars: number = DEFAULT_MAX_RESULT_CHARS,
    ): { messages: GatewayMessage[]; compactedCount: number } {
        let compactedCount = 0;
        const result = messages.map((msg): GatewayMessage => {
            if (msg.role !== "tool") return msg;
            if (typeof msg.content === "string") {
                if (msg.content.length > maxResultChars) {
                    const head = msg.content.slice(0, MICROCOMPACT_HEAD_CHARS);
                    const tail = msg.content.slice(-MICROCOMPACT_TAIL_CHARS);
                    const dropped = msg.content.length - MICROCOMPACT_HEAD_CHARS - MICROCOMPACT_TAIL_CHARS;
                    compactedCount++;
                    return { ...msg, content: `${head}\n[...truncated ${dropped} chars...]\n${tail}` };
                }
                return msg;
            }
            let modified = false;
            const newBlocks = msg.content.map((block): ContentBlock => {
                if (block.content && block.content.length > maxResultChars) {
                    const head = block.content.slice(0, MICROCOMPACT_HEAD_CHARS);
                    const tail = block.content.slice(-MICROCOMPACT_TAIL_CHARS);
                    const dropped = block.content.length - MICROCOMPACT_HEAD_CHARS - MICROCOMPACT_TAIL_CHARS;
                    modified = true;
                    return { ...block, content: `${head}\n[...truncated ${dropped} chars...]\n${tail}` };
                }
                return block;
            });
            if (modified) {
                compactedCount++;
                return { ...msg, content: newBlocks };
            }
            return msg;
        });
        return { messages: result, compactedCount };
    }

    /**
     * Replaces first+recent with first + a heuristic summary of everything in
     * between. `recentTurnCount=DEFAULT_PARTIAL_RECENT_TURNS` keeps recent
     * context; `recentTurnCount=0` (called by `compact()` as the last-resort
     * tier) summarizes everything after the first message.
     */
    private summarize(
        messages: readonly GatewayMessage[],
        recentTurnCount: number,
    ): { messages: GatewayMessage[]; removedCount: number; compactedCount: number } {
        if (messages.length <= recentTurnCount + 1) {
            return { messages: [...messages], removedCount: 0, compactedCount: 0 };
        }
        const first = messages[0];
        const recent = recentTurnCount > 0 ? messages.slice(-recentTurnCount) : [];
        const old = recentTurnCount > 0 ? messages.slice(1, messages.length - recentTurnCount) : messages.slice(1);
        const header = recentTurnCount > 0 ? "Previous work" : "Summary of all previous work";
        const summary = this.buildSummary(old, header);
        const summaryMsg: GatewayMessage = { role: "user", content: summary };
        return { messages: [first, summaryMsg, ...recent], removedCount: old.length, compactedCount: 1 };
    }

    private buildSummary(messages: readonly GatewayMessage[], header: string): string {
        const toolCalls: string[] = [];
        const filesWritten = new Set<string>();
        const filesRead = new Set<string>();
        const commandsRun: string[] = [];

        for (const msg of messages) {
            if (msg.role === "assistant" && Array.isArray(msg.content)) {
                for (const block of msg.content) {
                    if (block.type === "tool_use") {
                        const name = block.name ?? "unknown";
                        const input = block.input ?? {};
                        const keyArg = (input.path ?? input.command ?? input.query ?? "") as string;
                        toolCalls.push(`- ${name}${keyArg ? `(${keyArg})` : ""}`);
                        if (name === "write_file" || name === "edit_file") {
                            if (typeof input.path === "string") filesWritten.add(input.path);
                        }
                        if (name === "read_file") {
                            if (typeof input.path === "string") filesRead.add(input.path);
                        }
                        if (name === "run_command" || name === "bash") {
                            const cmd = (input.command ?? input.cmd ?? "") as string;
                            if (cmd) commandsRun.push(cmd);
                        }
                    }
                }
            }
        }

        const parts: string[] = [`${header}:`];
        if (toolCalls.length > 0) {
            parts.push(`Tool calls:\n${toolCalls.join("\n")}`);
        }
        if (filesRead.size > 0) {
            parts.push(`Files read: ${[...filesRead].join(", ")}`);
        }
        if (filesWritten.size > 0) {
            parts.push(`Files written: ${[...filesWritten].join(", ")}`);
        }
        if (commandsRun.length > 0) {
            parts.push(`Commands run: ${commandsRun.slice(0, 10).join("; ")}`);
        }
        if (toolCalls.length === 0 && filesRead.size === 0 && filesWritten.size === 0) {
            parts.push(`(${messages.length} earlier messages with no tracked tool activity)`);
        }
        return parts.join("\n");
    }

    private estimateAllTokens(messages: readonly GatewayMessage[]): number {
        let total = 0;
        for (const msg of messages) {
            total += this.estimateTokens(msg);
        }
        return total;
    }

    // -----------------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------------

    private toMaskerMessage(msg: GatewayMessage): MaskerMessage {
        const text = this.contentToString(msg.content);
        const tokenCount = Math.max(1, Math.ceil(text.length / 4));
        const role = msg.role === "system" ? "user" : msg.role;

        return {
            role,
            content: text,
            timestamp: new Date(),
            tokenCount,
            metadata: msg.role === "tool" ? { toolName: this.extractToolName(msg.content) } : undefined,
        };
    }

    /**
     * Flatten `string | ContentBlock[]` to a single string for token estimation
     * and masker compatibility.
     */
    private contentToString(content: string | ContentBlock[]): string {
        if (typeof content === "string") {
            return content;
        }
        return content
            .map((block) => {
                switch (block.type) {
                    case "text":
                        return block.text ?? "";
                    case "tool_use":
                        return JSON.stringify(block.input ?? {});
                    case "tool_result":
                        return block.content ?? "";
                    default:
                        return "";
                }
            })
            .join("\n");
    }

    /**
     * Extract tool name from content blocks for metadata, if available.
     */
    private extractToolName(content: string | ContentBlock[]): string | undefined {
        if (typeof content === "string") {
            return undefined;
        }
        for (const block of content) {
            if (block.type === "tool_result" && block.name) {
                return block.name;
            }
        }
        return undefined;
    }
}
