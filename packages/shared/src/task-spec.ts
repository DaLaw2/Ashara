import { z } from "zod";

/**
 * Published Language: the persisted task specification stored in the jsonb
 * `task_spec` column. All fields optional — not every level carries a spec,
 * and different origins populate different subsets. Origin membership is open
 * (`origin: z.string().optional()`); the key set is closed — every lifecycle
 * extension is a declared field, so a producer writing an undeclared key is a
 * compile error, not a silent `unknown`.
 */
export const storedTaskSpecSchema = z.object({
  // Core specification (decomposition engine output)
  goal: z.string().optional(),
  endState: z.string().optional(),
  scope: z.string().optional(),
  deliverables: z.array(z.string()).optional(),
  checks: z.array(z.string()).optional(),

  // Decomposition metadata
  priorWorkPointers: z.array(z.string()).optional(),
  capability: z.string().optional(),

  // Origin marker — open string, NOT an enum. Known values as of writing:
  // "acceptance-gap", "coverage-reconciliation". New origins appear without
  // code changes; this field is read by dispatch selection (TaskSelector),
  // not by a switch that needs exhaustiveness.
  origin: z.string().optional(),

  // Acceptance-gap lifecycle (termination-snapshot.ts via acceptance.ts).
  // Written by termination-snapshot, read by nothing today — story unwired-surface.
  lesson: z.string().optional(),
  suggestedApproach: z.string().optional(),
  supersedes: z.string().optional(),

  // Liveness-recovery lifecycle (liveness-recovery.ts via replan-from-vision.ts).
  // Written by liveness-recovery, read by nothing today — story unwired-surface.
  approach: z.string().optional(),
  differentiator: z.string().optional(),
  substitutesFor: z.string().optional(),

  // Artifact context (termination-snapshot.ts gap task creation).
  // A prose snapshot of the project's current state — working/failed endpoints,
  // completed tasks, key files — so a gap task's agent brief knows what already
  // exists on disk rather than re-implementing from scratch.
  artifactContext: z.string().optional(),
});

export type StoredTaskSpec = z.infer<typeof storedTaskSpecSchema>;

/** Typed failure for a task_spec jsonb value that is present but unreadable. */
export class TaskSpecCorrupt extends Error {
  constructor(
    public readonly raw: unknown,
    public readonly detail: string,
  ) {
    super(`stored task_spec is not a valid object (${detail})`);
    this.name = "TaskSpecCorrupt";
  }
}

/**
 * Parses a jsonb value from the `task_spec` column. Returns `undefined` for
 * null/undefined — absent taskSpec is a policy default (epics, stories, and
 * HTTP-created tasks may not carry one). THROWS on a non-null value that
 * cannot be validated: a corrupt record must not masquerade as absent
 * (Discipline A).
 */
export function parseStoredTaskSpec(raw: unknown): StoredTaskSpec | undefined {
  if (raw === null || raw === undefined) return undefined;
  const result = storedTaskSpecSchema.safeParse(raw);
  if (!result.success) {
    throw new TaskSpecCorrupt(
      raw,
      result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  }
  return result.data;
}
