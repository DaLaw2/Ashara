import { z } from "zod";

/**
 * Published Language: the persisted task specification stored in the jsonb
 * `task_spec` column. All fields optional — not every level carries a spec,
 * and different producers populate different subsets. The key set is closed — every lifecycle
 * extension is a declared field, so a producer writing an undeclared key is a
 * compile error, not a silent `unknown`.
 */
const storedTaskSpecSchema = z.object({
  // Core specification (decomposition engine output)
  goal: z.string().optional(),
  endState: z.string().optional(),
  scope: z.string().optional(),
  deliverables: z.array(z.string()).optional(),
  checks: z.array(z.string()).optional(),

  // Decomposition metadata
  priorWorkPointers: z.array(z.string()).optional(),
  capability: z.string().optional(),
});

export type StoredTaskSpec = z.infer<typeof storedTaskSpecSchema>;

/**
 * Typed failure for a task_spec jsonb value that is present but unreadable.
 * @testseam task-spec.test.ts asserts the typed rejection and its context
 */
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
 * null/undefined — absent taskSpec is a policy default (epics and HTTP-created
 * tasks may not carry one). THROWS on a non-null value that
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
