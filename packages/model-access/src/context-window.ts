import { readFileSync } from "node:fs";
import { APICallError } from "ai";
import type { ModelMessage } from "ai";
import { parse } from "smol-toml";
import { z } from "zod";
import { JsonParseFailed, parseJson } from "@ashara/shared";
import { InvalidContextOverflowSignatures, ModelsConfigUnreadable } from "./errors.js";
import type { ContextOverflowSignatures } from "./types.js";

/**
 * The output bound of one agent turn. A turn request carries none of its own,
 * and an unbounded request has no worst-case cost to check against the cap. 16k
 * holds one tool call that writes a file of about 50 KB; a turn that needs more
 * stops at `length`, which the attempt loop reads as a truncated turn. Every turn
 * reserves it in its model's window, with a reasoning allowance on top where
 * thinking is on (thinking.ts turnOutputBudget), so a model whose window is no
 * larger than that reserve fails the catalog at boot (config.ts).
 */
export const TURN_MAX_OUTPUT_TOKENS = 16_384;

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

function asText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Read by wire data alone, never by provider name: the status first, then the body's structured
 * code or type, then its message. A status the signatures do not list, a body that does not parse,
 * or one that names no listed code or wording is not overflow, so it stays the provider failure it is.
 */
function overflowMessageOf(error: APICallError, signatures: ContextOverflowSignatures): string | null {
  if (error.statusCode === undefined || !signatures.statuses.includes(error.statusCode)) return null;
  const body = errorBodyOf(error);
  if (body === null) return null;
  const inner = body.error;
  const messages = [asText(inner?.message), asText(body.message)].filter((text): text is string => text !== null);
  const code = [asText(inner?.code), asText(inner?.type)].find((text): text is string => text !== null && signatures.codes.includes(text));
  if (code !== undefined) return `${code}: ${messages[0] ?? error.message}`;
  const phrases = signatures.phrases.map((phrase) => phrase.toLowerCase());
  return messages.find((text) => phrases.some((phrase) => text.toLowerCase().includes(phrase))) ?? null;
}

/**
 * The provider's statement that a request was longer than the model's context, from the error data
 * of the provider error in `error`'s cause chain, as `signatures` describe it; null for any other failure.
 */
export function contextOverflowOf(error: unknown, signatures: ContextOverflowSignatures): string | null {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if (APICallError.isInstance(current)) return overflowMessageOf(current, signatures);
  }
  return null;
}

const ContextOverflowTableSchema = z
  .object({
    statuses: z.array(z.number().int().min(400).max(499)).min(1),
    codes: z.array(z.string().min(1)),
    phrases: z.array(z.string().min(1)),
  })
  .strict()
  .refine((table) => table.codes.length + table.phrases.length > 0, {
    message: "names no code and no phrase, so no provider's overflow could be recognised",
  });

const TomlContextOverflowRootSchema = z.object({ context_overflow: z.unknown().optional() });

/**
 * Reads the `[context_overflow]` table of a models.toml file. The table is required: with none, a
 * provider's overflow could not be told from any other rejection, so its absence fails boot rather
 * than reading as "no provider ever overflows". A missing or unparseable file throws
 * {@link ModelsConfigUnreadable}; an absent or invalid table throws {@link InvalidContextOverflowSignatures}.
 */
export function loadContextOverflowFromToml(configPath: string): ContextOverflowSignatures {
  let table: unknown;
  try {
    table = TomlContextOverflowRootSchema.parse(parse(readFileSync(configPath, "utf-8"))).context_overflow;
  } catch (err) {
    throw new ModelsConfigUnreadable(configPath, "[context_overflow]", err);
  }
  if (table === undefined) throw new InvalidContextOverflowSignatures(configPath, ["the table is absent"]);
  const parsed = ContextOverflowTableSchema.safeParse(table);
  if (!parsed.success) {
    throw new InvalidContextOverflowSignatures(
      configPath,
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`),
    );
  }
  return parsed.data;
}
