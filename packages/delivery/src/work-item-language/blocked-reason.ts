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
 * Pending item by replanWorkItem, so the next execution knows why the prior
 * attempt failed.
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

/** A task given up after its failed attempts, by the FailureRouter's decision (Delivery's failure-recovery.ts). */
const failureGivenUpSchema = z.object({
  source: z.literal("failure_given_up"),
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
 * operator. An infrastructure fault is not the task's: the task
 * goes back to Pending uncharged, within a fault budget, and this reason is written only on a task
 * given up because its faults went on after the project's infrastructure halt resumed (Abandoned),
 * or on a legacy Blocked row.
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
 * never run on the BaseCell instead. `reason` names which. Nothing re-defines
 * or rebuilds main's environment while every environment task is done, so the task is given up
 * (Abandoned) and its plan repaired, which can plan a new environment.
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
 * and no environment task was opened for it: the task already had the
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
 * The task's implementer disputed one of its stored checks (dispute_check),
 * and the check task named by `checkTaskId` cannot be reopened to answer the dispute (it is no
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
 * The review of a plan revision's check suites found problems, and a
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
 * the owner. `ownerRoleId` is the stored owner, null when there is none.
 * `rosterRevision` is the latest roster revision the decision was made against, null when the
 * project had none (or, on a legacy row, when it was not recorded). No production
 * path appends a roster revision after the first (Organization's recordFirstRoster), so the task is
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
 * The task drew every model request its work budget holds (the work ledger):
 * Finance refused its next request before it was sent. No grant raises a task's budget, so the
 * task is given up (Abandoned), never requeued, and its plan repaired. `budgetRequests` is the
 * task's budget and `drawnRequests` the requests drawn against it when the request was refused;
 * `reason` carries the refusal, with the requests by call site.
 */
const workBudgetSpentSchema = z.object({
  source: z.literal("work_budget_spent"),
  budgetRequests: z.number().int().min(1),
  drawnRequests: z.number().int().min(0),
  reason: z.string().min(1),
  ...augmentationFields,
});

/**
 * A turn of the task's attempt did not fit its model's context window, and no catalog model graded
 * for the task has a larger one. The same window would be met on every re-dispatch, so the task is
 * given up (Abandoned) and its plan repaired, which can cut the work smaller. `provider` and `model`
 * name the model whose `windowTokens` it overflowed, with `outputReserveTokens` reserved in it for
 * the turn's output; `projectedInputTokens` is the turn's projected input when the gateway refused
 * it before sending, null when the provider rejected it (which states no count). `reason` carries
 * the full statement.
 */
const contextWindowExceededSchema = z.object({
  source: z.literal("context_window_exceeded"),
  provider: z.string().min(1),
  model: z.string().min(1),
  windowTokens: z.number().int().min(1),
  outputReserveTokens: z.number().int().min(0),
  projectedInputTokens: z.number().int().min(0).nullable(),
  reason: z.string().min(1),
  ...augmentationFields,
});

/**
 * An attempt of the task overflowed a context window of `overflowedWindowTokens`
 * (work_items.overflowed_window_tokens), and at its next dispatch no catalog model graded for it has
 * a larger one: the catalog changed since the overflow found one. Every re-dispatch meets the same
 * catalog, so the task is given up (Abandoned) before any model runs, and its plan repaired, which
 * can cut the work smaller. `reason` carries the full statement.
 */
const noWiderModelSchema = z.object({
  source: z.literal("no_wider_model"),
  overflowedWindowTokens: z.number().int().min(1),
  reason: z.string().min(1),
  ...augmentationFields,
});

/**
 * The task was InProgress at `boots` startups in a row, each time left by a process that died
 * while it ran, and `boots` reached the bound of re-dispatches after a crash (`bound`, the startup
 * reconciler's): its dispatch may be what kills the process, so the reconciler gives it up
 * (Abandoned) instead of requeueing it, and its plan is repaired. A dispatch that ends in the
 * process that started it sets the count back to 0. `reason` names the startups.
 */
const crashLoopSchema = z.object({
  source: z.literal("crash_loop"),
  boots: z.number().int().min(1),
  bound: z.number().int().min(1),
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
   * How the commit closed the task: Z0's own merge, or main's commit its checks
   * passed on when it changed nothing. Absent on a legacy row: recorded as not known.
   */
  mergeKind: z.enum(["merged", "already_delivered"]).optional(),
  reason: z.string().min(1),
  ...augmentationFields,
});

/**
 * A task a dead process left InProgress that the startup reconciler could not settle within its
 * bound: it could not read the target's main for the task's merge commit, or could not write the
 * requeue (or completion) it found. Ashara's own Z0 machinery failed (fault class `ashara`),
 * so nothing is charged to the task. Never requeued without main read: its work may be
 * merged. Its exit is automatic (orchestrator parked-exits.ts): each cycle the loop reads main
 * again, and the task is Completed with the merge it finds, or back to Pending when main holds
 * none. `step` names what failed, `reason` the last failure's chain.
 */
const orphanUnreconciledSchema = z.object({
  source: z.literal("orphan_unreconciled"),
  faultClass: z.literal("ashara"),
  step: z.string().min(1),
  reason: z.string().min(1),
  ...augmentationFields,
});

/**
 * The task cites a key a client's correction affects (vision `visionVersion`, correction_holds), and
 * is Pending while the correction awaits its plan revision, whatever it was when the correction was
 * recorded: it is held, never dispatched, while the rest of the project goes on (a citing task in
 * progress finishes its attempt and may merge, and is then merged work the revision keeps). `affected` names the affected keys it cites. Its exit is automatic: the
 * correction's plan revision, which the loop writes on its own (Replanner), supersedes it; the
 * revision's attempt and review bounds block the project, never the task, when it cannot be written.
 */
const correctionPendingSchema = z.object({
  source: z.literal("correction_pending"),
  visionVersion: z.number().int().min(2),
  affected: z.array(z.string().min(1)).min(1),
  reason: z.string().min(1),
  ...augmentationFields,
});

/**
 * The task was open (not started, Blocked or Failed) when a revision of the plan replaced it: the
 * client changed what is built, or a task was given up and the remaining work was
 * re-planned around it (a plan repair). It is Abandoned and never dispatched. Written
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
 * The acceptance sweep on main HEAD failed: once
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
 * The task's implementer finished blocked on work another task of the plan delivers, naming the
 * public interface entries it needs (`interfaceEntries`), and the task waits at Pending on the open
 * tasks that deliver them (`on`, each a dependency of it now), its dispatch given back: it is the
 * scheduler's to release, never the failure router's. `waits` counts the waits on an owner outside
 * the task in a row, this one included, and bounds them. Written on the Pending item; the next
 * dispatch carries it until another reason replaces it.
 */
const awaitingWorkSchema = z.object({
  source: z.literal("awaiting_work"),
  waits: z.number().int().min(1),
  interfaceEntries: z.array(z.string().min(1)).min(1),
  on: z.array(z.string().min(1)).min(1),
  reason: z.string().min(1),
  ...augmentationFields,
});

/**
 * The task's implementer finished blocked on a decision only the client can make: the task holds at
 * Blocked until the client's answer to its question is read, its dispatch given back. `questionId`
 * is the client message the question is posted as, chosen with the hold and posted after it, with
 * `question` and what stands until it is answered (`assumption`). Its exit is automatic (orchestrator
 * parked-exits.ts): the question is posted if it is not yet on record, an answer read sends it back
 * to Pending, and with no other work of the project left that could proceed the project halts on
 * client_wait until the answer comes. `waits` counts the waits on an owner outside the task in a
 * row, this one included.
 */
const awaitingClientSchema = z.object({
  source: z.literal("awaiting_client"),
  waits: z.number().int().min(1),
  questionId: z.string().min(1),
  question: z.string().min(1),
  assumption: z.string().min(1),
  reason: z.string().min(1),
  ...augmentationFields,
});

/**
 * The client answered the question an awaiting_client task held for (`questionId`): the task is
 * back at Pending and its next attempt reads the answer in the vision. `waits` carries the count of
 * waits on an owner outside the task, which the next one adds to.
 */
const clientAnsweredSchema = z.object({
  source: z.literal("client_answered"),
  waits: z.number().int().min(1),
  questionId: z.string().min(1),
  reason: z.string().min(1),
  ...augmentationFields,
});

/**
 * The task was blocked on an owner outside it, and the wait cannot end: `unplanned`, no open task of
 * the plan delivers the interface entries it needs (a gap in the plan); `bound`, it reached the
 * bound of waits in a row (`waits`); `unaskable`, the question could not be put to the client. The
 * task is given up (Abandoned) and its plan repaired: the attempt is never counted as failed.
 * `reason` carries the implementer's need and why the wait ends.
 */
const prerequisiteUnresolvedSchema = z.object({
  source: z.literal("prerequisite_unresolved"),
  why: z.enum(["unplanned", "bound", "unaskable"]),
  waits: z.number().int().min(0),
  reason: z.string().min(1),
  ...augmentationFields,
});

/**
 * HTTP API (PATCH /work-items/:id/status): a Failed or Abandoned item an operator moved, or a
 * legacy Blocked row (the route never blocks a task). Passthrough
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
  failureGivenUpSchema,
  environmentUnavailableSchema,
  environmentUndefinedSchema,
  checksStaleSchema,
  environmentChangeNeededSchema,
  ownerUnresolvedSchema,
  checksRewriteBoundSchema,
  checkDisputedSchema,
  suiteReviewUnresolvedSchema,
  workBudgetSpentSchema,
  contextWindowExceededSchema,
  noWiderModelSchema,
  crashLoopSchema,
  dependencyUnsatisfiableSchema,
  mergeUnrecordedSchema,
  orphanUnreconciledSchema,
  correctionPendingSchema,
  supersededSchema,
  acceptanceFailedSchema,
  awaitingWorkSchema,
  awaitingClientSchema,
  clientAnsweredSchema,
  prerequisiteUnresolvedSchema,
  apiSchema,
]);

export type StoredBlockedReason = z.infer<typeof storedBlockedReasonSchema>;

/** Why a work item is given up: any recorded cause but a plan revision's supersession, which supersedes the item instead. */
export type GivenUpReason = Exclude<StoredBlockedReason, { readonly source: "superseded" }>;

/**
 * How a task's recorded commit closed it: Z0's own merge, or main's commit at which
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
  "failure_given_up",
  "environment_unavailable",
  "environment_undefined",
  "checks_stale",
  "environment_change_needed",
  "owner_unresolved",
  "checks_rewrite_bound",
  "check_disputed",
  "suite_review_unresolved",
  "work_budget_spent",
  "context_window_exceeded",
  "no_wider_model",
  "crash_loop",
  "dependency_unsatisfiable",
  "merge_unrecorded",
  "orphan_unreconciled",
  "correction_pending",
  "superseded",
  "acceptance_failed",
  "awaiting_work",
  "awaiting_client",
  "client_answered",
  "prerequisite_unresolved",
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
    case "failure_given_up":
    case "environment_unavailable":
    case "environment_undefined":
    case "checks_stale":
    case "environment_change_needed":
    case "owner_unresolved":
    case "checks_rewrite_bound":
    case "check_disputed":
    case "suite_review_unresolved":
    case "work_budget_spent":
    case "context_window_exceeded":
    case "no_wider_model":
    case "crash_loop":
    case "dependency_unsatisfiable":
    case "merge_unrecorded":
    case "orphan_unreconciled":
    case "correction_pending":
    case "superseded":
    case "acceptance_failed":
    case "awaiting_work":
    case "awaiting_client":
    case "client_answered":
    case "prerequisite_unresolved":
    case "api":
      return { ...reason };
  }
  const _: never = reason;
  return _;
}

/**
 * How a Blocked work item leaves Blocked (Discipline B: every state has a way out, and no work item
 * waits on a person). Every exit is taken by
 * the loop itself, each cycle (orchestrator parked-exits.ts), and each has a production writer.
 * `merge-recorded`: to Completed (not Pending), once the record of `mergeCommit` is written; the
 * loop itself writes it again each cycle. `read-main`: main is read for the task's merge, then to
 * Completed with the merge found or to Pending when main holds none; main still unreadable stays
 * Blocked for the next cycle. `requeue`: back to Pending uncharged, an infrastructure fault is not
 * the task's, once main is read as `read-main` reads it. `await-revision`: it stays Blocked until the
 * plan revision the loop writes for the correction holding it supersedes it. `await-answer`: it stays
 * Blocked until the client's answer to its question is read (posted first if it is not yet on
 * record), then, once main is read as `read-main` reads it, back to Pending; its project halts on
 * client_wait while no other work of it could proceed. `give-up`: the cause cannot clear by itself, so the task is given up
 * (Abandoned) and its plan repaired.
 */
type BlockedExit =
  | { readonly kind: "merge-recorded"; readonly mergeCommit: string; readonly mergeKind: MergeKind | null }
  | { readonly kind: "read-main" }
  | { readonly kind: "requeue" }
  | { readonly kind: "await-revision" }
  | { readonly kind: "await-answer"; readonly held: Extract<StoredBlockedReason, { source: "awaiting_client" }> }
  | { readonly kind: "give-up" };

/**
 * The exit of a Blocked item's stored reason. Only merge_unrecorded, orphan_unreconciled,
 * correction_pending and awaiting_client are written on Blocked items; every other source on a Blocked row is a legacy row's (or is no Blocked
 * reason at all: task_failed, orchestrator_error, replan, failure_given_up, superseded), as is a
 * Blocked item with no reason. None of those waits: an infrastructure fault is requeued, anything
 * else is given up.
 */
export function blockedExitOf(reason: StoredBlockedReason | undefined): BlockedExit {
  if (reason === undefined) return { kind: "give-up" };
  switch (reason.source) {
    case "merge_unrecorded":
      return { kind: "merge-recorded", mergeCommit: reason.mergeCommit, mergeKind: reason.mergeKind ?? null };
    case "orphan_unreconciled":
      return { kind: "read-main" };
    case "environment_unavailable":
      return { kind: "requeue" };
    case "correction_pending":
      return { kind: "await-revision" };
    case "awaiting_client":
      return { kind: "await-answer", held: reason };
    case "owner_unresolved":
    case "environment_undefined":
    case "checks_stale":
    case "environment_change_needed":
    case "checks_rewrite_bound":
    case "check_disputed":
    case "suite_review_unresolved":
    case "work_budget_spent":
    case "context_window_exceeded":
    case "no_wider_model":
    case "crash_loop":
    case "dependency_unsatisfiable":
    case "api":
    case "task_failed":
    case "orchestrator_error":
    case "replan":
    case "failure_given_up":
    case "superseded":
    case "acceptance_failed":
    case "awaiting_work":
    case "client_answered":
    case "prerequisite_unresolved":
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
