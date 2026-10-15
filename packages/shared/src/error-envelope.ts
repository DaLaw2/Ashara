import { z } from "zod";
import { errorHead, serializeError } from "./error-chain.js";
import type { SerializedError } from "./error-chain.js";

export interface ErrorLayer {
  readonly boundary: string;
  readonly operation: string;
  readonly message: string;
  // open-by-design: diagnostic context is caller-supplied, shape varies per boundary/operation
  readonly context?: Record<string, unknown>;
  readonly cause?: ErrorLayer;
  readonly timestamp: string;
}

const errorLayerSchema: z.ZodType<ErrorLayer> = z.lazy(() =>
  z.object({
    boundary: z.string(),
    operation: z.string(),
    message: z.string(),
    context: z.record(z.string(), z.unknown()).optional(),
    cause: errorLayerSchema.optional(),
    timestamp: z.string(),
  }),
);

export const errorEnvelopeSchema = z.object({
  outcome: z.enum(["failed", "blocked"]),
  summary: z.string(),
  chain: errorLayerSchema,
  agentOutput: z.record(z.string(), z.unknown()).optional(),
});

export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

/** A serialized error layer by layer as origin layers: its class as the operation, its own fields and child errors as the context. */
function originLayer(s: SerializedError, timestamp: string): ErrorLayer {
  const truncation = s.truncated !== undefined ? { chainTruncated: s.truncated } : {};
  const children = s.errors !== undefined ? { errors: s.errors } : {};
  const notKept = s.errorsNotKept !== undefined ? { errorsNotKept: s.errorsNotKept } : {};
  return {
    boundary: "origin",
    operation: s.name,
    message: s.message,
    context: { errorClass: s.name, ...s.fields, ...children, ...notKept, ...truncation },
    ...(s.cause !== undefined ? { cause: originLayer(s.cause, timestamp) } : {}),
    timestamp,
  };
}

/**
 * The value as an ErrorLayer when it is one. A value whose `in` check or property reads throw (a
 * revoked Proxy, a throwing getter) is not a layer; the caller serializes it instead, and the
 * serializer describes it rather than throwing.
 */
function asErrorLayer(error: unknown): ErrorLayer | undefined {
  try {
    if (typeof error !== "object" || error === null || !("boundary" in error)) return undefined;
    const parsed = errorLayerSchema.safeParse(error);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The layer a boundary records a failure under. An ErrorLayer passed in becomes the cause as it is;
 * a thrown Error becomes the cause through the one serializer (serializeError), its class, own
 * typed fields, child errors and cause chain kept; any other value is the message alone. Never
 * throws on a hostile value: every read of it goes through the serializer's guards.
 */
export function wrapError(
  boundary: string,
  operation: string,
  error: unknown,
  // open-by-design: diagnostic context is caller-supplied, shape varies per boundary/operation
  context?: Record<string, unknown>,
): ErrorLayer {
  const timestamp = new Date().toISOString();
  let message: string;
  let cause: ErrorLayer | undefined;
  const asLayer = asErrorLayer(error);
  if (asLayer !== undefined) {
    message = asLayer.message;
    cause = asLayer;
  } else {
    // The layer's own message is cut only at the per-string bound; the copy inside the cause also fits the chain's bound.
    const head = errorHead(error);
    message = head.message;
    cause = head.isError ? originLayer(serializeError(error), timestamp) : undefined;
  }
  return {
    boundary,
    operation,
    message,
    ...(context !== undefined ? { context } : {}),
    ...(cause !== undefined ? { cause } : {}),
    timestamp,
  };
}

/** @testseam error-envelope.test.ts reads a chain's layers in order through it; renderChainForBrief is its production caller */
export function flattenChain(layer: ErrorLayer): ErrorLayer[] {
  const result: ErrorLayer[] = [];
  let current: ErrorLayer | undefined = layer;
  while (current) {
    result.push(current);
    current = current.cause;
  }
  return result;
}

export function renderChainForBrief(envelope: ErrorEnvelope): string {
  const layers = flattenChain(envelope.chain);
  const lines: string[] = [
    `# Error Chain (${layers.length} layer${layers.length > 1 ? "s" : ""})`,
    "",
  ];

  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i]!;
    const indent = i === 0 ? "" : "  ".repeat(i);
    lines.push(`${indent}[${layer.boundary}/${layer.operation}] ${layer.message}`);
    if (layer.context) {
      for (const [key, value] of Object.entries(layer.context)) {
        const valueStr = typeof value === "string" ? value : JSON.stringify(value);
        lines.push(`${indent}  ${key}: ${valueStr}`);
      }
    }
  }

  return lines.join("\n");
}
