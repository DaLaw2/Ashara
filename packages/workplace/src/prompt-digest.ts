import { createHash } from "node:crypto";

/** Object keys sorted at every depth, so equal requests serialize to equal bytes whatever their key order. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(entries.map(([key, inner]) => [key, canonical(inner)]));
}

/**
 * sha256 (hex) over the canonical JSON of what an attempt's first model call is sent: the system
 * prompt, the messages and the tool schemas. Two attempts with the same digest were given the same
 * prompt; any change to the brief, the system prompt or the offered tools changes it.
 */
export function promptDigest(request: { readonly system: string; readonly messages: unknown; readonly tools: unknown }): string {
  const json = JSON.stringify(canonical({ system: request.system, messages: request.messages, tools: request.tools }));
  return createHash("sha256").update(json, "utf8").digest("hex");
}
