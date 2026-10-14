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
 * operator. An infrastructure fault is not the task's (story s-loop-never-stop-m1 W6): the task
 * goes back to Pending uncharged, within a fault budget, and this reason is written only on a task
 * given up because its faults went on after the project's infrastructure halt resumed (Abandoned),
 * or on a Blocked row written before migration 048.
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
 * never run on the BaseCell instead (s-platform-role-m1). `reason` names which. Nothing re-defines
 * or rebuilds main's environment while every environment task is done, so the task is given up
 * (Abandoned) and its plan repaired, which can plan a new environment (migration 048).
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
 * environment. No model was called. `reason` carries the red run. Written only when that check
 * task could not be reopened (it is not a Completed check task any more), on the task given up for
 * it (Abandoned), whose plan is then repaired; a reopenable one is reopened instead and the task
 * waits on it at Pending.
 */
const checksStaleSchema = z.object({
  source: z.literal("checks_stale"),
  checkTaskId: z.string().min(1),
  reason: z.string().min(1),
  ...augmentationFields,
});

/**
 * An implementation task's finished work changed environment recipe files, the platform role's,
 * and no environment task was opened for it (ADR-074 addendum 2 d66 b, d72 B1): the task already had the
 * bound of environment tasks opened for it, or none could be opened (no role of the roster does
 * environment work). The task is given up (Abandoned) and its plan repaired. Below the bound, the
 * environment task is opened and the task waits on it at Pending instead. `paths` names the recipe
 * files its branch changed; nothing was merged and the branch was deleted.
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
 * the check author cannot write checks that hold on it. The task is given up (Abandoned) and its
 * plan repaired; nothing reopens the check task again. `reason` carries the latest red run.
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
 * longer a Completed check task), or the dispute is past the bound of disputes per check task.
 * Written only then, on the task given up for it (Abandoned), whose plan is then repaired; a
 * reopenable check task within the bound is reopened instead and the task waits on it at Pending.
 * `reason` carries the dispute and why no reopen was made.
 */
const checkDisputedSchema = z.object({
  source: z.literal("check_disputed"),
  checkTaskId: z.string().min(1),
  checkName: z.string().min(1),
  reason: z.string().min(1),
  ...augmentationFields,
});

/**
 * The review of a plan revision's check suites (ADR-074 addendum 2 d71 c) found problems, and a
 * check task it named cannot be reopened to answer them (it is not a Completed check task deciding
 * one implementation task), or the review named one past the bound of reviews per check task.
 * Written only on the review task given up for it (Abandoned), whose plan is then repaired;
 * reopenable check tasks within the bound are reopened instead and the review waits on them at
 * Pending. `checkTaskIds` names every check task the review named; `reason` carries the problems
 * and why no reopen was made.
 */
const suiteReviewUnresolvedSchema = z.object({
  source: z.literal("suite_review_unresolved"),
  checkTaskIds: z.array(z.string().min(1)).min(1),
  reason: z.string().min(1),
  ...augmentationFields,
});

/**
 * The task cannot be staffed: it has no owner role, or its owner is not a role of the project's
 * latest roster (or that roster cannot be read). No agent ran, and no default role stands in for
 * the owner (s-team-roster-m1). `ownerRoleId` is the stored owner, null when there is none.
 * `rosterRevision` is the latest roster revision the decision was made against, null when the
 * project had none (or, written before migration 040, when it was not recorded). No production
 * path appends a roster revision after the first (db roster.ts recordFirstRoster), so the task is
 * given up (Abandoned) and its plan repaired, which staffs the new tasks from the latest roster.
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
 * Abandoned item, or a dependency cycle. The gate gives it up (Abandoned) instead of leaving it
 * Pending with nothing that would ever admit it, and its plan is repaired. `blockedBy` names the
 * root causes (the Abandoned items, or the task itself for a cycle); `reason` says so.
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
  /**
   * How the commit closed the task (migration 049): Z0's own merge, or main's commit its checks
   * passed on when it changed nothing. Absent on a row written before it: recorded as not known.
   */
  mergeKind: z.enum(["merged", "already_delivered"]).optional(),
  reason: z.string().min(1),
  ...augmentationFields,
});

/**
 * The task was open (not started, Blocked or Failed) when a revision of the plan replaced it: the
 * client changed what is built (migration 042), or a task was given up and the remaining work was
 * re-planned around it (a plan repair, migration 045). It is Abandoned and never dispatched. Written
 * only on Abandoned items. `planRevision` is the revision that replaced it; `requestedBy` the client
 * answer that asked for it, null for a plan repair, whose given-up tasks `repairOf` names.
 */
const supersededSchema = z.object({
  source: z.literal("superseded"),
  planRevision: z.number().int().min(2),
  requestedBy: z.string().min(1).nullable(),
  repairOf: z.array(z.string().min(1)).min(1).optional(),
  reason: z.string().min(1),
  ...augmentationFields,
});

/**
 * The acceptance sweep on main HEAD failed (story s-independent-verify-m1 W7, migration 049): once
 * every task of the plan was settled with a goal task done, Z0 ran the environment's test and the
 * latest checks of every completed implementation task on main, and they did not all pass. Written
 * on the defect item Z0 opens for that sweep, given up (Abandoned) at once, so the plan is repaired
 * around it; the project is never accepted on it. Also written when the sweep could not run for a
 * fault that is not the substrate's, within the fault budget (orchestrator acceptance.ts).
 * `mainCommit` is the commit the sweep ran on, null when it faulted before main could be read;
 * `reason` the run as its verdict states it, or the fault as recorded.
 */
const acceptanceFailedSchema = z.object({
  source: z.literal("acceptance_failed"),
  mainCommit: z.string().regex(/^([0-9a-f]{40}|[0-9a-f]{64})$/).nullable(),
  reason: z.string().min(1),
  ...augmentationFields,
});

/**
 * HTTP API (PATCH /work-items/:id/status): a Failed or Abandoned item an operator moved, or a
 * Blocked row written before migration 048 (the route no longer blocks a task). Passthrough
 * preserves caller-supplied fields — the user content is open-world.
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
  suiteReviewUnresolvedSchema,
  dependencyUnsatisfiableSchema,
  mergeUnrecordedSchema,
  supersededSchema,
  acceptanceFailedSchema,
  apiSchema,
]);

export type StoredBlockedReason = z.infer<typeof storedBlockedReasonSchema>;

/**
 * How a task's recorded commit closed it (migration 049): Z0's own merge, or main's commit at which
 * the task, having changed nothing, passed its checks and the regression suite (already delivered).
 */
export type MergeKind = "merged" | "already_delivered";

/**
 * Every `source` a stored blocked reason can carry. `satisfies` keeps each member a real source;
 * blocked-reason.test.ts checks the converse, that no source is missing. The block report reads a
 * given-up task's cause by it (db block-report.ts).
 */
export const BLOCKED_REASON_SOURCES = [
  "task_failed",
  "orchestrator_error",
  "replan",
  "failure_router",
  "environment_unavailable",
  "environment_undefined",
  "checks_stale",
  "environment_change_needed",
  "owner_unresolved",
  "checks_rewrite_bound",
  "check_disputed",
  "suite_review_unresolved",
  "dependency_unsatisfiable",
  "merge_unrecorded",
  "superseded",
  "acceptance_failed",
  "api",
] as const satisfies readonly StoredBlockedReason["source"][];

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
    case "suite_review_unresolved":
    case "dependency_unsatisfiable":
    case "merge_unrecorded":
    case "superseded":
    case "acceptance_failed":
    case "api":
      return { ...reason };
  }
  const _: never = reason;
  return _;
}

/**
 * How a Blocked work item leaves Blocked (Discipline B: every state has a way out, and no work item
 * waits on a person: story s-loop-never-stop-m1 W6, ADR-074 addendum 2 d76). Every exit is taken by
 * the loop itself, each cycle (orchestrator parked-exits.ts), and each has a production writer.
 * `merge-recorded`: to Completed (not Pending), once the record of `mergeCommit` is written; the
 * loop itself writes it again each cycle. `requeue`: back to Pending at once, uncharged: an
 * infrastructure fault is not the task's. `give-up`: the cause cannot clear by itself, so the task
 * is given up (Abandoned) and its plan repaired (migration 045, widened by 048).
 */
export type BlockedExit =
  | { readonly kind: "merge-recorded"; readonly mergeCommit: string; readonly mergeKind: MergeKind | null }
  | { readonly kind: "requeue" }
  | { readonly kind: "give-up" };

/**
 * The exit of a Blocked item's stored reason. Only merge_unrecorded is written on Blocked items
 * now; every other source on a Blocked row was written before migration 048 (or is no Blocked
 * reason at all: task_failed, orchestrator_error, replan, failure_router, superseded), as is a
 * Blocked item with no reason. None of those waits: an infrastructure fault is requeued, anything
 * else is given up.
 */
export function blockedExitOf(reason: StoredBlockedReason | undefined): BlockedExit {
  if (reason === undefined) return { kind: "give-up" };
  switch (reason.source) {
    case "merge_unrecorded":
      return { kind: "merge-recorded", mergeCommit: reason.mergeCommit, mergeKind: reason.mergeKind ?? null };
    case "environment_unavailable":
      return { kind: "requeue" };
    case "owner_unresolved":
    case "environment_undefined":
    case "checks_stale":
    case "environment_change_needed":
    case "checks_rewrite_bound":
    case "check_disputed":
    case "suite_review_unresolved":
    case "dependency_unsatisfiable":
    case "api":
    case "task_failed":
    case "orchestrator_error":
    case "replan":
    case "failure_router":
    case "superseded":
    case "acceptance_failed":
      return { kind: "give-up" };
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
