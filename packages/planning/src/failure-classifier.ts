import { errorEnvelopeSchema, flattenChain } from "@ashara/shared";
import type { ErrorEnvelope, ErrorLayer } from "@ashara/shared";

export type FailureCategory =
  | "VERIFICATION_GAP"
  | "COMPILATION_ERROR"
  | "AGENT_STUCK"
  | "SPAWN_FAILURE"
  | "MERGE_CONFLICT";

const ESCALATABLE_CATEGORIES: ReadonlySet<FailureCategory> = new Set([
  "VERIFICATION_GAP",
  "AGENT_STUCK",
]);

export function classifyFailure(envelope: ErrorEnvelope): FailureCategory {
  const layers = flattenChain(envelope.chain);

  for (const layer of layers) {
    const category = classifyLayer(layer, envelope);
    if (category !== null) return category;
  }

  return "VERIFICATION_GAP";
}

function classifyLayer(layer: ErrorLayer, envelope: ErrorEnvelope): FailureCategory | null {
  switch (layer.operation) {
    case "createWorkdir":
    case "createWorktree":
      return "SPAWN_FAILURE";

    case "tentativeMerge": {
      const text = `${layer.message} ${JSON.stringify(layer.context ?? {})}`.toLowerCase();
      if (text.includes("conflict")) return "MERGE_CONFLICT";
      return "SPAWN_FAILURE";
    }

    case "agentExecution":
      return classifyAgentExecution(layer, envelope);

    case "smokeTest":
    case "smokeFailed":
    case "integrationGate":
    case "integrationGateFailed":
    case "postMergeVerify":
    case "verify":
    case "entryPointRewriteCheck":
      return "VERIFICATION_GAP";
  }

  return null;
}

function classifyAgentExecution(layer: ErrorLayer, envelope: ErrorEnvelope): FailureCategory {
  const text = collectSearchableText(layer, envelope);

  if (isCompilationFailure(text)) return "COMPILATION_ERROR";
  if (isAgentStuck(text, layer)) return "AGENT_STUCK";

  return "VERIFICATION_GAP";
}

function collectSearchableText(layer: ErrorLayer, envelope: ErrorEnvelope): string {
  const parts: string[] = [layer.message, envelope.summary];
  if (layer.context) {
    for (const value of Object.values(layer.context)) {
      if (typeof value === "string") parts.push(value);
    }
  }
  return parts.join(" ").toLowerCase();
}

function isCompilationFailure(text: string): boolean {
  return (
    /error ts\d{4}/.test(text) ||
    /tsc.*(fail|error)/.test(text) ||
    text.includes("typescript compilation") ||
    text.includes("compile error") ||
    text.includes("syntax error")
  );
}

function isAgentStuck(text: string, layer: ErrorLayer): boolean {
  if (
    text.includes("turn limit") ||
    text.includes("nudge") ||
    text.includes("empty output") ||
    text.includes("no file changes")
  ) {
    return true;
  }

  const finishReason = layer.context?.["finishReason"];
  if (finishReason === "turn_limit" || finishReason === "max_turns") return true;

  return false;
}

export function shouldEscalate(
  category: FailureCategory,
  priorCategories: readonly FailureCategory[],
): boolean {
  if (!ESCALATABLE_CATEGORIES.has(category)) return false;
  return priorCategories.includes(category);
}

export function tryParseEnvelope(raw: Record<string, unknown>): ErrorEnvelope | null {
  const parsed = errorEnvelopeSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
