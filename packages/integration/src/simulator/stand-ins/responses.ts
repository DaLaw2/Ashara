import { APICallError } from "@ai-sdk/provider";
import type {
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4GenerateResult,
} from "@ai-sdk/provider";
import { z } from "zod";
import type { StandInContext } from "./context.js";

/** A stand-in could not answer: the run's own state contradicts what it was built to model. */
export class StandInUnanswerable extends Error {
  constructor(
    readonly site: string,
    readonly detail: string,
  ) {
    super(`scripted model at ${site}: ${detail}`);
    this.name = "StandInUnanswerable";
  }
}

/**
 * A request carried a schema its provider type refuses: the stand-in refuses the whole request, as that provider does.
 */
export class StandInRefusedSchema extends Error {
  constructor(
    readonly model: string,
    readonly providerType: string,
    readonly what: string,
    readonly detail: string,
  ) {
    super(`scripted model ${model} (provider type ${providerType}) refuses the ${what} schema: ${detail}`);
    this.name = "StandInRefusedSchema";
  }
}

const USAGE = {
  inputTokens: { total: 2000, noCache: 2000, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 200, text: 200, reasoning: 0 },
};

function textResult(text: string): LanguageModelV4GenerateResult {
  return {
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: USAGE,
    warnings: [],
  };
}

/**
 * `callNumber` counts within one run's stand-ins: a count kept across runs made a seed's prompts depend on the seeds
 * before it.
 */
export function toolCall(callNumber: number, toolName: string, input: unknown): LanguageModelV4GenerateResult {
  const content: LanguageModelV4Content[] = [
    { type: "tool-call", toolCallId: `sim-call-${callNumber}`, toolName, input: JSON.stringify(input) },
  ];
  return { content, finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage: USAGE, warnings: [] };
}

export const REFUSAL: LanguageModelV4GenerateResult = {
  content: [{ type: "text", text: "I can't help with that." }],
  finishReason: { unified: "content-filter", raw: "content_filter" },
  usage: USAGE,
  warnings: [],
};

/** The output bound a request names, or the gateway's turn bound when it names none. */
const DEFAULT_OUTPUT_BOUND = 16_384;

export function outputBoundOf(options: LanguageModelV4CallOptions): number {
  return options.maxOutputTokens ?? DEFAULT_OUTPUT_BOUND;
}

/** A response with no content at all: no text, no tool call, nothing billed for output. */
export const EMPTY: LanguageModelV4GenerateResult = {
  content: [],
  finishReason: { unified: "stop", raw: "stop" },
  usage: { inputTokens: USAGE.inputTokens, outputTokens: { total: 0, text: 0, reasoning: 0 } },
  warnings: [],
};

/** Output cut at the bound: `content` is what arrived before the cut, every token of the bound billed as text. */
export function cutAtBound(content: LanguageModelV4Content[], bound: number): LanguageModelV4GenerateResult {
  return {
    content,
    finishReason: { unified: "length", raw: "length" },
    usage: { inputTokens: USAGE.inputTokens, outputTokens: { total: bound, text: bound, reasoning: 0 } },
    warnings: [],
  };
}

/**
 * The whole output bound spent on reasoning, no answer: the reasoning count
 * in the wire format a Chat Completions provider reports it in, where the gateway reads it.
 */
export function reasoningOnly(bound: number): LanguageModelV4GenerateResult {
  return {
    content: [{ type: "reasoning", text: "Let me think about every part of this carefully before answering." }],
    finishReason: { unified: "length", raw: "length" },
    usage: {
      inputTokens: USAGE.inputTokens,
      outputTokens: { total: bound, text: 0, reasoning: bound },
      raw: { completion_tokens: bound, completion_tokens_details: { reasoning_tokens: bound } },
    },
    warnings: [],
  };
}

/**
 * A provider's rejection of a request longer than the model's context window, as an adapter throws
 * it: HTTP 400 with the provider's error body. The body is the OpenAI-compatible wire format's, the
 * error data the gateway reads it by (model-access context-window.ts), never a provider name.
 */
export function contextOverflow(modelId: string): APICallError {
  const message =
    `This model's maximum context length is 131072 tokens. ` + `However, you requested 140000 tokens (simulated).`;
  return new APICallError({
    message,
    url: `simulated://${modelId}`,
    requestBodyValues: {},
    statusCode: 400,
    responseBody: JSON.stringify({
      error: { message, type: "invalid_request_error", code: "context_length_exceeded" },
    }),
    isRetryable: false,
  });
}

/** The first half of a JSON text: never valid JSON itself, as an answer cut mid-object is not. */
export function firstHalf(json: string): string {
  return json.slice(0, Math.max(1, Math.floor(json.length / 2)));
}

const jsonSchemaShape = z.object({
  properties: z.record(z.string(), z.unknown()).optional(),
  anyOf: z.array(z.object({ properties: z.record(z.string(), z.unknown()).optional() })).optional(),
  oneOf: z.array(z.object({ properties: z.record(z.string(), z.unknown()).optional() })).optional(),
});

/** The top-level property names of a structured request's JSON schema: which call site it is. */
export function schemaKeys(schema: unknown): string[] {
  const parsed = jsonSchemaShape.safeParse(schema);
  if (!parsed.success) return [];
  /* eslint-disable-next-line no-restricted-syntax -- policy default: stand-in test plumbing, a JSON schema without
     variants has none; no oracle reads it */
  const variants = [...(parsed.data.anyOf ?? []), ...(parsed.data.oneOf ?? [])];
  /* eslint-disable-next-line no-restricted-syntax -- policy default: stand-in test plumbing, a JSON schema without
     properties has none; no oracle reads it */
  return [...Object.keys(parsed.data.properties ?? {}), ...variants.flatMap((v) => Object.keys(v.properties ?? {}))];
}

/** The provider a stand-in model answers as: the factory names each model `<provider>/<model id>`. */
export function providerOf(modelId: string): string {
  const [provider] = modelId.split("/");
  return provider === undefined || provider === "" ? modelId : provider;
}

/** Every text the call's prompt carries, in order: what a model reads. */
export function promptText(options: LanguageModelV4CallOptions): string {
  const parts: string[] = [];
  for (const message of options.prompt) {
    if (message.role === "system") {
      parts.push(message.content);
      continue;
    }
    for (const part of message.content) if (part.type === "text") parts.push(part.text);
  }
  return parts.join("\n");
}

export function assistantTurns(options: LanguageModelV4CallOptions): number {
  return options.prompt.filter((message) => message.role === "assistant").length;
}

/**
 * One structured answer, or one of the response-level misbehaviours a provider shows: output
 * that does not parse, no content, the whole bound spent on reasoning, or the answer cut at the
 * bound mid-object.
 */
export async function structuredAnswer<T>(
  context: StandInContext,
  options: LanguageModelV4CallOptions,
  site: string,
  answer: () => T | Promise<T>,
  delivered?: (value: T) => void,
): Promise<LanguageModelV4GenerateResult> {
  const { tape, rates, onModelCall } = context;
  if (tape.chance(`model.${site}.invalid`, rates.invalidOutput)) {
    onModelCall({ site, action: "invalid-output" });
    return textResult('{"not": "what was asked"');
  }
  if (tape.chance(`model.${site}.empty`, rates.emptyStructured)) {
    onModelCall({ site, action: "empty" });
    return EMPTY;
  }
  if (tape.chance(`model.${site}.reasoning-exhausted`, rates.reasoningExhausted)) {
    onModelCall({ site, action: "reasoning-exhausted" });
    return reasoningOnly(outputBoundOf(options));
  }
  const value = await answer();
  if (tape.chance(`model.${site}.truncated`, rates.truncatedStructured)) {
    onModelCall({ site, action: "truncated" });
    return cutAtBound([{ type: "text", text: firstHalf(JSON.stringify(value)) }], outputBoundOf(options));
  }
  onModelCall({ site, action: "answered" });
  delivered?.(value);
  return textResult(JSON.stringify(value));
}
