import { errorEnvelopeSchema, flattenChain } from "@ashara/shared";
import type { ErrorEnvelope, ErrorLayer } from "@ashara/shared";

export type FailureCategory =
  | "VERIFICATION_GAP"
  | "COMPILATION_ERROR"
  | "AGENT_STUCK"
  | "SPAWN_FAILURE"
  | "MERGE_CONFLICT"
  | "TREE_REGRESSION";

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
      // POLICY default: absent context is empty — the "conflict" discriminator
      // this branch searches for lives in layer.message, not layer.context.
      const text = `${layer.message} ${JSON.stringify(layer.context ?? {})}`.toLowerCase();
      if (text.includes("conflict")) return "MERGE_CONFLICT";
      return "SPAWN_FAILURE";
    }

    case "agentExecution":
      return classifyAgentExecution(layer, envelope);

    case "postMergeVerify":
      return "TREE_REGRESSION";

    // The stored checks are the task's only verdict: a failure is the task's work, not the tree.
    case "postMergeTaskChecks":
    case "entryPointRewriteCheck":
    // The branch wrote another role's files (a stored check file): the task's own work, retried with the reason.
    case "ownershipGate":
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
    /\berror\b.*\b\d{4}\b/.test(text) ||
    /\b(?:compil|build).*(fail|error)/i.test(text) ||
    text.includes("compilation failed") ||
    text.includes("build failed") ||
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
  switch (category) {
    case "VERIFICATION_GAP":
    case "AGENT_STUCK":
      return priorCategories.includes(category);

    case "COMPILATION_ERROR":
    case "SPAWN_FAILURE":
    case "MERGE_CONFLICT":
    case "TREE_REGRESSION":
      return false;

    default: {
      const _exhaustive: never = category;
      throw new Error(`Unhandled FailureCategory in shouldEscalate: ${String(_exhaustive)}`);
    }
  }
}

// open-by-design: raw is a candidate, not a known ErrorEnvelope — safeParse tests whether it conforms
export function tryParseEnvelope(raw: Record<string, unknown>): ErrorEnvelope | null {
  const parsed = errorEnvelopeSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
