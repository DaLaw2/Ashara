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

  // Decomposition metadata
  capability: z.string().optional(),
  // Which producer wrote the task: the decomposition of the client's goal, or the
  // Sprint 0 task decomposition adds to every plan, in which the environment role
  // defines the project environment (story s-platform-role-m1; migration 033
  // renamed stored 'scaffold'), or the check task decomposition adds for every
  // decomposed task, in which the check author writes the checks that decide it
  // (story s-independent-verify-m1), or the environment task Z0 opens when an
  // implementation's work needs a change under environment/, in which the
  // environment role makes it (ADR-074 addendum 2 d66 b). Absent on rows written
  // before it was recorded.
  origin: z.enum(["decomposition", "sprint0", "check", "environment-change"]).optional(),
  // What checks the task's work: "substrate" means the checks are the
  // environment substrate's own (the definition parses, the image builds, its
  // test command passes), so the task carries none of its own. Absent means no
  // producer has said.
  checkedBy: z.enum(["substrate"]).optional(),
  // A check task's: the work item id of the implementation task its checks decide. Every
  // implementation task of a plan revision depends on every check task of it (ADR-074 addendum 2
  // d67 a), so the dependency edges no longer say which one. Absent on rows written before it.
  checksFor: z.string().min(1).optional(),
});

export type StoredTaskSpec = z.infer<typeof storedTaskSpecSchema>;

/**
 * Typed failure for a task_spec jsonb value that is present but unreadable.
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
