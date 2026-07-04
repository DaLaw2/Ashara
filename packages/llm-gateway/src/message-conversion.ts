import type { ContentBlock } from "./types.js";

// ---------------------------------------------------------------------------
// AI SDK message-format translation. Pure functions, no gateway state —
// converts the gateway's own Message/ContentBlock shape (and finish-reason
// vocabulary) to/from the "ai" package's shape.
// ---------------------------------------------------------------------------

export type AISdkMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | Array<Record<string, unknown>>;
};

export function convertMessage(m: { role: string; content: string | ContentBlock[]; tool_call_id?: string; reasoning_content?: string }): AISdkMessage {
  if (typeof m.content === "string") {
    if (m.role === "tool") {
      return {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: m.tool_call_id ?? "",
          toolName: "",
          output: m.content,
        }],
      };
    }
    if (m.role === "assistant" && m.reasoning_content) {
      return {
        role: "assistant",
        content: [
          { type: "reasoning", text: m.reasoning_content },
          { type: "text", text: m.content },
        ],
      };
    }
    return {
      role: m.role as AISdkMessage["role"],
      content: m.content,
    };
  }

  if (m.role === "tool") {
    const parts: Array<Record<string, unknown>> = [];
    for (const block of m.content) {
      if (block.type === "tool_result") {
        const outputValue = block.content ?? "";
        parts.push({
          type: "tool-result",
          toolCallId: block.tool_use_id ?? m.tool_call_id ?? "",
          toolName: block.name ?? "",
          output: block.is_error
            ? { type: "error-text", value: outputValue }
            : { type: "text", value: outputValue },
        });
      }
    }
    return { role: "tool", content: parts };
  }

  if (m.role === "assistant") {
    const parts: Array<Record<string, unknown>> = [];
    if (m.reasoning_content) {
      parts.push({ type: "reasoning", text: m.reasoning_content });
    }
    for (const block of m.content) {
      if (block.type === "reasoning" && block.text) {
        parts.push({ type: "reasoning", text: block.text });
      } else if (block.type === "text" && block.text) {
        parts.push({ type: "text", text: block.text });
      } else if (block.type === "tool_use") {
        parts.push({
          type: "tool-call",
          toolCallId: block.id ?? "",
          toolName: block.name ?? "",
          input: block.input ?? {},
        });
      }
    }
    return { role: "assistant", content: parts };
  }

  // For user/system roles with ContentBlock[], serialize to string
  const textParts: string[] = [];
  for (const block of m.content) {
    if (block.text) textParts.push(block.text);
    else if (block.content) textParts.push(block.content);
  }
  return {
    role: m.role as AISdkMessage["role"],
    content: textParts.join("\n"),
  };
}

export function buildCacheProviderOptions(
  providerName: string,
): Record<string, Record<string, unknown>> | undefined {
  switch (providerName) {
    case "anthropic":
      return { anthropic: { cacheControl: { type: "ephemeral" } } };
    case "google":
      return { google: { cacheControl: { type: "ephemeral" } } };
    default:
      // OpenAI-compatible providers (openai, deepseek, etc.) use automatic
      // prefix caching — no explicit annotation needed.
      return undefined;
  }
}

export function mapFinishReason(reason: string | undefined): string {
  switch (reason) {
    case "tool-calls":
      return "tool_use";
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "content-filter":
      return "content_filter";
    default:
      return reason ?? "unknown";
  }
}
