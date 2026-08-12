import { z } from "zod";
import { ProjectFrameSchema } from "./project-frame.js";

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
 *  - FRAME — `projectFrame`: what the project IS (owner intent, verbatim, plus
 *    the target stack as labels and where that stack was derived from). REQUIRED,
 *    and rendered ahead of everything else, because it is the one thing the agent
 *    cannot discover for itself and will otherwise fill in from its training
 *    prior — whose mode is Node/TypeScript regardless of what the vision said
 *    (ADR-046). On the scaffold task the working tree is empty BY CONSTRUCTION,
 *    so there is nothing to detect and no gap for the agent to notice: absence of
 *    the frame is indistinguishable from confirmation of the prior. Being
 *    required here is what turns seven silent degradations into one compile error
 *    plus one parse error, on both sides of the process seam.
 *  - BINDING — `taskId`, `goal`, `context`, `tools`, `constraints`,
 *    `deliverables`, `contractSlice`, `priorAttemptFailure`,
 *    `knowledgeContext`: the task instruction, requirements the agent must
 *    satisfy, and prior lessons. `knowledgeContext` is rendered alongside
 *    `priorAttemptFailure` (before task context) so failure lessons carry
 *    the same weight as explicit failure context.
 *  - SUPPLEMENTARY — `codeContext`, `contextMap`: retrieved code and the
 *    project context map. Useful reference rendered after the binding
 *    sections.
 *
 * `task_spec` — INCLUDED, consciously. It is not rendered into the system
 * prompt, but the agent-runner reads `task_spec.checks` off `brief.json` to
 * seed inline verification. Declared as a typed object with only the consumed
 * field (`checks`); the producer constructs this field explicitly (normalising
 * the optional `StoredTaskSpec.checks` into a required `string[]`), and
 * unrecognized keys from the full `StoredTaskSpec` never reach this schema.
 * This is deliberate: only what the consumer reads crosses the process seam.
 * `checks` is REQUIRED within `task_spec`: the producer normalises
 * `StoredTaskSpec.checks ?? []` at the construction site, so the "no checks
 * stated" case is an explicit empty array, never an absent field. The consumer
 * falls back to `[]` ONLY when `task_spec` itself is absent (a task with no
 * spec at all), not when `checks` is missing — that second case is now a parse
 * error. Natural-language constraints must never reach the executable check
 * pipeline (constraint ≠ check). `goal` and `endState` are read from the
 * domain `WorkItem.taskSpec` before the brief is assembled, not from this
 * field.
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
    // Frame tier — required; see the field-tier note above.
    projectFrame: ProjectFrameSchema,
    context: z.string().min(1),
    tools: z.array(z.string()).default([]),
    constraints: z.array(z.string()).default([]),
    deliverables: z.array(z.string()).default([]),
    // Binding tier — prior lessons rendered alongside priorAttemptFailure.
    knowledgeContext: z.string().optional(),
    // Supplementary tier — reference context rendered after binding sections.
    codeContext: z.string().optional(),
    contextMap: z.string().optional(),
    // Typed passthrough — only `checks` is consumed (by inline verify in
    // agent-runner); the producer constructs this object explicitly with the
    // normalised checks array. Not `.strict()`: the inner object is the
    // producer's construction, not an external boundary, and strictness would
    // couple it to the full StoredTaskSpec shape for no gain — undeclared fields
    // never arrive because the producer constructs only `{ checks }`.
    task_spec: z
      .object({
        checks: z.array(z.string()),
      })
      .optional(),
    // Binding, conditional. Non-empty when present: the producer only emits
    // these when it has real content, so an empty string is a malformed brief.
    priorAttemptFailure: z.string().min(1).optional(),
    contractSlice: z.string().min(1).optional(),
    // Artifact context: a prose snapshot of the project's current state — which
    // endpoints work/fail, what tasks have been completed, key files on disk — so
    // the agent knows what already exists before starting. Written by
    // termination-snapshot when creating gap tasks from acceptance rejection.
    artifactContext: z.string().min(1).optional(),
    // Per-task binary unblock: the orchestrator can selectively allow binaries
    // that are otherwise in DEFAULT_BLOCKED_BINARIES (e.g. "docker" for a
    // container-provisioning task). The agent-runner filters blockedBinaries
    // against this list when constructing CommandPolicyConfig. Optional: when
    // absent, all defaults remain blocked.
    allowedBinaries: z.array(z.string().min(1)).optional(),
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
 * Constructs an `AgentBrief` from a TYPED local value — used at producer sites
 * where the shape is known at compile time (execution-service.ts). The TypeScript
 * compiler checks the input type: a misspelt field, a wrong type, or an omitted
 * required field is a `TS####` error at the construction site. The Zod parse
 * still runs as a defence-in-depth layer (C2: the producer-side parse is
 * additional, not replaced by the compiler check).
 *
 * The input type is `AgentBrief` itself — the schema's OUTPUT type (`z.infer`),
 * not its input type (`z.input`). This means every field with a `.default()`
 * (`tools`, `constraints`, `deliverables`) must be supplied explicitly by the
 * producer: omission is a compile error, not a silent default. The `.default()`
 * clauses still serve the CONSUMER (the `unknown` entry point), where a
 * legacy/degraded brief might omit them. Fields that are `.optional()` in the
 * schema (`knowledgeContext`, `codeContext`, `task_spec`, etc.) remain
 * legitimately omittable.
 *
 * For untrusted input crossing a process boundary (agent-runner reading
 * `brief.json` from disk), use {@link parseAgentBrief} instead.
 */
export function createAgentBrief(input: AgentBrief, source: string): AgentBrief {
  return parseAgentBrief(input, source);
}

/**
 * Parses an UNTRUSTED `brief.json` value into a validated `AgentBrief`,
 * throwing a typed {@link InvalidAgentBriefError} on failure. Used at the
 * consumer (agent-runner), where JSON arrives from a subprocess and types do
 * not survive serialisation. The producer uses {@link createAgentBrief} for
 * compile-time checking with the same runtime parse underneath.
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
