// Observation masking for agent sessions.
// Applies a sliding window that masks old tool outputs while preserving
// reasoning history. Deterministic — no LLM calls.
// Reference: JetBrains NeurIPS 2025 (+2.6% solve rate, -52% cost).

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Message {
    readonly role: "user" | "assistant" | "tool";
    readonly content: string;
    readonly timestamp: Date;
    readonly tokenCount: number;
    readonly metadata?: {
        readonly toolName?: string;
        readonly isReasoning?: boolean;
    };
}

export interface MaskingConfig {
    readonly maxContextTokens: number;
    readonly preserveRecentTools: number;
    readonly maskPlaceholder: string;
    readonly summarizationThreshold: number;
}

export interface MaskingResult {
    readonly messages: Message[];
    readonly totalTokens: number;
    readonly maskedCount: number;
    readonly preservedCount: number;
    readonly needsSummarization: boolean;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: MaskingConfig = {
    maxContextTokens: 128_000,
    preserveRecentTools: 3,
    maskPlaceholder: "[output masked — {tokenCount} tokens]",
    summarizationThreshold: 50_000,
};

// ---------------------------------------------------------------------------
// ObservationMasker
// ---------------------------------------------------------------------------

export class ObservationMasker {
    private readonly config: MaskingConfig;

    constructor(config?: Partial<MaskingConfig>) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    /**
     * Apply masking to a conversation history.
     *
     * Strategy:
     * 1. Identify tool-output messages (role === "tool") — these are masking candidates.
     * 2. Keep the `preserveRecentTools` most recent tool outputs unmasked.
     * 3. Replace older tool outputs with a placeholder carrying the original token count.
     * 4. If total tokens still exceed `maxContextTokens`, progressively mask more
     *    tool outputs until either we are within budget or all tool outputs are masked.
     * 5. If we are STILL over budget after masking every tool output, set
     *    `needsSummarization = true` so the caller can decide to invoke an LLM summary.
     * 6. User and reasoning messages are never masked.
     */
    mask(messages: readonly Message[]): MaskingResult {
        if (messages.length === 0) {
            return {
                messages: [],
                totalTokens: 0,
                maskedCount: 0,
                preservedCount: 0,
                needsSummarization: false,
            };
        }

        // Collect indices of tool-output messages (in order of appearance).
        const toolIndices: number[] = [];
        for (let i = 0; i < messages.length; i++) {
            if (messages[i].role === "tool") {
                toolIndices.push(i);
            }
        }

        // Determine how many recent tool outputs to preserve. Start with the
        // configured value, but we may reduce it later if the budget is tight.
        let preserveCount = Math.min(this.config.preserveRecentTools, toolIndices.length);

        // Build the result, masking as needed.
        const buildResult = (preserve: number): MaskingResult => {
            const preservedSet = new Set(
                preserve > 0 ? toolIndices.slice(-preserve) : [],
            );

            let totalTokens = 0;
            let maskedCount = 0;
            let maskedTokens = 0;
            let preservedCount = 0;

            const resultMessages: Message[] = messages.map((msg, idx) => {
                if (msg.role === "tool" && !preservedSet.has(idx)) {
                    // Mask this tool output.
                    const placeholder = this.config.maskPlaceholder.replace(
                        "{tokenCount}",
                        String(msg.tokenCount),
                    );
                    const placeholderTokens = estimatePlaceholderTokens(placeholder);
                    totalTokens += placeholderTokens;
                    maskedCount++;
                    maskedTokens += msg.tokenCount;

                    return {
                        role: msg.role,
                        content: placeholder,
                        timestamp: msg.timestamp,
                        tokenCount: placeholderTokens,
                        metadata: msg.metadata,
                    } as Message;
                }

                // Preserved message (user, assistant, or recent tool output).
                totalTokens += msg.tokenCount;
                if (msg.role === "tool") {
                    preservedCount++;
                }
                return msg;
            });

            const needsSummarization =
                totalTokens > this.config.maxContextTokens ||
                maskedTokens >= this.config.summarizationThreshold;

            return {
                messages: resultMessages,
                totalTokens,
                maskedCount,
                preservedCount,
                needsSummarization,
            };
        };

        // First pass with the configured preserve count.
        let result = buildResult(preserveCount);

        // If we are over budget, progressively reduce the number of preserved
        // tool outputs until we fit or run out of tool outputs to mask.
        while (result.totalTokens > this.config.maxContextTokens && preserveCount > 0) {
            preserveCount--;
            result = buildResult(preserveCount);
        }

        return result;
    }

    /**
     * Append a new message to the history and return the masked result.
     */
    append(history: readonly Message[], newMessage: Message): MaskingResult {
        return this.mask([...history, newMessage]);
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Rough token estimate for a placeholder string.
 * Uses the common ~4 chars/token heuristic. The exact count does not matter
 * because the placeholder is tiny compared to real tool output.
 */
function estimatePlaceholderTokens(text: string): number {
    return Math.max(1, Math.ceil(text.length / 4));
}
