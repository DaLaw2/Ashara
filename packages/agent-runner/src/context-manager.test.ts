import { describe, expect, it } from "vitest";
import type { Message as GatewayMessage } from "@ashara/llm-gateway";

import { ConversationContextManager } from "./context-manager.js";

function userMsg(content: string): GatewayMessage {
    return { role: "user", content };
}

function assistantMsg(content: string): GatewayMessage {
    return { role: "assistant", content };
}

function toolMsg(content: string): GatewayMessage {
    return { role: "tool", content, tool_call_id: "t" };
}

describe("ConversationContextManager.compact escalation order", () => {
    it("returns level 'none' when already under budget", () => {
        const cm = new ConversationContextManager();
        const messages = [userMsg("hello"), assistantMsg("hi there")];

        const result = cm.compact(messages, 10_000);

        expect(result.level).toBe("none");
        expect(result.messages).toEqual(messages);
    });

    it("escalates to 'microcompact' when truncating one oversized tool output is enough", () => {
        const cm = new ConversationContextManager();
        const messages = [userMsg("start task"), toolMsg("x".repeat(20_000))];

        const result = cm.compact(messages, 1_000);

        expect(result.level).toBe("microcompact");
    });

    it("escalates to 'mask' (regression: was mislabeled 'microcompact') when several old tool outputs must be masked", () => {
        const cm = new ConversationContextManager({ preserveRecentTools: 1 });
        const messages: GatewayMessage[] = [userMsg("start task")];
        for (let i = 0; i < 6; i++) {
            // Each block stays under microcompact's per-block threshold (4,000 chars),
            // so microcompact alone cannot bring this under budget — only masking can.
            messages.push(toolMsg("y".repeat(3_000)));
        }

        const result = cm.compact(messages, 1_200);

        expect(result.level).toBe("mask");
    });

    it("escalates to 'summarize' (recentTurnCount=8 tier) when masking cannot shrink large non-tool messages", () => {
        const cm = new ConversationContextManager({ preserveRecentTools: 1 });
        const messages: GatewayMessage[] = [userMsg("start task")];
        for (let i = 0; i < 10; i++) {
            messages.push(assistantMsg("z".repeat(300)));
        }

        const result = cm.compact(messages, 650);

        expect(result.level).toBe("summarize");
        // first message + summary + 8 preserved recent turns
        expect(result.messages).toHaveLength(10);
        expect(result.messages[0]).toEqual(messages[0]);
    });

    it("falls through to the recentTurnCount=0 summarize tier when even the 8-recent-turn summary overflows", () => {
        const cm = new ConversationContextManager({ preserveRecentTools: 1 });
        const messages: GatewayMessage[] = [userMsg("start task")];
        for (let i = 0; i < 10; i++) {
            messages.push(assistantMsg("z".repeat(300)));
        }

        const result = cm.compact(messages, 100);

        expect(result.level).toBe("summarize");
        // Only the first message and one full-history summary remain.
        expect(result.messages).toHaveLength(2);
        expect(result.messages[0]).toEqual(messages[0]);
    });
});
