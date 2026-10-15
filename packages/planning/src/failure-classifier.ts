import { errorEnvelopeSchema, flattenChain } from "@ashara/shared";
import type { ErrorEnvelope, ErrorLayer } from "@ashara/shared";

/**
 * The category of a failure of the agent's own work (development's fault-class.ts `agent_work`):
 * the only failures routed here. A fault of the substrate or of Ashara's own Z0 machinery (a
 * worktree that cannot be created, a merge git refuses for a reason other than a conflict, a
 * conflict that cannot be prepared) is blocked under its class and never reaches the router.
 */
export type FailureCategory =
  | "VERIFICATION_GAP"
  | "COMPILATION_ERROR"
  | "AGENT_STUCK"
  | "MERGE_CONFLICT"
  /** The attempt was handed its conflict with main and finished done with conflict markers left in it. */
  | "MERGE_CONFLICT_PERSISTS"
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
    // Only a conflict is recorded under tentativeMerge; any other merge failure is Z0's and blocked.
    // POLICY default: absent context is empty — the "conflict" discriminator lives in layer.message.
    case "tentativeMerge": {
      const text = `${layer.message} ${JSON.stringify(layer.context ?? {})}`.toLowerCase();
      return text.includes("conflict") ? "MERGE_CONFLICT" : null;
    }

    // A branch that holds the presented main and conflicts again met main's newer work, merged
    // under the resolution by another task: a fresh conflict, not the implementer's failure.
    case "tentativeMergeAfterConflict":
      return "MERGE_CONFLICT";

    // Handed the conflict with main and finished done with markers left in it.
    case "conflictMarkersLeft":
      return "MERGE_CONFLICT_PERSISTS";

    case "agentExecution":
      return classifyAgentExecution(layer, envelope);

    case "postMergeVerify":
      return "TREE_REGRESSION";

    // The stored checks are the task's only verdict: a failure is the task's work, not the tree. So
    // is the product scaffold's build and test on its merge (ADR-074 addendum 2 d74 D).
    case "postMergeTaskChecks":
    case "postMergeScaffold":
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
    case "MERGE_CONFLICT":
    case "MERGE_CONFLICT_PERSISTS":
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
