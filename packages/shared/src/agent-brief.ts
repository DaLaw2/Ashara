import { z } from "zod";

/**
 * AgentBriefSchema — the single validated contract for `brief.json`, the file
 * the Development BC writes and the agent-runner subprocess reads (SEAM-1;
 * ADR-013; ADR-033 §5). It lives in the Shared Kernel so BOTH sides of the
 * cross-process seam parse the SAME schema, instead of a producer type erased
 * to `Record<string, unknown>` and a hand-rolled consumer validator that
 * silently dropped fields. That erasure was finding-g: `knowledgeContext`,
 * `codeContext`, and `contextMap` were assembled at cost and then dropped by the
 * consumer, so the knowledge AND retrieval subsystems never reached any agent
 * prompt through Run 11 (triple-verified). With every seam field explicit here,
 * a producer field not in the schema is a compile error (the producer returns
 * `AgentBrief`) or a parse error (`.strict()`), never an invisible drop.
 *
 * Field tiers:
 *  - BINDING — `taskId`, `goal`, `context`, `tools`, `constraints`,
 *    `deliverables`, `contractSlice`, `priorAttemptFailure`: the task
 *    instruction and the requirements the agent must satisfy. Rendered FIRST in
 *    every prompt path.
 *  - ADVISORY — `knowledgeContext`, `codeContext`, `contextMap`: prior lessons,
 *    retrieved code, and the project context map. Context the agent should
 *    consider, never a gate. Restored here after the drop; every prompt path
 *    renders them AFTER the binding sections so advisory prose can never
 *    displace the contract slice.
 *
 * `task_spec` — INCLUDED, consciously. It is not rendered into the system
 * prompt, but the agent-runner reads it back off `brief.json` to seed inline
 * verification (goal / endState / checks). Excluding it would drop that field on
 * a strict parse and blind inline verify. Kept as an opaque record: its internal
 * shape is owned by the DB `task_spec` column and validated where it is
 * consumed, not re-specified at this seam.
 *
 * Arrays default to `[]` when absent (a Rust-era fallback stub brief may omit
 * them); a present-but-wrong-typed array is a parse error, not a silent `[]`
 * (the old `as string[]` fail-soft). `.strict()`: an unexpected producer field
 * fails the parse rather than riding along invisibly.
 */
export const AgentBriefSchema = z
  .object({
    taskId: z.string().min(1),
    goal: z.string().min(1),
    context: z.string().min(1),
    tools: z.array(z.string()).default([]),
    constraints: z.array(z.string()).default([]),
    deliverables: z.array(z.string()).default([]),
    // Advisory tier — restored (finding-g). Optional: a basic/fallback brief
    // omits them; the full brief carries them (possibly empty strings).
    knowledgeContext: z.string().optional(),
    codeContext: z.string().optional(),
    contextMap: z.string().optional(),
    // Opaque passthrough — consumed by inline verify, never the prompt.
    task_spec: z.record(z.string(), z.unknown()).optional(),
    // Binding, conditional. Non-empty when present: the producer only emits
    // these when it has real content, so an empty string is a malformed brief.
    priorAttemptFailure: z.string().min(1).optional(),
    contractSlice: z.string().min(1).optional(),
  })
  .strict();

export type AgentBrief = z.infer<typeof AgentBriefSchema>;

/**
 * Fail-closed parse error for `brief.json` (Discipline A + C). Carries the seam
 * source and the per-field Zod issues so the message alone says which field of
 * which side's brief was malformed — the original context survives across the
 * subprocess boundary rather than collapsing to `error.toString()`.
 */
export class InvalidAgentBriefError extends Error {
  constructor(
    public readonly context: {
      readonly source: string;
      readonly issues: ReadonlyArray<{ readonly path: string; readonly message: string }>;
    },
  ) {
    super(
      `Invalid agent brief from ${context.source}: ` +
        context.issues.map((i) => `${i.path === "" ? "(root)" : i.path}: ${i.message}`).join("; "),
    );
    this.name = "InvalidAgentBriefError";
  }
}

/**
 * Parses an untrusted `brief.json` value into a validated `AgentBrief`,
 * throwing a typed {@link InvalidAgentBriefError} on failure. Both the producer
 * (Development, at write time) and the consumer (agent-runner, at read time)
 * call this — one schema, validated not transformed, across the seam.
 */
export function parseAgentBrief(raw: unknown, source: string): AgentBrief {
  const result = AgentBriefSchema.safeParse(raw);
  if (!result.success) {
    throw new InvalidAgentBriefError({
      source,
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  return result.data;
}
