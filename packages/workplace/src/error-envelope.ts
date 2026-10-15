import { z } from "zod";
import { errorLayerSchema, flattenChain } from "@ashara/shared";

/** How a dispatch failed, with the chain of layers that recorded it: what a replanned attempt's brief renders. */
export const errorEnvelopeSchema = z.object({
  outcome: z.enum(["failed", "blocked"]),
  summary: z.string(),
  chain: errorLayerSchema,
  agentOutput: z.record(z.string(), z.unknown()).optional(),
});

export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

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
