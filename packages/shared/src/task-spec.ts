import { z } from "zod";

/**
 * Published Language: the persisted task specification stored in the jsonb
 * `task_spec` column. Read back by the adapter, consumed by every downstream
 * reader (brief assembly, budget, failure recovery, task split, dispatch
 * selection). All fields are optional because not every work-item level carries
 * a spec (epics/stories do not) and different producers populate different
 * subsets.
 *
 * `.passthrough()` preserves lifecycle extensions that vary by origin —
 * bug-fix metadata, acceptance-gap lessons, split tracking — without
 * enumerating every origin's fields. The named fields are the ones code
 * reads through typed access; everything else rides through as `unknown`
 * via the index signature (open-world: origins are NOT a closed domain).
 */
export const storedTaskSpecSchema = z
  .object({
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
    // "acceptance-gap", "coverage-reconciliation", "bug-fix". New origins
    // appear without code changes; this field is read by dispatch selection
    // (TaskSelector) and bug-fix dedup, not by a switch that needs exhaustiveness.
    origin: z.string().optional(),

    // Task-split lifecycle (task-split.ts)
    splitDepth: z.number().optional(),
    splitFrom: z.string().optional(),

    // Bug-fix metadata (bug-fix.ts)
    culpritTaskId: z.string().optional(),
    culpritTitle: z.string().optional(),
    failureDiagnostic: z.string().optional(),
    implicatedFiles: z.array(z.string()).optional(),
    suggestedFix: z.string().optional(),

    // Acceptance-gap lifecycle (termination-snapshot.ts via acceptance.ts)
    lesson: z.string().optional(),
    suggestedApproach: z.string().optional(),
    supersedes: z.string().optional(),
  })
  .passthrough();

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
