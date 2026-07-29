import { z } from "zod";

export interface ErrorLayer {
  readonly boundary: string;
  readonly operation: string;
  readonly message: string;
  // open-by-design: diagnostic context is caller-supplied, shape varies per boundary/operation
  readonly context?: Record<string, unknown>;
  readonly cause?: ErrorLayer;
  readonly timestamp: string;
}

export const errorLayerSchema: z.ZodType<ErrorLayer> = z.lazy(() =>
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
  gateResults: z
    .object({
      integration: z.unknown().optional(),
      smoke: z.unknown().optional(),
    })
    .optional(),
  agentOutput: z.record(z.string(), z.unknown()).optional(),
});

export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

function extractErrorLayer(error: unknown): ErrorLayer | undefined {
  if (typeof error === "object" && error !== null && "boundary" in error) {
    const parsed = errorLayerSchema.safeParse(error);
    if (parsed.success) return parsed.data;
  }
  if (error instanceof Error && "context" in error) {
    // open-by-design: typed Error subclasses carry caller-defined diagnostic context
    const ctx = error as Error & { context: Record<string, unknown> };
    return {
      boundary: "origin",
      operation: error.name,
      message: error.message,
      context: ctx.context,
      cause: error.cause ? extractErrorLayer(error.cause) : undefined,
      timestamp: new Date().toISOString(),
    };
  }
  return undefined;
}

export function wrapError(
  boundary: string,
  operation: string,
  error: unknown,
  // open-by-design: diagnostic context is caller-supplied, shape varies per boundary/operation
  context?: Record<string, unknown>,
): ErrorLayer {
  const existingLayer = extractErrorLayer(error);

  const message =
    existingLayer != null
      ? existingLayer.message
      : error instanceof Error
        ? error.message
        : String(error);

  return {
    boundary,
    operation,
    message,
    context,
    cause: existingLayer ?? undefined,
    timestamp: new Date().toISOString(),
  };
}

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
