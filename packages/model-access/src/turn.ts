import { jsonSchema } from "ai";
import type { AssistantModelMessage, JSONSchema7, ModelMessage, SystemModelMessage, Tool } from "ai";
import { z } from "zod";
import { describeErrorChain } from "@ashara/shared";
import { TurnToolExecutable } from "./errors.js";
import type { ResolvedModel } from "./gateway.js";
import type { ProviderType, TokenUsage } from "./types.js";

/**
 * One tool as the model sees it: its description and input schema, nothing
 * else. `execute` is typed `never` so a tool with one does not compile; the
 * gateway also refuses one at runtime (`TurnToolExecutable`).
 */
export interface TurnToolSchema {
  readonly description: string;
  readonly inputSchema: JSONSchema7;
  readonly execute?: never;
}

export interface TurnRequest {
  /** Resolved once per attempt by the caller; the turn never re-routes or falls back (ADR-074 d44). */
  readonly model: ResolvedModel;
  readonly system: string;
  readonly messages: readonly ModelMessage[];
  readonly tools: Readonly<Record<string, TurnToolSchema>>;
  readonly abortSignal: AbortSignal;
  /**
   * The input tokens the provider reported for the attempt's previous turn (TurnResult
   * reportedInputTokens); null on the first turn, or when the provider reported none. The window
   * guard projects this turn's input from it (context-window.ts).
   */
  readonly priorInputTokens: number | null;
}

/**
 * Why the model stopped, mapped from the SDK's finish reason. A finish reason
 * that is missing, `error`, or not one the SDK documents is `provider_error`.
 */
type TurnFinishReason = "stop" | "tool_calls" | "truncated" | "content_filter" | "other" | "provider_error";

/** A tool call the model made. The gateway returns it; it never executes it. */
type TurnToolCall =
  | { readonly kind: "valid"; readonly toolCallId: string; readonly toolName: string; readonly input: unknown }
  | {
      readonly kind: "invalid";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly input: unknown;
      /** Why the SDK could not match the call to a declared tool or parse its input. */
      readonly error: string;
    };

export interface TurnResult {
  /** The model's message, to append to the conversation as-is. */
  readonly assistant: AssistantModelMessage;
  readonly text: string;
  readonly toolCalls: readonly TurnToolCall[];
  readonly finishReason: TurnFinishReason;
  /** The provider's own finish reason string, `null` when it sent none. */
  readonly rawFinishReason: string | null;
  /** Zero-filled where the provider reported no count: a tally, never evidence of what was produced. */
  readonly usage: TokenUsage;
  /** The output token count the provider reported, `null` when it reported none. */
  readonly reportedOutputTokens: number | null;
  /** The input token count the provider reported, `null` when it reported none: the next turn's `priorInputTokens`. */
  readonly reportedInputTokens: number | null;
  readonly provider: string;
  readonly model: string;
}

/** One single-step gated call per agent turn. Never executes a tool, never loops. */
export interface TurnLlm {
  generateTurn(request: TurnRequest): Promise<TurnResult>;
}

/** The AI SDK's documented finish reasons; the one vocabulary both the turn and the structured paths read. */
export const SdkFinishReasonSchema = z.enum(["stop", "length", "content-filter", "tool-calls", "error", "other"]);

const SDK_TO_TURN: Readonly<Record<z.infer<typeof SdkFinishReasonSchema>, TurnFinishReason>> = {
  stop: "stop",
  "tool-calls": "tool_calls",
  length: "truncated",
  "content-filter": "content_filter",
  other: "other",
  error: "provider_error",
};

/** Total over every input: whatever is not a documented SDK finish reason is `provider_error`. */
export function mapFinishReason(sdkFinishReason: unknown): TurnFinishReason {
  const parsed = SdkFinishReasonSchema.safeParse(sdkFinishReason);
  return parsed.success ? SDK_TO_TURN[parsed.data] : "provider_error";
}

/** Anthropic's 5-minute ephemeral cache, the one whose write rate the catalog prices. */
const ANTHROPIC_CACHE_BREAKPOINT = { anthropic: { cacheControl: { type: "ephemeral" } } } as const;

function withCacheBreakpoint<M extends ModelMessage>(message: M): M {
  return {
    ...message,
    providerOptions: {
      ...message.providerOptions,
      anthropic: { ...message.providerOptions?.["anthropic"], ...ANTHROPIC_CACHE_BREAKPOINT.anthropic },
    },
  };
}

/**
 * The system prompt and conversation of one turn, with Anthropic prompt-cache
 * breakpoints when the provider type is `anthropic`; every other type gets them
 * unchanged. An attempt re-sends its whole conversation every turn, so without
 * a breakpoint every turn pays full input price for the same prefix.
 * Anthropic caches
 * the prefix up to each breakpoint, in the order tools, system, messages:
 * - the system prompt: tools and system, stable for the whole attempt;
 * - the message before the latest assistant message: where the previous turn's
 *   last breakpoint was, so this turn reads what that turn wrote;
 * - the last message: written now for the next turn to read.
 * Three of Anthropic's four breakpoints. A prefix shorter than the model's
 * minimum cacheable length is simply not cached; the request is unchanged.
 */
export function cachedTurnPrompt(
  providerType: ProviderType,
  system: string,
  messages: readonly ModelMessage[],
): { readonly system: string | SystemModelMessage; readonly messages: ModelMessage[] } {
  if (providerType !== "anthropic") return { system, messages: [...messages] };
  const last = messages.length - 1;
  let latestAssistant = -1;
  for (const [i, message] of messages.entries()) if (message.role === "assistant") latestAssistant = i;
  const previousEnd = latestAssistant > 0 ? latestAssistant - 1 : -1;
  return {
    system: { role: "system", content: system, providerOptions: ANTHROPIC_CACHE_BREAKPOINT },
    messages: messages.map((message, i) => (i === last || i === previousEnd ? withCacheBreakpoint(message) : message)),
  };
}

/** Builds the SDK tool set: schemas only, so the SDK has nothing to execute. */
export function toSdkTools(tools: Readonly<Record<string, TurnToolSchema>>): Record<string, Tool> {
  const sdkTools: Record<string, Tool> = {};
  for (const [name, tool] of Object.entries(tools)) {
    // The type forbids `execute`; a caller that defeated the type is refused here.
    if (Object.hasOwn(tool, "execute")) throw new TurnToolExecutable(name);
    sdkTools[name] = { description: tool.description, inputSchema: jsonSchema(tool.inputSchema) };
  }
  return sdkTools;
}

const ToolCallSchema = z.looseObject({
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  input: z.unknown(),
  invalid: z.boolean().optional(),
  error: z.unknown().optional(),
});

function describeToolCallError(error: unknown): string {
  if (error === undefined) return "the SDK flagged the call invalid without an error";
  return describeErrorChain(error);
}

/**
 * Validates the SDK's tool calls. A call the SDK flagged invalid (unknown tool,
 * unparsable input) is returned as `invalid` so the loop can tell the model;
 * a call that names an undeclared tool without that flag is a response issue.
 */
export function parseToolCalls(
  sdkToolCalls: readonly unknown[],
  declared: Readonly<Record<string, TurnToolSchema>>,
): { readonly toolCalls: TurnToolCall[]; readonly issues: string[] } {
  const toolCalls: TurnToolCall[] = [];
  const issues: string[] = [];
  for (const [i, raw] of sdkToolCalls.entries()) {
    const parsed = ToolCallSchema.safeParse(raw);
    if (!parsed.success) {
      issues.push(...parsed.error.issues.map((issue) => `toolCalls[${i}].${issue.path.join(".")}: ${issue.message}`));
      continue;
    }
    const call = parsed.data;
    if (call.invalid === true) {
      toolCalls.push({
        kind: "invalid",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        input: call.input,
        error: describeToolCallError(call.error),
      });
      continue;
    }
    if (!Object.hasOwn(declared, call.toolName)) {
      issues.push(`toolCalls[${i}]: tool "${call.toolName}" was not declared and the SDK did not flag the call invalid`);
      continue;
    }
    toolCalls.push({ kind: "valid", toolCallId: call.toolCallId, toolName: call.toolName, input: call.input });
  }
  return { toolCalls, issues };
}

/**
 * The assistant message of a one-step call. The SDK appends one `tool` message
 * holding its own error results for calls it flagged invalid (observed with ai
 * 7.0.128: an unknown tool name yields `error-text` "AI_NoSuchToolError ...");
 * that message is dropped, since the caller reports those errors from
 * `toolCalls`. Any other trailing message, or any non-error tool result, would
 * mean a tool ran or a second step happened: an issue, never a success.
 */
export function assistantMessageOf(
  messages: readonly ModelMessage[],
  invalidCallIds: ReadonlySet<string>,
): { readonly assistant: AssistantModelMessage } | { readonly issue: string } {
  const [first, ...rest] = messages;
  if (first === undefined) return { issue: "the response carries no message" };
  if (first.role !== "assistant") return { issue: `first response message has role "${first.role}", expected "assistant"` };
  for (const message of rest) {
    if (message.role !== "tool") return { issue: `unexpected "${message.role}" message after the assistant message` };
    for (const part of message.content) {
      const isInvalidCallError =
        part.type === "tool-result" &&
        invalidCallIds.has(part.toolCallId) &&
        (part.output.type === "error-text" || part.output.type === "error-json");
      if (!isInvalidCallError) {
        return { issue: `tool message carries a "${part.type}" part that is not an SDK error for an invalid call` };
      }
    }
  }
  return { assistant: first };
}
