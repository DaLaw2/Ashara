import { APICallError } from "ai";
import type { ModelMessage } from "ai";
import { z } from "zod";
import { JsonParseFailed, parseJson } from "@ashara/shared";

/**
 * Bytes per token the preflight estimates unmeasured input at. Below the 3-4 bytes a token of
 * English or code typically takes in the Claude, GPT and DeepSeek tokenizers, so the estimate runs
 * high there. Text that tokenizes denser can be estimated low; the provider's own overflow error
 * (contextOverflowOf) then ends the attempt with the same terminal, so the estimate never decides
 * alone.
 */
const BYTES_PER_TOKEN_ESTIMATE = 2;

/** An estimate of the tokens `bytes` of request text take. */
function estimatedTokens(bytes: number): number {
  return Math.ceil(bytes / BYTES_PER_TOKEN_ESTIMATE);
}

function utf8Bytes(value: unknown): number {
  return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8");
}

/**
 * What a turn's input is projected from (architecture §13.6):
 * - `reported-plus-tail`: the input the provider reported for the attempt's previous request, plus
 *   an estimate of what was appended since (that request's answer and the tool results after it);
 * - `estimated`: no provider count to start from (the attempt's first turn, or a previous request
 *   whose input the provider did not report), so the whole request is estimated.
 */
type InputProjection =
  | { readonly kind: "reported-plus-tail"; readonly lastInputTokens: number; readonly tailTokens: number }
  | { readonly kind: "estimated"; readonly tokens: number };

/**
 * The projection of one turn's input. The tail starts at the conversation's last assistant message,
 * the previous request's answer: everything before it was that request's input, which the provider
 * counted. With no count, or no assistant message to start the tail at, the whole request
 * (system prompt, messages, tool schemas) is estimated.
 */
export function projectTurnInput(
  priorInputTokens: number | null,
  request: { readonly system: string; readonly messages: readonly ModelMessage[]; readonly tools: unknown },
): InputProjection {
  let tailStart = request.messages.length - 1;
  while (tailStart >= 0 && request.messages[tailStart]?.role !== "assistant") tailStart -= 1;
  if (priorInputTokens === null || tailStart < 0) {
    return { kind: "estimated", tokens: estimatedTokens(utf8Bytes(request.system) + utf8Bytes(request.messages) + utf8Bytes(request.tools)) };
  }
  return { kind: "reported-plus-tail", lastInputTokens: priorInputTokens, tailTokens: estimatedTokens(utf8Bytes(request.messages.slice(tailStart))) };
}

type PreflightVerdict =
  | { readonly kind: "fits"; readonly projectedInputTokens: number; readonly limitTokens: number }
  | { readonly kind: "context_budget_exceeded"; readonly projectedInputTokens: number; readonly limitTokens: number };

/**
 * The window guard (architecture §13.6 "Fail-closed"): a turn whose projected input exceeds the
 * model's window less the output it reserves is `context_budget_exceeded`; input of exactly that
 * limit fits.
 */
export function contextPreflight(projection: InputProjection, windowTokens: number, outputReserveTokens: number): PreflightVerdict {
  const projectedInputTokens = projection.kind === "estimated" ? projection.tokens : projection.lastInputTokens + projection.tailTokens;
  const limitTokens = windowTokens - outputReserveTokens;
  return { kind: projectedInputTokens > limitTokens ? "context_budget_exceeded" : "fits", projectedInputTokens, limitTokens };
}

/** How a projection reads in an error: which figures it was made from. */
export function describeProjection(projection: InputProjection): string {
  return projection.kind === "estimated"
    ? `no reported input to start from: the whole request estimated at ${projection.tokens} tokens`
    : `${projection.lastInputTokens} reported for the previous request plus a tail estimated at ${projection.tailTokens}`;
}

/*
 * The error body a provider answers a request longer than the model's context with, read by wire
 * format, never by provider name, so every endpoint speaking one reads the same way:
 * - OpenAI Chat Completions and Responses, and endpoints compatible with them: HTTP 400,
 *   `error.code` "context_length_exceeded", message "This model's maximum context length is ...".
 * - DeepSeek chat and vLLM: HTTP 400, message "This model's maximum context length is ...".
 * - llama.cpp server: HTTP 400, `error.type` "exceed_context_size_error".
 * - Anthropic Messages: HTTP 400, `error.type` "invalid_request_error", message "prompt is too long: ...".
 */
const OVERFLOW_CODES: ReadonlySet<string> = new Set(["context_length_exceeded", "exceed_context_size_error"]);
const OVERFLOW_PHRASES: readonly string[] = ["maximum context length", "prompt is too long", "exceeds the available context size"];

const ErrorBodySchema = z.looseObject({
  error: z
    .looseObject({ code: z.unknown().optional(), type: z.unknown().optional(), message: z.unknown().optional() })
    .nullish(),
  message: z.unknown().optional(),
});

/** The error object of a provider's response, from the data the SDK parsed or else the raw body; null when neither has one. */
function errorBodyOf(error: APICallError): z.infer<typeof ErrorBodySchema> | null {
  const parsed = ErrorBodySchema.safeParse(error.data);
  if (parsed.success) return parsed.data;
  if (error.responseBody === undefined) return null;
  try {
    return parseJson(ErrorBodySchema, error.responseBody, "provider error body");
  } catch (err) {
    if (err instanceof JsonParseFailed) return null;
    throw err;
  }
}

function overflowMessageOf(error: APICallError): string | null {
  if (error.statusCode !== 400 && error.statusCode !== 413) return null;
  const body = errorBodyOf(error);
  if (body === null) return null;
  const inner = body.error;
  const texts = [inner?.code, inner?.type, inner?.message, body.message].filter((value): value is string => typeof value === "string");
  const message = texts.find((text) => OVERFLOW_PHRASES.some((phrase) => text.toLowerCase().includes(phrase)));
  if (message !== undefined) return message;
  const code = texts.find((text) => OVERFLOW_CODES.has(text));
  return code === undefined ? null : `${code}: ${error.message}`;
}

/**
 * The provider's statement that a request was longer than the model's context, from the error data
 * of the provider error in `error`'s cause chain; null for any other failure.
 */
export function contextOverflowOf(error: unknown): string | null {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if (APICallError.isInstance(current)) return overflowMessageOf(current);
  }
  return null;
}
