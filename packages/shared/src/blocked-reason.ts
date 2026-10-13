import { z } from "zod";

/**
 * Published Language: the persisted blockedReason payload on work items.
 * Discriminated on `source` — Ashara's own producers form a closed set;
 * a consumer switch that omits a variant is a compile error.
 *
 * Open-text fields (reason, detail) stay open strings — they carry
 * LLM-authored or human-authored content, not a closed vocabulary.
 */

// Shared optional fields, present on any variant regardless of which producer
// wrote the original.
// `salvagedOutcome/salvagedDetail/salvagedAt` — a result that returned for an
// Abandoned item, persisted so cascade-completion can see the work was done (or what the failure was) without reopening the terminal status.
const augmentationFields = {
  salvagedOutcome: z.enum(["completed", "failed", "blocked"]).optional(),
  salvagedDetail: z.string().optional(),
  salvagedAt: z.string().optional(),
};

/** PlanningService.route marks a task as failed (no recovery path). */
const taskFailedSchema = z.object({
  source: z.literal("task_failed"),
  reason: z.string(),
  ...augmentationFields,
});

/** Orchestrator fallback when lifecycle route itself throws. */
const orchestratorErrorSchema = z.object({
  source: z.literal("orchestrator_error"),
  reason: z.string(),
  ...augmentationFields,
});

/**
 * Failure-recovery replan path: context for the next attempt, set on a
 * Pending item AFTER replanWorkItem clears blockedReason, so the next
 * execution knows why the prior attempt failed.
 */
const replanSchema = z.object({
  source: z.literal("replan"),
  replanContext: z.object({
    attempt: z.number(),
    detail: z.string(),
    raw: z.unknown(),
  }),
  ...augmentationFields,
});

/** FailureRouter abandon decisions (failure-recovery.ts). */
const failureRouterSchema = z.object({
  source: z.literal("failure_router"),
  reason: z.string(),
  attempts: z.number().optional(),
  lastFailure: z.unknown().optional(),
  detail: z.string().optional(),
  ...augmentationFields,
});

/**
 * The execution substrate a task needs was not available: before the attempt
 * (no agent ran, nothing executed) or under it (a cell failed mid-attempt).
 * `unavailable` names what was missing (e.g. "container substrate (podman)",
 * "task cell"); `reason` carries the substrate's own diagnostic text for the
 * operator.
 */
const environmentUnavailableSchema = z.object({
  source: z.literal("environment_unavailable"),
  unavailable: z.string().min(1),
  reason: z.string().min(1),
  ...augmentationFields,
});

/**
 * The project has no environment a task's cells can be built from: none is defined on the
 * target's main, or the current version's image could not be built. No agent ran, and the task is
 * never run on the BaseCell instead (s-platform-role-m1). `reason` names which, for the operator.
 */
const environmentUndefinedSchema = z.object({
  source: z.literal("environment_undefined"),
  reason: z.string().min(1),
  ...augmentationFields,
});

/**
 * The checks stored for a task were red-run on another environment version than the dispatch's,
 * and no longer all fail on main there: they cannot decide the task's work. Not the task's
 * failure: the check task named by `checkTaskId` must write them again on the current
 * environment. No model was called. `reason` carries the red run, for the operator. Written only
 * when that check task could not be reopened (it is not a Completed check task any more); a
 * reopenable one is reopened instead and the task waits on it at Pending.
 */
const checksStaleSchema = z.object({
  source: z.literal("checks_stale"),
  checkTaskId: z.string().min(1),
  reason: z.string().min(1),
  ...augmentationFields,
});

/**
 * An implementation task's finished work changed files the environment owns, and nothing else it
 * was refused for: environment files belong to the platform role, so the work needs an environment
 * change no implementer may make (ADR-074 addendum 2 d63: in M1 such a task is Blocked, not
 * retried). `paths` names the environment-owned paths its branch changed; nothing was merged.
 */
const environmentChangeNeededSchema = z.object({
  source: z.literal("environment_change_needed"),
  paths: z.array(z.string().min(1)).min(1),
  reason: z.string().min(1),
  ...augmentationFields,
});

/**
 * The task's checks went stale again after its check task had already written them again
 * `bound` times (the stored checks are `revision`): the environment keeps moving under them, or
 * the check author cannot write checks that hold on it. Parked for the operator; nothing reopens
 * the check task again on its own. `reason` carries the latest red run.
 */
const checksRewriteBoundSchema = z.object({
  source: z.literal("checks_rewrite_bound"),
  checkTaskId: z.string().min(1),
  revision: z.number().int().min(1),
  bound: z.number().int().min(1),
  reason: z.string().min(1),
  ...augmentationFields,
});

/**
 * The task's implementer disputed one of its stored checks (dispute_check, ADR-074 addendum 2 d65
 * c), and the check task named by `checkTaskId` cannot be reopened to answer the dispute (it is no
 * longer a Completed check task). Written only then; a reopenable check task is reopened instead and
 * the task waits on it at Pending. `reason` carries the dispute and why no reopen was possible.
 */
const checkDisputedSchema = z.object({
  source: z.literal("check_disputed"),
  checkTaskId: z.string().min(1),
  checkName: z.string().min(1),
  reason: z.string().min(1),
  ...augmentationFields,
});

/**
 * The task cannot be staffed: it has no owner role, or its owner is not a role of the project's
 * latest roster (or that roster cannot be read). No agent ran, and no default role stands in for
 * the owner (s-team-roster-m1). `ownerRoleId` is the stored owner, null when there is none.
 * `rosterRevision` is the latest roster revision the decision was made against, null when the
 * project had none (or, written before migration 040, when it was not recorded): a newer
 * revision is this block's exit.
 */
const ownerUnresolvedSchema = z.object({
  source: z.literal("owner_unresolved"),
  ownerRoleId: z.string().min(1).nullable(),
  rosterRevision: z.number().int().min(1).nullable(),
  reason: z.string().min(1),
  ...augmentationFields,
});

/**
 * A Pending task depends, directly or transitively, on work that can never complete: an
 * Abandoned item, or a dependency cycle. The gate parks it here instead of leaving it Pending
 * with nothing that would ever admit it. `blockedBy` names the root causes (the Abandoned items,
 * or the task itself for a cycle); `reason` says so, for the operator.
 */
const dependencyUnsatisfiableSchema = z.object({
  source: z.literal("dependency_unsatisfiable"),
  blockedBy: z.array(z.string().min(1)).min(1),
  reason: z.string().min(1),
  ...augmentationFields,
});

/**
 * The task's work is merged on the target's main as `mergeCommit`, but the record of that merge
 * (work_items.merge_commit) could not be written, even after bounded retries. Never re-dispatched:
 * the work is done, and a new attempt would redo merged work. Its exit is automatic: the loop
 * writes the record again each cycle, and once it holds, the task is Completed. `reason` carries
 * the last write's error, for the operator.
 */
const mergeUnrecordedSchema = z.object({
  source: z.literal("merge_unrecorded"),
  mergeCommit: z.string().regex(/^([0-9a-f]{40}|[0-9a-f]{64})$/),
  reason: z.string().min(1),
  ...augmentationFields,
});

/**
 * The task was open (not started, Blocked or Failed) when the client changed what is built, and a
 * revision of the plan (migration 042) replaced it: it is Abandoned and never dispatched. Written
 * only on Abandoned items. `planRevision` is the revision that replaced it, `requestedBy` the
 * client answer that asked for it.
 */
const supersededSchema = z.object({
  source: z.literal("superseded"),
  planRevision: z.number().int().min(2),
  requestedBy: z.string().min(1),
  reason: z.string().min(1),
  ...augmentationFields,
});

/**
 * HTTP API (PATCH /work-items/:id/status). Passthrough preserves
 * caller-supplied fields — the user content is open-world.
 */
const apiSchema = z
  .object({
    source: z.literal("api"),
    ...augmentationFields,
  })
  .passthrough();

const storedBlockedReasonSchema = z.discriminatedUnion("source", [
  taskFailedSchema,
  orchestratorErrorSchema,
  replanSchema,
  failureRouterSchema,
  environmentUnavailableSchema,
  environmentUndefinedSchema,
  checksStaleSchema,
  environmentChangeNeededSchema,
  ownerUnresolvedSchema,
  checksRewriteBoundSchema,
  checkDisputedSchema,
  dependencyUnsatisfiableSchema,
  mergeUnrecordedSchema,
  supersededSchema,
  apiSchema,
]);

export type StoredBlockedReason = z.infer<typeof storedBlockedReasonSchema>;

/**
 * Typed failure for a blocked_reason jsonb value that is present but unreadable.
 */
export class BlockedReasonCorrupt extends Error {
  constructor(
    public readonly raw: unknown,
    public readonly detail: string,
  ) {
    super(`stored blocked_reason is not a valid object (${detail})`);
    this.name = "BlockedReasonCorrupt";
  }
}

/**
 * Augments any StoredBlockedReason variant with salvaged-result fields. Used by
 * the orchestrator when an agent returns a result for an item that was preempted
 * to Abandoned during execution. The result (outcome + detail) is persisted on
 * the existing blockedReason so cascade-completion can see it without reopening
 * the terminal status. The spread preserves the original variant's `source`
 * discriminator; the type assertion bridges TypeScript's inability to narrow
 * through object spread on discriminated unions.
 */
export function withSalvagedResult(
  reason: StoredBlockedReason,
  salvagedOutcome: "completed" | "failed" | "blocked",
  salvagedDetail: string,
): StoredBlockedReason {
  return {
    ...reason,
    salvagedOutcome,
    salvagedDetail,
    salvagedAt: new Date().toISOString(),
  } as StoredBlockedReason;
}

/**
 * Deliberately widens a typed StoredBlockedReason to Record<string, unknown>.
 * The original shape IS known (StoredBlockedReason), but RawFailureContext.raw
 * needs the wide form. The exhaustive
 * switch ensures a new `source` variant is a compile error HERE, not a silent
 * pass-through.
 */
export function blockedReasonToRecord(reason: StoredBlockedReason): Record<string, unknown> { // contract-erasing
  switch (reason.source) {
    case "task_failed":
    case "orchestrator_error":
    case "replan":
    case "failure_router":
    case "environment_unavailable":
    case "environment_undefined":
    case "checks_stale":
    case "environment_change_needed":
    case "owner_unresolved":
    case "checks_rewrite_bound":
    case "check_disputed":
    case "dependency_unsatisfiable":
    case "merge_unrecorded":
    case "superseded":
    case "api":
      return { ...reason };
  }
  const _: never = reason;
  return _;
}

/**
 * How a Blocked work item leaves Blocked (Discipline B: every state has a way out).
 * `roster-revision`: by itself, once the project stores a roster revision newer than the one the
 * block was decided against. `environment-built`: by itself, once the project's current
 * environment version (on the target's main) has a recorded statement and a succeeded build.
 * `merge-recorded`: by itself, to Completed (not Pending), once the record of `mergeCommit` is written.
 * `operator`: only an operator's unblock (PATCH /work-items/:id/status to Pending) moves it.
 */
export type BlockedExit =
  | { readonly kind: "roster-revision"; readonly decidedAgainst: number | null }
  | { readonly kind: "environment-built" }
  | { readonly kind: "merge-recorded"; readonly mergeCommit: string }
  | { readonly kind: "operator" };

/**
 * The exit of a Blocked item's stored reason. The sources written only on Failed, Abandoned or
 * Pending items (task_failed, orchestrator_error, replan, failure_router, superseded) and a Blocked item with
 * no reason have no cause that clears by itself: the operator decides.
 */
export function blockedExitOf(reason: StoredBlockedReason | undefined): BlockedExit {
  if (reason === undefined) return { kind: "operator" };
  switch (reason.source) {
    case "owner_unresolved":
      return { kind: "roster-revision", decidedAgainst: reason.rosterRevision };
    case "environment_undefined":
      return { kind: "environment-built" };
    case "merge_unrecorded":
      return { kind: "merge-recorded", mergeCommit: reason.mergeCommit };
    case "environment_unavailable":
    case "checks_stale":
    case "environment_change_needed":
    case "checks_rewrite_bound":
    case "check_disputed":
    case "dependency_unsatisfiable":
    case "api":
    case "task_failed":
    case "orchestrator_error":
    case "replan":
    case "failure_router":
    case "superseded":
      return { kind: "operator" };
  }
  const _: never = reason;
  return _;
}

export function parseStoredBlockedReason(raw: unknown): StoredBlockedReason | undefined {
  if (raw === null || raw === undefined) return undefined;
  const result = storedBlockedReasonSchema.safeParse(raw);
  if (!result.success) {
    throw new BlockedReasonCorrupt(
      raw,
      result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  }
  return result.data;
}
