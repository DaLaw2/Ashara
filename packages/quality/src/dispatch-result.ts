import { z } from "zod";
import type { Cell, CellExecInterrupted, CellSpec, CurrentEnvironment, SubstrateInfo, WorkdirInfo } from "@ashara/execution-infra";
import { WorktreeCommitFailed, cellExecInterruptedOf } from "@ashara/execution-infra";
import type { PreCallRefusal } from "@ashara/finance";
import type { ErrorLayer, Logger, ProjectId, WorkItemId } from "@ashara/shared";
import type { ErrorEnvelope } from "@ashara/workplace";
import { wrapError } from "@ashara/shared";
import { outcomeRecord } from "@ashara/workplace";
import type { Outcome } from "@ashara/workplace";
import type { StoredTaskSpec } from "./acl/delivery-acl.js";
import type { EnvironmentDefinition } from "./environment-definition.js";
import { DispatchFault, environmentErrorOf, thrownFaultOf, unavailableOf, VerificationInfrastructureFault } from "./fault-class.js";
import type { EnvironmentError, FaultClass } from "./fault-class.js";
import type { CheckFoundation, CheckRecorder, CitedItemIds, SuiteReviewProblem, TaskChecks } from "./task-checks.js";
import { WORK_FAILED } from "./task-verdict.js";
import type { FailureVerdict } from "./task-verdict.js";

// The result of a dispatch as Quality decides it: every status the dispatcher routes,
// what a completed task delivered, and the blocks a substrate or Z0 failure ends a dispatch with.
// Delivery owns the dispatch itself; the task and the dispatch are read here only structurally.

/** The task a dispatch works, as verification reads it. */
export interface VerifiedTask {
  readonly id: WorkItemId;
  /** work_items.project_id: every LLM call made for this task is charged to it. */
  readonly projectId: ProjectId;
  /** This dispatch's ordinal (DispatchRef.attempt). */
  readonly attempt: number;
  readonly taskSpec?: StoredTaskSpec;
}

/** One dispatch once its worktree exists, as verification reads it. */
export interface VerifiedDispatch {
  readonly task: VerifiedTask;
  readonly targetProjectPath: string;
  readonly workDir: string;
  /** The worktree's git dir, resolved before the cell existed; never re-read from the work tree. */
  readonly repo: WorkdirInfo["repo"];
  readonly sessionId: string;
  /** What the task cell, the red-run and gate cells and the post-merge verifier cell are started from. */
  readonly environment: DispatchEnvironment;
}

/**
 * The stage of a dispatch whose substrate or Z0 machinery failed: the probe, the environment, the
 * work plan, the staffing, the worktree, the resumed branch and the task cell before the attempt,
 * the attempt itself, the substrate gate, the red run of a check task's checks on main, and the
 * post-merge verifier cell; postMergeCheckRun, where Z0's own machinery around the merge and its
 * check (the merge itself, a worktree, the tentative merge's commit, a check file, the dirty-tree
 * check) failed and no verdict was reached; and runExecution, a throw out of the dispatch past the
 * cell's creation that no stage caught.
 */
type EnvironmentStage =
  | "probeSubstrate"
  | "resolveEnvironment"
  | "planWork"
  | "buildBrief"
  | "assignAgent"
  | "createWorkdir"
  | "resumeBranch"
  | "prepareConflictRetry"
  | "runExecution"
  | "createCell"
  | "agentAttempt"
  | "commitWork"
  | "branchWork"
  | "substrateGate"
  | "checkRedRun"
  | "deliveredCheckRun"
  | "ownershipGate"
  | "conflictResolution"
  | "postMergeVerify"
  | "postMergeCheckRun"
  | "reviewSuites";

/**
 * What became of the agent's work when a dispatch ended without done: no agent ran; it is
 * committed on the task branch for the next dispatch; for a check task, discarded (nothing of a
 * check task is kept, its next attempt starts again from main); for an attempt handed a conflict
 * with main, its unfinished merge is discarded with the worktree; git refused the partial commit
 * and the work is lost with the worktree; or not known, when Z0 itself failed mid-dispatch.
 */
export type AgentWork = "none" | "kept" | "discarded" | "merge-discarded" | "unknown" | { readonly lost: string };

export interface AgentPart {
  readonly outcome: Outcome | null;
  readonly agentWork: AgentWork;
}

export const NO_AGENT: AgentPart = { outcome: null, agentWork: "none" };

export function describeAgentWork(work: AgentWork): string {
  if (typeof work === "object") {
    return `the agent's uncommitted work could not be committed (${work.lost}) and is discarded with the worktree; the task branch is as it was`;
  }
  switch (work) {
    case "none":
      return "no agent ran and nothing executed";
    case "kept":
      return "the agent's work is kept on the task branch";
    case "discarded":
      return "the check task's partial work is discarded; its next attempt starts again from main";
    case "merge-discarded":
      return "the attempt's merge of main is discarded uncommitted; the task branch is as it was and its next attempt merges main again";
    case "unknown":
      return "what became of the attempt's work is not known: Z0 failed mid-dispatch, and the task branch is as Z0's last step left it";
  }
}

/** The dispatch a result or event belongs to: its task and the item's real dispatch ordinal. */
export interface DispatchRef {
  readonly id: WorkItemId;
  readonly attempt: number;
}

interface EnvironmentBlock extends AgentPart {
  readonly task: DispatchRef;
  readonly sessionId: string;
  readonly stage: EnvironmentStage;
  /** Whose failure it is: never the agent's work (fault-class.ts). */
  readonly fault: Exclude<FaultClass, "agent_work">;
  /** The failure's class name, e.g. MountPathRejected; the reason names it. */
  readonly errorClass: string;
  readonly message: string;
  readonly chain: ErrorLayer;
  readonly unavailable: string;
}

/**
 * The substrate cannot host a stage of the task (podman missing or not answering, a cell that
 * cannot start or be mounted, an exec the substrate could not run), or Ashara's own Z0 machinery
 * failed under it (a store, git on the host, a bug): Blocked under its fault class with the stage
 * and error class named, never a host fallback, never a failure for the classifier and never a
 * lesson, at every stage.
 */
export function environmentBlocked(block: EnvironmentBlock, eventSink: ExecutionEventSink | undefined, logger: Logger): ExecutionResult {
  const { task, stage, errorClass } = block;
  const taskId = task.id;
  const kept = describeAgentWork(block.agentWork);
  const failed = block.fault === "substrate" ? "environment failed" : block.fault === "provider" ? "the model provider failed" : "Ashara's own machinery failed";
  const envelope: ErrorEnvelope = {
    outcome: "blocked",
    summary: `${failed} at stage ${stage} (${errorClass}): ${block.message}; task ${taskId} blocked, ${kept}`,
    chain: block.chain,
    ...(block.outcome !== null ? { agentOutput: outcomeRecord(block.outcome) } : {}),
  };
  logger.error("quality.task-blocked", envelope.summary, {
    taskId,
    attempt: task.attempt,
    stage,
    fault: block.fault,
    errorClass,
    unavailable: block.unavailable,
  }, block.chain);
  eventSink?.emit({ event: "task_blocked", taskId, attempt: task.attempt, stage, errorClass, reason: envelope.summary });
  return {
    status: "environment_blocked",
    fault: block.fault,
    unavailable: block.unavailable,
    detail: envelope.summary,
    outcome: block.outcome,
    sessionId: block.sessionId,
    attempt: task.attempt,
    errorEnvelope: envelope,
  };
}

/** The stage a dispatch stopped at, what its agent left, and who is told: what every blocked or interrupted result is built from. */
interface StoppedAt {
  readonly task: DispatchRef;
  readonly sessionId: string;
  readonly stage: EnvironmentStage;
  readonly agent: AgentPart;
  readonly eventSink: ExecutionEventSink | undefined;
  readonly logger: Logger;
}

/**
 * A stage the shutdown stopped by interrupting a command in a cell: no verdict was reached, so the
 * dispatch is neither failed nor blocked but interrupted (InterruptedResult), its item requeued
 * with its dispatch refunded.
 */
function interruptedInCell({ task, sessionId, stage, agent, eventSink, logger }: StoppedAt, interrupted: CellExecInterrupted): ExecutionResult {
  const turns = agent.outcome === null ? 0 : agent.outcome.turnsUsed;
  const summary = `stage ${stage} of task ${task.id} interrupted by shutdown in a cell: ${interrupted.message}; ${describeAgentWork(agent.agentWork)}`;
  logger.info("quality.stage-interrupted", summary, { taskId: task.id, attempt: task.attempt, stage, cellId: interrupted.cellId });
  eventSink?.emit({ event: "task_interrupted", taskId: task.id, attempt: task.attempt, turns });
  return {
    status: "interrupted",
    detail: summary,
    outcome: agent.outcome,
    sessionId,
    attempt: task.attempt,
    errorEnvelope: {
      outcome: "blocked",
      summary,
      chain: wrapError("development", stage, interrupted, { taskId: task.id, cellId: interrupted.cellId }),
      ...(agent.outcome !== null ? { agentOutput: outcomeRecord(agent.outcome) } : {}),
    },
  };
}

/** An environment block for a typed substrate error raised at `stage`. */
export function substrateBlocked(
  blocked: StoppedAt & { readonly error: EnvironmentError; readonly cell: string; readonly chain?: ErrorLayer },
): ExecutionResult {
  const { task, sessionId, stage, error: e, cell, agent, eventSink, logger, chain } = blocked;
  const unavailable = unavailableOf(e, cell);
  return environmentBlocked(
    {
      task,
      sessionId,
      stage,
      fault: "substrate",
      errorClass: e.name,
      message: e.message,
      chain: chain ?? wrapError("development", stage, e, { taskId: task.id, unavailable, errorClass: e.name }),
      unavailable,
      ...agent,
    },
    eventSink,
    logger,
  );
}

/** What of Ashara's own machinery failed, named for the operator. */
function asharaUnavailableOf(fault: VerificationInfrastructureFault | DispatchFault): string {
  if (fault.cause instanceof WorktreeCommitFailed) return `host git (${fault.cause.step} of the task worktree)`;
  if (fault instanceof VerificationInfrastructureFault) return `verification infrastructure (${fault.step})`;
  return `Ashara's own machinery (${fault.step})`;
}

/** A block of class `ashara`: Z0's own machinery failed at `stage`. */
export function asharaBlocked(
  blocked: StoppedAt & { readonly fault: VerificationInfrastructureFault | DispatchFault; readonly chain?: ErrorLayer },
): ExecutionResult {
  const { task, sessionId, stage, fault, agent, eventSink, logger, chain } = blocked;
  const interrupted = cellExecInterruptedOf(fault);
  if (interrupted !== null) return interruptedInCell(blocked, interrupted);
  const unavailable = asharaUnavailableOf(fault);
  return environmentBlocked(
    {
      task,
      sessionId,
      stage,
      fault: "ashara",
      errorClass: fault.name,
      message: fault.message,
      chain: chain ?? wrapError("development", stage, fault, { taskId: task.id, unavailable, errorClass: fault.name }),
      unavailable,
      ...agent,
    },
    eventSink,
    logger,
  );
}

/**
 * A throw out of a stage of a dispatch, blocked under its class (fault-class.ts): the substrate's,
 * with `cell` named, when its class says so; otherwise Ashara's, as a DispatchFault at `step`. A
 * throw is never the agent's work, so it is never failed against the task nor taught as a lesson.
 */
export function thrownBlocked(
  blocked: StoppedAt & { readonly error: unknown; readonly where: { readonly step: string; readonly cell: string } },
): ExecutionResult {
  const { error: e, where, ...at } = blocked;
  const interrupted = cellExecInterruptedOf(e);
  if (interrupted !== null) return interruptedInCell(at, interrupted);
  const fault = thrownFaultOf(e);
  if (fault.class === "substrate") return substrateBlocked({ ...at, error: fault.error, cell: where.cell });
  const asharaFault =
    fault.error instanceof VerificationInfrastructureFault || fault.error instanceof DispatchFault
      ? fault.error
      : new DispatchFault(at.task.id, where.step, { cause: fault.error });
  return asharaBlocked({ ...at, fault: asharaFault });
}

/**
 * A run of checks on main that threw before any verdict (a check task's red run, or an
 * implementation's checks run on main when it changed nothing): a substrate failure blocks under
 * `stage` with the cell named; anything else is Z0's own machinery (main's commit, the
 * checkout's worktree or directory) and blocks as a VerificationInfrastructureFault at `step`.
 * Neither says anything about the checks or the task, so neither is ever a failure to route.
 */
export function mainRunBlocked(
  blocked: StoppedAt & { readonly stage: Extract<EnvironmentStage, "checkRedRun" | "deliveredCheckRun">; readonly error: unknown; readonly step: string },
): ExecutionResult {
  const { error: e, step, ...at } = blocked;
  const interrupted = cellExecInterruptedOf(e);
  if (interrupted !== null) return interruptedInCell(at, interrupted);
  const environmentFailure = environmentErrorOf(e);
  if (environmentFailure !== null) return substrateBlocked({ ...at, error: environmentFailure, cell: "CI cell" });
  return asharaBlocked({ ...at, fault: new VerificationInfrastructureFault(at.task.id, step, { cause: e }) });
}

/**
 * A task decided by stored checks, or the product scaffold, reached its ownership gate or its
 * post-merge run without an environment: no recipe to hold its branch to, no test to run on its merge.
 */
export class PostMergeEnvironmentMissing extends Error {
  constructor(readonly taskId: string) {
    super(`task ${taskId} is decided by stored checks but was dispatched on the BaseCell: no environment exists to check its work against`);
    this.name = "PostMergeEnvironmentMissing";
  }
}

export function failedBeforeAgent(task: DispatchRef, sessionId: string, operation: string, e: unknown, summary: string): ExecutionResult {
  const chain = wrapError("development", operation, e, { taskId: task.id });
  const envelope: ErrorEnvelope = { outcome: "failed", summary: `${summary}: ${chain.message}`, chain };
  return {
    status: "failed",
    detail: envelope.summary,
    verdict: WORK_FAILED,
    outcome: null,
    sessionId,
    attempt: task.attempt,
    errorEnvelope: envelope,
  };
}

/**
 * What a dispatch's cells are started from: the BaseCell only for the Sprint 0 task, whose work is
 * defining the environment; the current environment version's image for every other task.
 */
export type DispatchEnvironment =
  | { readonly kind: "base-cell"; readonly image: string; readonly digest: string }
  | ({ readonly kind: "environment" } & CurrentEnvironment<EnvironmentDefinition>);

export function cellImageOf(environment: DispatchEnvironment): string {
  return environment.kind === "base-cell" ? environment.image : environment.imageId;
}

/** A check task's plan once its throwaway worktree exists. */
export interface CheckAuthoring {
  readonly kind: "check-authoring";
  readonly checkedTaskId: string;
  readonly environment: CurrentEnvironment<EnvironmentDefinition>;
  /** The checked task's latest stored revision, when its checks are being written again. */
  readonly prior: TaskChecks | null;
  /** The plan revision's foundation every authoring of these checks is red-run on: the merged task and its recorded merge commit. */
  readonly foundation: Omit<Extract<CheckFoundation, { readonly kind: "found" }>, "kind">;
  /** The ids of the vision items the check task cites: each must be decided by one of its checks. */
  readonly citedItems: CitedItemIds;
  readonly branch: string;
  /** The main commit the worktree started from: the attempt's files are its diff against it. */
  readonly startCommit: string;
  readonly recorder: CheckRecorder;
}

/** The version recorded on the dispatch's dev_sessions row; null when its cells ran on the BaseCell. */
export function sessionEnvironmentVersion(environment: DispatchEnvironment): string | null {
  return environment.kind === "environment" ? environment.version : null;
}

/** Every execution event that belongs to one attempt of a task: its line names the task and the attempt. */
export const AttemptEventNameSchema = z.enum([
  "agent_completed",
  "agent_launched",
  "branch_work_found",
  "cell_created",
  "cell_teardown_failed",
  "check_defined",
  "check_disputed",
  "check_files_discarded",
  "check_red_run",
  "check_run_product_changed",
  "checks_revalidated",
  "context_exceeded",
  "delivered_on_main_verify",
  "delivered_sweep",
  "environment_change_requested",
  "environment_rebuilt",
  "environment_resolved",
  "error",
  "foundation_build",
  "foundation_probed",
  "gate_failed",
  "merge_conflict_presented",
  "merge_conflict_resolution",
  "ownership_gate",
  "post_merge_verify",
  "substrate_gate_result",
  "substrate_gate_started",
  "suite_review_problems",
  "suites_reviewed",
  "task_blocked",
  "task_checks_recorded",
  "task_checks_run",
  "task_completed",
  "task_failed",
  "task_interrupted",
  "task_refused",
  "task_started",
]);

/** Every execution event a project's acceptance sweep emits: it runs for the project, in no task's attempt. */
export const ProjectEventNameSchema = z.enum(["acceptance_sweep", "cell_teardown_failed"]);

/** A value JSON.stringify writes as itself: no Date, function, bigint or undefined element is one. */
type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue | undefined };

/** An event's own fields; an undefined one is dropped by JSON.stringify, as an absent one would be. */
type EventFields = { readonly [key: string]: JsonValue | undefined };

/** Whose event a line is: one attempt of a task, or a project when no attempt is involved. */
export type EventSubject =
  | { readonly taskId: string; readonly attempt: number }
  | { readonly projectId: string };

type ExecutionEvent =
  | (EventFields & { readonly event: z.infer<typeof AttemptEventNameSchema>; readonly taskId: string; readonly attempt: number })
  | (EventFields & { readonly event: z.infer<typeof ProjectEventNameSchema>; readonly projectId: string });

export interface ExecutionEventSink {
  // The name is closed and says whether the event belongs to an attempt; every field is a JSON
  // value, so a value the writer would have to refuse is a compile error at the emit site.
  emit(event: ExecutionEvent): void;
}

/** What execution needs of the container substrate; execution-infra's PodmanSubstrate satisfies it. */
interface CellSubstrate {
  probeSubstrate(): Promise<SubstrateInfo>;
  createCell(spec: CellSpec): Promise<Cell>;
}

/** The cells verification runs checks in. */
export interface VerificationCells {
  readonly substrate: CellSubstrate;
  /** The ashara.instance label of every cell this process creates; reconcileOrphans selects on it. */
  readonly instance: string;
  /** The process's shutdown: every command run in one of these cells is interrupted by it (CellExecInterrupted). */
  readonly shutdownSignal: AbortSignal;
}

// ---------------------------------------------------------------------------
// Execution result
// ---------------------------------------------------------------------------

/**
 * The outcome of a dispatch the execution substrate could not host, or Ashara's own Z0 machinery
 * failed under: the substrate was unavailable before the attempt (no agent ran, nothing
 * executed), a cell failed under a running attempt (environment_failure), the substrate gate, a
 * check task's red run or the post-merge verifier cell could not run, or a store, git on the host
 * or Z0's own code failed at any stage.
 * It is not a task failure (re-dispatching cannot make the substrate appear),
 * so Delivery requeues the item uncharged within its infrastructure fault
 * budget (past it the project halts under the fault's class, and a task whose faults outlast
 * the halt is given up with an `environment_unavailable` reason) instead of routing it
 * through the FailureRouter.
 */
interface EnvironmentBlockedResult {
  readonly status: "environment_blocked";
  /**
   * Whose failure it is (fault-class.ts): the substrate's (the project halts on infrastructure past
   * the budget, until the substrate probe passes) or Ashara's own Z0 machinery (the project halts
   * for the operator past the budget, the report naming Ashara). Never the agent's work.
   */
  readonly fault: Exclude<FaultClass, "agent_work">;
  /** What was unavailable, named for the operator (e.g. "container substrate (podman)"). */
  readonly unavailable: string;
  readonly detail: string;
  /** null when no agent ran; the attempt's Outcome when a cell failed under it. */
  readonly outcome: Outcome | null;
  readonly sessionId: string;
  readonly attempt: number;
  readonly errorEnvelope: ErrorEnvelope;
}

/**
 * The project has no environment the task's cells could be built from (none defined on the
 * target's main, its image could not be built, or no statement of it is on record). Nothing ran;
 * Delivery gives the item up with an `environment_undefined` reason, for a plan repair.
 */
interface EnvironmentUndefinedResult {
  readonly status: "environment_undefined";
  readonly reason: string;
  readonly detail: string;
  readonly outcome: null;
  readonly sessionId: string;
  readonly attempt: number;
  readonly errorEnvelope: ErrorEnvelope;
}

/**
 * A turn's model call was refused before it was sent (Finance's spend cap or price list), so the
 * attempt stopped there. Not a task failure and never a lesson, whatever refused it: a spend cap,
 * or a configuration fault (an unpriced model, a call whose cost cannot be estimated).
 * Delivery returns the item to Pending without consuming its dispatch and, for a
 * configuration fault, blocks the project with the refusal's class; no failure router either way.
 * The agent's partial work is committed on the task branch for the next dispatch, except a check
 * task's, which is discarded (its next attempt starts from main); `detail` says which.
 */
interface RefusedResult {
  readonly status: "refused";
  readonly refusal: PreCallRefusal;
  readonly detail: string;
  /** null for a review of a plan's suites, whose one structured call ran without an agent. */
  readonly outcome: Outcome | null;
  readonly sessionId: string;
  readonly attempt: number;
  readonly errorEnvelope: ErrorEnvelope;
}

/**
 * The process's shutdown signal cancelled the attempt mid-flight, or the model call of a review of
 * a plan's suites. Not a task failure and not a
 * lesson: the work was stopped, not tried and found wanting. Delivery returns the item to
 * Pending and refunds the dispatch; the partial work is committed on the task branch, or for a
 * check task discarded, and `detail` says which. A wall-clock
 * exhaustion is not this: it is the attempt's own limit and stays a failure.
 */
interface InterruptedResult {
  readonly status: "interrupted";
  readonly detail: string;
  /** null for a review of a plan's suites, whose one structured call ran without an agent. */
  readonly outcome: Outcome | null;
  readonly sessionId: string;
  readonly attempt: number;
  readonly errorEnvelope: ErrorEnvelope;
}

/**
 * A turn of the attempt did not fit its model's context window (the attempt's
 * `context_budget_exceeded`): the gateway's projection exceeded the window less the output reserve,
 * or the provider rejected the request as longer than it. Deterministic, so the same model would
 * overflow again. Not the task's failure and no lesson: Delivery dispatches the task next
 * on `wider`, a catalog model whose window is larger, or, with none, gives it up naming the window
 * and the estimate; never through the FailureRouter, whose replan would run the same model into the
 * same window (reaching a bound escalates). The partial work is committed on the task branch for the next dispatch,
 * or for a check task discarded, and `detail` says which.
 */
interface ContextExceededResult {
  readonly status: "context_exceeded";
  /** The model whose window the turn did not fit. */
  readonly model: { readonly provider: string; readonly modelId: string };
  /** That model's catalogued window. */
  readonly windowTokens: number;
  /** The output the turn reserved in it. */
  readonly outputReserveTokens: number;
  /** The turn's projected input when the preflight refused it; null when the provider rejected it, which states no count. */
  readonly projectedInputTokens: number | null;
  /** The provider's own wording when it rejected the turn; null when the preflight refused it. */
  readonly providerMessage: string | null;
  /** A catalog model, for the task's next dispatch, whose window is larger than `windowTokens`; null when there is none. */
  readonly wider: { readonly provider: string; readonly modelId: string; readonly windowTokens: number } | null;
  readonly detail: string;
  readonly outcome: Outcome;
  readonly sessionId: string;
  readonly attempt: number;
  readonly errorEnvelope: ErrorEnvelope;
}

/**
 * The task's stored checks were red-run on another environment version and on the dispatch's no
 * longer all fail on main, nor all pass there (that is work already delivered): they cannot
 * decide its work. Not the implementer's failure (no model ran)
 * and no lesson: Delivery reopens the check task that must write them again and the item
 * waits on it (Delivery's exitStaleChecks, bounded by `revision`), never routes it through the
 * FailureRouter, whose replan would meet the same checks.
 */
interface ChecksStaleResult {
  readonly status: "checks_stale";
  readonly checkTaskId: string;
  /** The stale revision of the task's checks: how many times they were written. */
  readonly revision: number;
  readonly detail: string;
  readonly outcome: null;
  readonly sessionId: string;
  readonly attempt: number;
  readonly errorEnvelope: ErrorEnvelope;
}

/**
 * The implementer disputed one of the task's stored checks with dispute_check: it holds that the check cannot pass on correct work. Not the task's failure and no
 * lesson: Delivery reopens the check task that wrote it, with the dispute in its brief, and
 * the item waits on it (bounded per check task), never routing it through the FailureRouter. The
 * partial work is committed on the task branch for the next dispatch.
 */
interface DisputedResult {
  readonly status: "disputed";
  /**
   * The task whose stored checks hold the disputed check: the dispatched task itself, or a task
   * already merged whose check blocks its merge.
   */
  readonly checksOf: string;
  /** The check task that wrote the disputed check: the one to reopen. */
  readonly checkTaskId: string;
  /** The revision of the task's checks the disputed check belongs to. */
  readonly revision: number;
  /** The disputed check as stored. */
  readonly check: { readonly name: string; readonly command: string };
  readonly reason: string;
  /** The output of the attempt's last run_checks; null when it never ran them. */
  readonly evidence: string | null;
  readonly detail: string;
  readonly outcome: Outcome;
  readonly sessionId: string;
  readonly attempt: number;
  readonly errorEnvelope: ErrorEnvelope;
}

/**
 * The implementer's finished work changed recipe files and nothing else the ownership gate
 * refuses: it needs an environment change, which only the platform role makes.
 * Nothing was merged, and the task branch is deleted, so the task's next
 * dispatch starts a fresh branch from main once the environment has changed. Not the task's
 * failure and no lesson: Delivery opens an environment task carrying `need` and `diff`
 * and the item waits on it (bounded per implementation task), never routing it through the
 * FailureRouter.
 */
interface EnvironmentChangeRequestedResult {
  readonly status: "environment_change_requested";
  /** The recipe files the branch changed. */
  readonly paths: readonly string[];
  /** The implementer's own statement of what it needs: its finish summary. */
  readonly need: string;
  /** The branch's diff of those files against where it left main; a cut is marked. */
  readonly diff: string;
  readonly detail: string;
  readonly outcome: Outcome;
  readonly sessionId: string;
  readonly attempt: number;
  readonly errorEnvelope: ErrorEnvelope;
}

/**
 * The task has no owner role, or its owner is not in the project's latest roster. Nothing ran;
 * Delivery gives the item up with an `owner_unresolved` reason, for a plan repair.
 */
interface OwnerUnresolvedResult {
  readonly status: "owner_unresolved";
  readonly ownerRoleId: string | null;
  /** The roster revision the decision was made against, recorded as evidence; null when the project has none. */
  readonly rosterRevision: number | null;
  readonly reason: string;
  readonly detail: string;
  readonly outcome: null;
  readonly sessionId: string;
  readonly attempt: number;
  readonly errorEnvelope: ErrorEnvelope;
}

/**
 * An attempt of the task overflowed a context window of `overflowedWindowTokens`, and no catalog
 * model graded for it has a larger one when it is dispatched again (the catalog changed since the
 * overflow found one). Nothing ran; Delivery gives the item up with a `no_wider_model`
 * reason, for a plan repair that can cut the work smaller.
 */
interface NoWiderModelResult {
  readonly status: "no_wider_model";
  readonly overflowedWindowTokens: number;
  readonly detail: string;
  readonly outcome: null;
  readonly sessionId: string;
  readonly attempt: number;
  readonly errorEnvelope: ErrorEnvelope;
}

/**
 * The review of a plan revision's suites found problems: checks no
 * product can pass together, or checks of behaviour no vision item asks for. Its schema validated
 * and every check task it names is one whose suite it read. Not the review's failure and no lesson:
 * Delivery records the findings, reopens each named check task with them (bounded per check
 * task) and returns the review to Pending to read the new suites, never routing it through the
 * FailureRouter.
 */
interface SuiteReviewProblemsResult {
  readonly status: "suite_review_problems";
  readonly problems: readonly SuiteReviewProblem[];
  readonly detail: string;
  readonly outcome: null;
  readonly sessionId: string;
  readonly attempt: number;
  readonly errorEnvelope: ErrorEnvelope;
}

/**
 * The implementer finished blocked on work another task of the plan delivers, naming the public
 * interface entries it needs. Not the task's failure and no lesson: Delivery makes the item
 * wait on the open tasks that deliver those entries, its dispatch given back, never routing it
 * through the FailureRouter; with no such task the need is a gap in the plan, which is repaired.
 * The partial work is committed on the task branch for the next dispatch.
 */
interface PrerequisiteNeededResult {
  readonly status: "prerequisite_needed";
  /** The public interface entries the implementer named, each resolved to its key in `interfaceTable`. */
  readonly interfaceEntries: readonly [string, ...string[]];
  /** The public interface as the implementer's brief showed it, each entry by key: what the names were resolved against. */
  readonly interfaceTable: ReadonlyArray<{ readonly key: string; readonly text: string }>;
  /** The implementer's own statement of what is missing. */
  readonly reason: string;
  readonly detail: string;
  readonly outcome: Outcome;
  readonly sessionId: string;
  readonly attempt: number;
  readonly errorEnvelope: ErrorEnvelope;
}

/**
 * The implementer finished blocked on a decision only the client can make (a contradiction in the
 * tender, a choice it leaves open). Not the task's failure and no lesson: Delivery sends the
 * question to the client and the item holds until it is answered, its dispatch given back, never
 * routing it through the FailureRouter.
 */
interface ClientDecisionNeededResult {
  readonly status: "client_decision_needed";
  /** The question as the implementer wrote it for the client. */
  readonly question: string;
  /** What the tender and the vision say now, which stands until the client answers. */
  readonly assumption: string;
  /** The implementer's own statement of what is missing. */
  readonly reason: string;
  readonly detail: string;
  readonly outcome: Outcome;
  readonly sessionId: string;
  readonly attempt: number;
  readonly errorEnvelope: ErrorEnvelope;
}

/**
 * Every status an ExecutionResult can carry. `satisfies` keeps each member a real status;
 * dispatch-result.test.ts checks the converse, that no status is missing.
 */
export const EXECUTION_STATUSES = [
  "completed",
  "failed",
  "blocked",
  "suite_review_problems",
  "environment_blocked",
  "environment_undefined",
  "refused",
  "checks_stale",
  "disputed",
  "environment_change_requested",
  "owner_unresolved",
  "interrupted",
  "context_exceeded",
  "no_wider_model",
  "prerequisite_needed",
  "client_decision_needed",
] as const satisfies readonly ExecutionResult["status"][];

export type ExecutionResult =
  | AgentExecutionResult
  | CompletedResult
  | SuiteReviewProblemsResult
  | EnvironmentBlockedResult
  | EnvironmentUndefinedResult
  | RefusedResult
  | ChecksStaleResult
  | DisputedResult
  | EnvironmentChangeRequestedResult
  | OwnerUnresolvedResult
  | InterruptedResult
  | ContextExceededResult
  | NoWiderModelResult
  | PrerequisiteNeededResult
  | ClientDecisionNeededResult;

interface AgentExecutionResult {
  readonly status: "failed" | "blocked";
  readonly detail: string;
  /** Whether another attempt can succeed, decided where the failure is: Delivery routes by it. */
  readonly verdict: FailureVerdict;
  readonly outcome: Outcome | null;
  readonly sessionId: string;
  /**
   * The item's dispatch ordinal (DispatchRef.attempt). execute() makes exactly one agent
   * invocation per call; retrying a failed task is Delivery's FailureRouter's job.
   */
  readonly attempt: number;
  readonly errorEnvelope?: ErrorEnvelope;
}

/**
 * What a completed task delivered. A merging task's record is the merge commit Z0 made on main,
 * which Delivery records on the work item before completing it; a check task merges
 * nothing, it records checks for the task they decide.
 */
type Delivery =
  | { readonly kind: "merged"; readonly mergeCommit: string }
  /**
   * An implementation that changed nothing whose checks and the regression suite already pass on
   * main: `mainCommit` is main when they ran, the delivering commit.
   */
  | { readonly kind: "already-delivered"; readonly mainCommit: string }
  | { readonly kind: "checks-recorded"; readonly revision: number }
  /**
   * A check task whose author finished blocked, and whose checked task's stored checks (`revision`),
   * the environment's test and the regression suite all pass on main at `mainCommit`:
   * no new revision; the checked task's delivered sweep closes it.
   */
  | { readonly kind: "checked-task-delivered"; readonly checkedTaskId: string; readonly mainCommit: string; readonly revision: number }
  /** A review of the plan's suites that found no problem in the suites of `reviewed` check tasks. */
  | { readonly kind: "suites-reviewed"; readonly reviewed: readonly string[] };

interface CompletedResult {
  readonly status: "completed";
  readonly delivered: Delivery;
  readonly detail: string;
  /** null for work found already delivered before any model was called, and for a review of the plan's suites (no agent). */
  readonly outcome: Outcome | null;
  readonly sessionId: string;
  readonly attempt: number;
  readonly errorEnvelope?: undefined;
}

/** Why an implementer's done with nothing to merge is not taken at its word. */
export const NO_CHANGE_REASON = "agent produced no file changes: the task branch holds no change against main";
