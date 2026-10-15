import { z } from "zod";
import { CapabilityLevelSchema } from "@ashara/model-access";
import { VisionSourceSchema } from "../acl/engagement-vision-acl.js";

/** An acceptance line of a decomposed task with the ids of the vision items it serves (d89 A). */
const TracedLineSchema = z.strictObject({ line: z.string().min(1), sources: z.array(z.string().min(1)).min(1) });

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

  // The capability level the task's agent is dispatched at (ADR-074 addendum 2 d70): graded by the
  // planner for a decomposed task, a fixed planner policy for the tasks the plan adds itself. Dispatch
  // refuses a task without one (TaskCapabilityUngraded); absent only on rows written before it.
  capability: CapabilityLevelSchema.optional(),
  // Why the planner graded the task at that level, in its own words; absent on a fixed-level task.
  capabilityReason: z.string().min(1).optional(),
  // Which producer wrote the task: the decomposition of the client's goal, or the
  // Sprint 0 task decomposition adds to every plan, in which the environment role
  // defines the project environment (story s-platform-role-m1; migration 033
  // renamed stored 'scaffold'), or the check task decomposition adds for every
  // decomposed task, in which the check author writes the checks that decide it
  // (story s-independent-verify-m1), or the environment task Z0 opens when an
  // implementation's work needs a change under environment/, in which the
  // environment role makes it (ADR-074 addendum 2 d66 b), or the review decomposition
  // adds to every plan revision, in which every suite its check tasks stored is read
  // together before any implementation starts (ADR-074 addendum 2 d71 c), or the product scaffold
  // decomposition adds after Sprint 0 and before the check tasks, in which the implementer role
  // sets up the product's module root, manifests and entry point (d72 B2; not the pre-033
  // 'scaffold', which was Sprint 0), or the defect Z0 opens for a failed acceptance sweep on main
  // (migration 049), given up at once so the plan is repaired around it and never dispatched.
  // Absent on rows written before it was recorded.
  origin: z.enum(["decomposition", "sprint0", "check", "environment-change", "review", "product-scaffold", "acceptance"]).optional(),
  // What checks the task's work: "substrate" means the checks are the environment
  // substrate's own, so the task carries none of its own: for environment work the
  // definition parses, the image builds and its probe passes; for the product scaffold
  // the definition's build and test pass on its merge (d72). Absent means no producer
  // has said.
  checkedBy: z.enum(["substrate"]).optional(),
  // A check task's: the work item id of the implementation task its checks decide. Every
  // implementation task of a plan revision depends on every check task of it (ADR-074 addendum 2
  // d67 a), so the dependency edges no longer say which one. Absent on rows written before it.
  checksFor: z.string().min(1).optional(),
  // The vision items, as the vision states them, the task traces to (ADR-074 addendum 2 d71 d): a
  // decomposed task's are those it delivers, its check task's are the same, and a review task's are
  // every item of the vision its plan revision was decomposed from. Absent on rows written before it.
  visionItems: z.array(z.string().min(1)).optional(),
  // The same items as `visionItems`, each with its id, status, standing with the client and kind
  // (ADR-074 addendum 2 d89): what a check task's checks are judged against, item by item, and for a
  // review task every item of the vision. Absent on rows written before it.
  sources: z.array(VisionSourceSchema).optional(),
  // A decomposed task's acceptance lines and its check task's, each with the ids of the items in
  // `sources` it serves (d89 A): the task's traced items are exactly the union of those. Absent on
  // rows written before it.
  acceptance: z.array(TracedLineSchema).optional(),
  // An environment-change task's: whether the project's product scaffold had completed when Z0
  // opened it (d72 S, B2). "absent" means its merge lands on a main with no product, so its
  // post-merge check runs the probe only; the product's build and test run on the scaffold's own
  // merge. Absent on rows written before it, which run the product's build and test, the stricter check.
  product: z.enum(["present", "absent"]).optional(),
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
