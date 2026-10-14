import type { EventStoreRepository } from "@ashara/db";
import type { DomainEvent, StoredBlockedReason } from "@ashara/shared";
import {
  describeErrorChain,
  wrapError,
  InvalidStatusTransition,
  InvalidId,
  withSalvagedResult,
  canTransitionTo,
  projectBlockCause,
  parseWorkItemId,
} from "@ashara/shared";
import type { ErrorEnvelope } from "@ashara/shared";
import type { AgentOutputJson } from "@ashara/shared/agent-output";
import type { WorkItem, WorkItemRepository, RawFailureContext } from "./acl/planning-acl.js";
import {
  PlanningService,
  failWorkItem,
  blockWorkItem,
  requeueWorkItem,
  takeEvents,
  startWorkItem,
  recoverFailedItem,
  exitStaleChecks,
  exitDisputedCheck,
  exitSuiteReview,
  requestEnvironmentChange,
} from "./acl/planning-acl.js";
import type { TaskDescriptor } from "./acl/development-acl.js";
import type { TaskResult, CoreLoopDeps, TaskRefusal } from "./types.js";
import { completedResult, failedResult, blockedResult } from "./types.js";
import { findEpicId, resolveTargetProjectPath, recordFailedApproach, composeRoutedLesson } from "./task-helpers.js";

type ParkedReason = Extract<
  StoredBlockedReason,
  {
    source:
      | "environment_unavailable"
      | "environment_undefined"
      | "checks_stale"
      | "check_disputed"
      | "suite_review_unresolved"
      | "owner_unresolved"
      | "merge_unrecorded";
  }
>;

/** Policy: the waits between attempts at the merge record; three attempts in all. */
const MERGE_RECORD_BACKOFF_MS: readonly number[] = [250, 1000];

/**
 * Writes the task's merge record, retrying with bounded backoff. Null once it is written; the
 * last attempt's error, described, when every attempt failed.
 */
async function recordMergeWithRetry(deps: ExecutionRoutingDeps, taskId: WorkItem["id"], mergeCommit: string): Promise<string | null> {
  let last = "";
  for (let attempt = 1; attempt <= MERGE_RECORD_BACKOFF_MS.length + 1; attempt++) {
    try {
      await deps.workItemRepo.recordMergeCommit(taskId, mergeCommit);
      if (attempt > 1) console.warn(`[${taskId}] merge record for ${mergeCommit} written on attempt ${attempt}`);
      return null;
    } catch (e) {
      last = describeErrorChain(e);
      const wait = MERGE_RECORD_BACKOFF_MS[attempt - 1];
      console.warn(
        `[${taskId}] merge record for ${mergeCommit} failed on attempt ${attempt} of ${MERGE_RECORD_BACKOFF_MS.length + 1}` +
          `${wait === undefined ? "; giving up" : `; retrying in ${wait}ms`}:`,
        e,
      );
      if (wait !== undefined) await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  return last;
}

interface StaleChecksResult {
  readonly checkTaskId: string;
  readonly revision: number;
  readonly detail: string;
}

/** An implementer's dispute of one stored check, as development returned it. */
interface DisputedCheckResult {
  readonly checkTaskId: string;
  readonly revision: number;
  readonly check: { readonly name: string; readonly command: string };
  readonly reason: string;
  readonly evidence: string | null;
  readonly detail: string;
}

/** A review of a plan revision's suites that found problems, as development returned it. */
interface SuiteReviewProblemsResult {
  readonly problems: ReadonlyArray<{
    readonly checkTaskIds: readonly string[];
    readonly kind: "contradiction" | "outside-vision";
    readonly problem: string;
    readonly evidence: string;
  }>;
  readonly detail: string;
}

/** An implementer's finished work that changed environment recipe files, as development returned it. */
interface EnvironmentChangeResult {
  readonly paths: readonly string[];
  readonly need: string;
  readonly diff: string;
  readonly detail: string;
}

interface ExecutionRoutingDeps {
  readonly workItemRepo: WorkItemRepository;
  readonly eventStore: Pick<EventStoreRepository, "publish">;
  readonly spendCap: CoreLoopDeps["spendCap"];
  /** Blocks a project whose configuration refused a model call. */
  readonly projects: Pick<CoreLoopDeps["projectRepo"], "block">;
  readonly checkDisputes: CoreLoopDeps["checkDisputes"];
  readonly disputeReports: CoreLoopDeps["disputeReports"];
  readonly suiteReviewFindings: CoreLoopDeps["suiteReviewFindings"];
  readonly suiteReviewReports: CoreLoopDeps["suiteReviewReports"];
  readonly environmentOwner: CoreLoopDeps["environmentOwner"];
}

async function executeTask(
  deps: ExecutionRoutingDeps,
  developmentService: CoreLoopDeps["developmentService"],
  task: WorkItem,
  targetProjectPath: string,
  attempt: number,
): Promise<{
  result: TaskResult;
  output: AgentOutputJson | null;
  errorEnvelope?: ErrorEnvelope;
  /**
   * The item was routed here, parked at Blocked (environment unavailable or undefined, checks stale
   * past their exit) or returned to Pending (a refusal, a shutdown, stale checks being rewritten),
   * so processTask must not run the
   * failed/blocked recovery ladder on it.
   */
  routedHere: boolean;
}> {
  // Walked up here (not inside @ashara/development, which has no dependency on
  // @ashara/planning) so storeKnowledge/storeFailureKnowledge scope
  // knowledge_entries by the true Epic, not whatever task.parentId points at
  // (kl-t2/Q5 — the epic_id mis-write that made recentFindings effectively
  // globally scoped across projects).
  const epicId = await findEpicId(deps.workItemRepo, task);

  const taskDescriptor: TaskDescriptor = {
    id: task.id,
    projectId: task.projectId,
    title: task.title,
    parentId: task.parentId,
    taskSpec: task.taskSpec,
    // Carries FailureRouter's replan context (Failed -> Pending via
    // applyReplan) through to buildBrief, so a replanned attempt is informed
    // by why the prior attempt failed instead of repeating it identically.
    blockedReason: task.blockedReason,
    epicId,
    dispatchCount: task.dispatchCount,
    attempt,
    workKind: task.workKind,
    successCriteria: task.successCriteria ?? [],
  };

  const execResult = await developmentService.execute(taskDescriptor, targetProjectPath);

  if (execResult.status === "environment_change_requested") {
    // Not a failure to retry: only environment work may change the recipe, so a replan would
    // meet the same refusal. An environment task is opened for the platform role and the item
    // waits on it, within a bound (ADR-074 addendum 2 d66 b); its branch is already deleted, so it
    // restarts from main once the environment has changed.
    await routeAsEnvironmentChange(deps, task, execResult);
    return {
      result: blockedResult(task.id, execResult.detail),
      output: execResult.output,
      errorEnvelope: execResult.errorEnvelope,
      routedHere: true,
    };
  }

  if (execResult.status === "checks_stale") {
    // Not a task failure (a replan keeps the item id, so it would meet the same checks): the
    // check task is reopened to write them again and the item waits on it, within a bound.
    await routeAsStaleChecks(deps, task.id, execResult);
    return {
      result: blockedResult(task.id, execResult.detail),
      output: execResult.output,
      errorEnvelope: execResult.errorEnvelope,
      routedHere: true,
    };
  }

  if (execResult.status === "disputed") {
    // Not a task failure and no lesson (ADR-074 addendum 2 d65 c): the check is its author's to
    // answer, so the check task is reopened with the dispute and the item waits on it, within a
    // bound of disputes per check task; past it the project is blocked for its owner.
    await routeAsDisputed(deps, task, execResult);
    return {
      result: blockedResult(task.id, execResult.detail),
      output: execResult.output,
      errorEnvelope: execResult.errorEnvelope,
      routedHere: true,
    };
  }

  if (execResult.status === "suite_review_problems") {
    // Not the review's failure and no lesson (ADR-074 addendum 2 d71 c): the checks are their
    // authors' to fix, so each named check task is reopened with the findings and the review waits
    // on them to read the new suites, within a bound per check task; past it the project is blocked.
    await routeAsSuiteReview(deps, task, execResult);
    return {
      result: blockedResult(task.id, execResult.detail),
      output: execResult.output,
      errorEnvelope: execResult.errorEnvelope,
      routedHere: true,
    };
  }

  if (execResult.status === "environment_blocked" || execResult.status === "environment_undefined") {
    // Not a task failure: re-dispatching cannot make the substrate or the
    // project's environment appear, so the item is parked at Blocked, never
    // routed to Failed. An unavailable substrate waits on the operator; an
    // undefined environment leaves Blocked by itself once the current version
    // has a statement and a succeeded build (parked-exits.ts).
    await routeAsParked(
      deps,
      task.id,
      execResult.status === "environment_blocked"
        ? { source: "environment_unavailable", unavailable: execResult.unavailable, reason: execResult.detail }
        : { source: "environment_undefined", reason: execResult.detail },
    );
    return {
      result: blockedResult(task.id, execResult.detail),
      output: execResult.output,
      errorEnvelope: execResult.errorEnvelope,
      routedHere: true,
    };
  }

  if (execResult.status === "owner_unresolved") {
    // No roster role can work the task: a re-dispatch meets the same owner and the same roster,
    // so the item is parked at Blocked, never routed to Failed. Its exit (parked-exits.ts): the
    // project stores a roster revision newer than `rosterRevision`, or the operator unblocks it.
    await routeAsParked(deps, task.id, {
      source: "owner_unresolved",
      ownerRoleId: execResult.ownerRoleId,
      rosterRevision: execResult.rosterRevision,
      reason: execResult.reason,
    });
    return {
      result: blockedResult(task.id, execResult.detail),
      output: execResult.output,
      errorEnvelope: execResult.errorEnvelope,
      routedHere: true,
    };
  }

  if (execResult.status === "interrupted") {
    // The shutdown stopped the attempt; it did not fail. No FailureRouter and no lesson: the
    // item goes back to Pending now with its dispatch refunded, so the startup reconciler
    // finds nothing InProgress to requeue and nothing Failed to route.
    await requeueAndRefund(deps, task.id, "a shutdown interrupted its attempt", "execution.routeAsInterrupted");
    return {
      result: { taskId: task.id, status: "interrupted", detail: execResult.detail },
      output: execResult.output,
      errorEnvelope: execResult.errorEnvelope,
      routedHere: true,
    };
  }

  if (execResult.status === "refused") {
    // One rule for every refusal: no lesson, no failure router, the dispatch given back. A
    // refusal no spend cap made (an unpriced model, an unestimable cost) is a configuration
    // fault a re-dispatch would meet again, so the project is blocked until the owner fixes it.
    const refusal: TaskRefusal = deps.spendCap.refusalOf(execResult.refusal) ?? configurationRefusal(task, execResult.refusal);
    if (refusal.kind === "configuration") {
      const blocked = await deps.projects.block(task.projectId, {
        category: "configuration",
        errorClass: refusal.errorClass,
        reason: refusal.reason,
      });
      console.warn(`[${task.id}] project ${task.projectId} ${blocked} on a configuration fault (${refusal.errorClass}): ${refusal.reason}`);
    }
    const cap =
      refusal.kind === "project"
        ? `project ${refusal.projectId}'s spend cap`
        : refusal.kind === "deployment"
          ? "the deployment's spend cap"
          : `a configuration fault (${refusal.errorClass})`;
    await requeueAndRefund(deps, task.id, `a refusal at ${cap}: ${refusal.reason}`, "execution.routeAsRefused");
    return {
      result: { taskId: task.id, status: "refused", detail: execResult.detail, refusal },
      output: execResult.output,
      errorEnvelope: execResult.errorEnvelope,
      routedHere: true,
    };
  }

  if (execResult.status === "completed") {
    const delivered = execResult.delivered;
    if (delivered.kind === "merged" || delivered.kind === "already-delivered") {
      // The merge record first, whatever the item's status now (a preempted item merged all the
      // same): the task is never Completed without it (Discipline A). The merge is on main, so a
      // record that cannot be written parks the item rather than leaving it InProgress, which the
      // startup reconciler would requeue and so re-dispatch merged work. Work already delivered
      // (ADR-074 addendum 2 d67 b) merged nothing: its record is main's commit its checks passed on.
      const mergeCommit = delivered.kind === "merged" ? delivered.mergeCommit : delivered.mainCommit;
      const unrecorded = await recordMergeWithRetry(deps, task.id, mergeCommit);
      if (unrecorded !== null) {
        const what = delivered.kind === "merged" ? `merged on main as ${mergeCommit}` : `already delivered on main at ${mergeCommit}`;
        const detail = `${what}, but the merge record could not be written: ${unrecorded}`;
        await routeAsParked(deps, task.id, { source: "merge_unrecorded", mergeCommit, reason: detail });
        return { result: blockedResult(task.id, detail), output: execResult.output, routedHere: true };
      }
    }
    try {
      await routeAsSuccess(deps, task);
    } catch (e) {
      // The item's status changed while the agent was executing (e.g., preempted
      // to Abandoned by HTTP PATCH). The agent's work
      // succeeded; processTask reloads the item and salvages the result based on
      // its actual status. Any non-preemption error must still propagate.
      if (!(e instanceof InvalidStatusTransition)) throw e;
      console.warn(
        `[${task.id}] completion route rejected (${e.from} -> Completed); ` +
        `agent succeeded, processTask will handle salvage`,
      );
    }
    return {
      result: completedResult(task.id),
      output: execResult.output,
      routedHere: false,
    };
  }

  await routeAsFailure(deps, task);

  if (execResult.status === "blocked") {
    return {
      result: blockedResult(task.id, execResult.detail),
      output: execResult.output,
      errorEnvelope: execResult.errorEnvelope,
      routedHere: false,
    };
  }

  return {
    result: failedResult(task.id, execResult.detail),
    output: execResult.output,
    errorEnvelope: execResult.errorEnvelope,
    routedHere: false,
  };
}

/** A refusal no spend cap made: the project's configuration, with the refusal's class and chain. */
function configurationRefusal(task: WorkItem, refused: Error): TaskRefusal {
  const { errorClass, reason } = projectBlockCause(refused);
  return { kind: "configuration", projectId: task.projectId, errorClass, reason };
}

/**
 * The dispatch stopped without the task being tried and found wanting: a model call was refused
 * before it was sent, or the process's shutdown interrupted the attempt. No failed approach, so
 * the item goes back to Pending and the dispatch the seam counted is given back. At a project-cap
 * or configuration refusal the project is blocked already (by Finance, or by executeTask), so the
 * gate skips the item until the owner returns the project to work; a deployment refusal stops the loop.
 */
async function requeueAndRefund(deps: ExecutionRoutingDeps, taskId: WorkItem["id"], why: string, site: string): Promise<void> {
  const item = await PlanningService.findWorkItem(deps.workItemRepo, taskId);
  if (!item) {
    console.warn(`[${taskId}] work item vanished before it could be returned to Pending after ${why}`);
    return;
  }
  const previousStatus = item.status;
  try {
    requeueWorkItem(item);
  } catch (e) {
    if (!(e instanceof InvalidStatusTransition)) throw e;
    console.warn(`[${taskId}] requeue after ${why} rejected (${e.from} -> Pending); item left at ${e.from}`);
    return;
  }
  await PlanningService.saveWorkItem(deps.workItemRepo, item, previousStatus);
  const dispatchCount = await refundBestEffort(deps, taskId, why);
  console.warn(`[${taskId}] back to Pending after ${why} (dispatch count ${dispatchCount})`);
  await publishBestEffort(deps.eventStore, taskId, takeEvents(item), site);
}

/**
 * Parks the item at Blocked with the stated reason. An item that is no longer
 * InProgress (moved by the owner during dispatch) is left where it is: no
 * agent ran, so there is no result to salvage.
 */
async function routeAsParked(
  deps: ExecutionRoutingDeps,
  taskId: WorkItem["id"],
  reason: ParkedReason,
): Promise<void> {
  const item = await PlanningService.findWorkItem(deps.workItemRepo, taskId);
  if (!item) {
    console.warn(`[${taskId}] work item vanished before it could be blocked (${reason.reason})`);
    return;
  }
  const previousStatus = item.status;
  try {
    blockWorkItem(item, reason);
  } catch (e) {
    if (!(e instanceof InvalidStatusTransition)) throw e;
    console.warn(`[${taskId}] ${reason.source} block rejected (${e.from} -> Blocked); item left at ${e.from} (${reason.reason})`);
    return;
  }
  await PlanningService.saveWorkItem(deps.workItemRepo, item, previousStatus);
  const what =
    reason.source === "environment_unavailable"
      ? `${reason.unavailable} unavailable`
      : reason.source === "checks_stale"
        ? `stored checks stale, check task ${reason.checkTaskId} must write them again`
        : reason.source === "check_disputed"
        ? `check ${JSON.stringify(reason.checkName)} disputed and check task ${reason.checkTaskId} cannot be reopened`
        : reason.source === "suite_review_unresolved"
        ? `the suite review found problems and check task(s) ${reason.checkTaskIds.join(", ")} cannot be reopened`
        : reason.source === "owner_unresolved"
          ? `no roster role can work it (owner ${reason.ownerRoleId ?? "none"})`
          : reason.source === "merge_unrecorded"
            ? `merge ${reason.mergeCommit} unrecorded, the loop writes it again each cycle`
            : "no environment defined";
  console.warn(`[${taskId}] blocked, ${what}: ${reason.reason}`);
  await publishBestEffort(deps.eventStore, taskId, takeEvents(item), "execution.routeAsParked");
}

/**
 * A refund that fails leaves the dispatch counted: the retry bound is then charged one attempt
 * too many, the conservative direction, so it is logged and the routing stands.
 */
async function refundBestEffort(deps: ExecutionRoutingDeps, taskId: WorkItem["id"], why: string): Promise<number | string> {
  try {
    return await deps.workItemRepo.refundDispatchCount(taskId);
  } catch (e) {
    console.warn(`[${taskId}] the dispatch stopped by ${why} could not be refunded; it stays counted:`, e);
    return "not refunded";
  }
}

/**
 * The exit of an item whose stored checks went stale (planning's exitStaleChecks): its check task
 * reopened and the item back at Pending waiting on it, with the dispatch given back (no model
 * ran); or, past the rewrite bound or with a check task that cannot be reopened, the item parked
 * at Blocked for the operator. The check task is saved first: if that save loses a race the item
 * is parked with checks_stale instead, never left waiting on a check task that stayed Completed.
 */
async function routeAsStaleChecks(deps: ExecutionRoutingDeps, taskId: WorkItem["id"], stale: StaleChecksResult): Promise<void> {
  const item = await PlanningService.findWorkItem(deps.workItemRepo, taskId);
  if (!item) {
    console.warn(`[${taskId}] work item vanished before its stale checks could be routed (${stale.detail})`);
    return;
  }
  const checkTask = await findCheckTask(deps.workItemRepo, stale.checkTaskId, "stale checks checkTaskId");
  const previousStatus = item.status;
  const checkTaskPrevious = checkTask?.status;
  let exit: ReturnType<typeof exitStaleChecks>;
  try {
    exit = exitStaleChecks(item, checkTask, stale);
  } catch (e) {
    if (!(e instanceof InvalidStatusTransition)) throw e;
    console.warn(`[${taskId}] stale-checks exit rejected (${e.from} -> ${e.to}); item left at ${e.from} (${stale.detail})`);
    return;
  }

  if (exit.kind === "rewrite" && checkTask !== null && checkTaskPrevious !== undefined) {
    try {
      await PlanningService.saveWorkItem(deps.workItemRepo, checkTask, checkTaskPrevious);
    } catch (e) {
      if (!(e instanceof InvalidStatusTransition)) throw e;
      await routeAsParked(deps, taskId, {
        source: "checks_stale",
        checkTaskId: stale.checkTaskId,
        reason: `${stale.detail}\nThe check task cannot be reopened: it moved to ${e.from} while it was being reopened`,
      });
      return;
    }
    await publishBestEffort(deps.eventStore, checkTask.id, takeEvents(checkTask), "execution.routeAsStaleChecks");
  }

  try {
    await PlanningService.saveWorkItem(deps.workItemRepo, item, previousStatus);
  } catch (e) {
    if (!(e instanceof InvalidStatusTransition)) throw e;
    // An owner moved the item during the dispatch; a reopened check task stays reopened and the
    // item keeps its dependency on it wherever the owner put it.
    console.warn(`[${taskId}] stale-checks exit (${exit.kind}) rejected (${e.from} -> ${item.status}); item left at ${e.from}`);
    return;
  }
  await publishBestEffort(deps.eventStore, taskId, takeEvents(item), "execution.routeAsStaleChecks");

  switch (exit.kind) {
    case "rewrite": {
      const dispatchCount = await refundBestEffort(deps, taskId, "stale stored checks");
      console.warn(
        `[${taskId}] stored checks revision ${stale.revision} stale; check task ${stale.checkTaskId} reopened to write them ` +
          `again, item back at Pending waiting on it (dispatch count ${dispatchCount})`,
      );
      return;
    }
    case "bound":
      console.warn(`[${taskId}] blocked, stored checks revision ${stale.revision} stale past the rewrite bound; check task ${stale.checkTaskId} is not reopened`);
      return;
    case "unreopenable":
      console.warn(`[${taskId}] blocked, stored checks stale and check task ${stale.checkTaskId} cannot be reopened: ${exit.why}`);
      return;
  }
}

/**
 * The exit of an item whose implementer disputed one of its stored checks (planning's
 * exitDisputedCheck). The dispute is recorded first, durably: its count per check task is the
 * bound. Within it the check task is reopened with the dispute in its brief and saved first, then
 * the item is back at Pending waiting on it, its dispatch given back; past it the Liaison blocks the
 * project with one report and the item returns to Pending, its dispatch given back, where the gate
 * skips it until the owner returns the project to work; a check task that cannot be reopened parks
 * the item at Blocked with a check_disputed reason.
 */
async function routeAsDisputed(deps: ExecutionRoutingDeps, task: WorkItem, dispute: DisputedCheckResult): Promise<void> {
  const disputes = await deps.checkDisputes.record({
    projectId: task.projectId,
    taskId: task.id,
    checkTaskId: dispute.checkTaskId,
    revision: dispute.revision,
    checkName: dispute.check.name,
    reason: dispute.reason,
    evidence: dispute.evidence,
  });
  const item = await PlanningService.findWorkItem(deps.workItemRepo, task.id);
  if (!item) {
    console.warn(`[${task.id}] work item vanished before its check dispute could be routed (${dispute.detail})`);
    return;
  }
  const checkTask = await findCheckTask(deps.workItemRepo, dispute.checkTaskId, "check dispute checkTaskId");
  const previousStatus = item.status;
  const checkTaskPrevious = checkTask?.status;
  let exit: ReturnType<typeof exitDisputedCheck>;
  try {
    exit = exitDisputedCheck(item, checkTask, { ...dispute, disputes });
  } catch (e) {
    if (!(e instanceof InvalidStatusTransition)) throw e;
    console.warn(`[${task.id}] check-dispute exit rejected (${e.from} -> ${e.to}); item left at ${e.from} (${dispute.detail})`);
    return;
  }

  if (exit.kind === "bound") {
    const blocked = await deps.disputeReports.blockOnDisputes({
      projectId: task.projectId,
      taskTitle: task.title,
      checkTaskId: dispute.checkTaskId,
      checkName: dispute.check.name,
      reason: dispute.reason,
      disputes,
      bound: exit.bound,
    });
    await requeueAndRefund(
      deps,
      task.id,
      `dispute ${disputes} of check task ${dispute.checkTaskId}, past the bound of ${exit.bound} (project ${task.projectId} ${blocked})`,
      "execution.routeAsDisputed",
    );
    return;
  }

  if (exit.kind === "rewrite" && checkTask !== null && checkTaskPrevious !== undefined) {
    try {
      await PlanningService.saveWorkItem(deps.workItemRepo, checkTask, checkTaskPrevious);
    } catch (e) {
      if (!(e instanceof InvalidStatusTransition)) throw e;
      await routeAsParked(deps, task.id, {
        source: "check_disputed",
        checkTaskId: dispute.checkTaskId,
        checkName: dispute.check.name,
        reason: `${dispute.reason}\nThe check task cannot be reopened: it moved to ${e.from} while it was being reopened`,
      });
      return;
    }
    await publishBestEffort(deps.eventStore, checkTask.id, takeEvents(checkTask), "execution.routeAsDisputed");
  }

  try {
    await PlanningService.saveWorkItem(deps.workItemRepo, item, previousStatus);
  } catch (e) {
    if (!(e instanceof InvalidStatusTransition)) throw e;
    console.warn(`[${task.id}] check-dispute exit (${exit.kind}) rejected (${e.from} -> ${item.status}); item left at ${e.from}`);
    return;
  }
  await publishBestEffort(deps.eventStore, task.id, takeEvents(item), "execution.routeAsDisputed");

  if (exit.kind === "rewrite") {
    const dispatchCount = await refundBestEffort(deps, task.id, "a check dispute");
    console.warn(
      `[${task.id}] check ${JSON.stringify(dispute.check.name)} disputed (dispute ${disputes} of its check task); check task ` +
        `${dispute.checkTaskId} reopened with the dispute, item back at Pending waiting on it (dispatch count ${dispatchCount})`,
    );
    return;
  }
  console.warn(`[${task.id}] blocked, check ${JSON.stringify(dispute.check.name)} disputed and check task ${dispute.checkTaskId} cannot be reopened: ${exit.why}`);
}

/**
 * The exit of a review task whose review of its plan revision's suites found problems (planning's
 * exitSuiteReview). The findings are recorded first, durably: how many reviews named each check
 * task is the bound. Within it every named check task is reopened with the problems in its brief and
 * the review returns to Pending, all in one transaction, its dispatch given back; the review's
 * dependencies on those check tasks hold it until they complete again, and the plan's
 * implementations stay held by their dependency on the review. Past the bound the Liaison blocks the
 * project with one report and the review returns to Pending, its dispatch given back, where the gate
 * skips it until the owner returns the project to work. A named check task that cannot be reopened,
 * or one that moves while it is reopened, parks the review at Blocked with a suite_review_unresolved
 * reason, so no implementation is released on problems nobody answered.
 */
async function routeAsSuiteReview(deps: ExecutionRoutingDeps, task: WorkItem, review: SuiteReviewProblemsResult): Promise<void> {
  const timesNamed = await deps.suiteReviewFindings.record({ projectId: task.projectId, reviewTaskId: task.id, problems: review.problems });
  const item = await PlanningService.findWorkItem(deps.workItemRepo, task.id);
  if (!item) {
    console.warn(`[${task.id}] review task vanished before its findings could be routed (${review.detail})`);
    return;
  }
  const named = [...new Set(review.problems.flatMap((problem) => problem.checkTaskIds))];
  const checkTasks = new Map<string, WorkItem | null>();
  for (const checkTaskId of named) checkTasks.set(checkTaskId, await findCheckTask(deps.workItemRepo, checkTaskId, "suite review checkTaskIds"));
  const previousStatus = item.status;
  let exit: ReturnType<typeof exitSuiteReview>;
  try {
    exit = exitSuiteReview(item, checkTasks, { problems: review.problems, timesNamed });
  } catch (e) {
    if (!(e instanceof InvalidStatusTransition)) throw e;
    console.warn(`[${task.id}] suite-review exit rejected (${e.from} -> ${e.to}); review left at ${e.from} (${review.detail})`);
    return;
  }

  switch (exit.kind) {
    case "bound": {
      const blocked = await deps.suiteReviewReports.blockOnSuiteReview({
        projectId: task.projectId,
        reviewTaskId: task.id,
        checkTaskId: exit.checkTaskId,
        times: exit.times,
        bound: exit.bound,
        problems: review.problems.map((problem) => problem.problem),
      });
      await requeueAndRefund(
        deps,
        task.id,
        `review ${exit.times} naming check task ${exit.checkTaskId}, past the bound of ${exit.bound} (project ${task.projectId} ${blocked})`,
        "execution.routeAsSuiteReview",
      );
      return;
    }
    case "unreopenable": {
      try {
        await PlanningService.saveWorkItem(deps.workItemRepo, item, previousStatus);
      } catch (e) {
        if (!(e instanceof InvalidStatusTransition)) throw e;
        console.warn(`[${task.id}] suite-review park rejected (${e.from} -> Blocked); review left at ${e.from}`);
        return;
      }
      console.warn(`[${task.id}] blocked, the suite review found problems no check task can be reopened for: ${exit.why}`);
      await publishBestEffort(deps.eventStore, task.id, takeEvents(item), "execution.routeAsSuiteReview");
      return;
    }
    case "reopened": {
      try {
        await deps.workItemRepo.withTransaction(async (tx) => {
          for (const checkTask of exit.checkTasks) await PlanningService.saveWorkItem(tx, checkTask, "Completed");
          await PlanningService.saveWorkItem(tx, item, previousStatus);
        });
      } catch (e) {
        if (!(e instanceof InvalidStatusTransition)) throw e;
        // Nothing was written: a check task or the review moved while they were being reopened.
        await routeAsParked(deps, task.id, {
          source: "suite_review_unresolved",
          checkTaskIds: named,
          reason: `${review.detail}\nThe check tasks cannot be reopened: ${e.message}`,
        });
        return;
      }
      for (const checkTask of exit.checkTasks) {
        await publishBestEffort(deps.eventStore, checkTask.id, takeEvents(checkTask), "execution.routeAsSuiteReview");
      }
      await publishBestEffort(deps.eventStore, task.id, takeEvents(item), "execution.routeAsSuiteReview");
      const dispatchCount = await refundBestEffort(deps, task.id, "a suite review with problems");
      console.warn(
        `[${task.id}] suite review found ${review.problems.length} problem(s); check task(s) ${named.join(", ")} reopened ` +
          `with them, review back at Pending waiting on them (dispatch count ${dispatchCount})`,
      );
      return;
    }
  }
}

/**
 * The exit of an item whose implementer changed environment recipe files (planning's
 * requestEnvironmentChange). How many environment tasks were already opened for it is read from
 * its dependencies, a durable count; the owner is the role doing the project's environment work.
 * Within the bound the new environment task, the item's dependency on it and the item back at
 * Pending are written in one transaction, and the dispatch is given back (the work was not tried
 * and found wanting); past the bound, or with no owner, the item is parked at Blocked, which the
 * Liaison reports.
 */
async function routeAsEnvironmentChange(deps: ExecutionRoutingDeps, task: WorkItem, request: EnvironmentChangeResult): Promise<void> {
  const item = await PlanningService.findWorkItem(deps.workItemRepo, task.id);
  if (!item) {
    console.warn(`[${task.id}] work item vanished before its environment change could be routed (${request.detail})`);
    return;
  }
  let opened = 0;
  for (const dependencyId of await deps.workItemRepo.getDependencies(task.id)) {
    const dependency = await PlanningService.findWorkItem(deps.workItemRepo, dependencyId);
    if (dependency?.taskSpec?.origin === "environment-change") opened++;
  }
  // The product's build and test are skipped only on evidence there is no product: the product
  // scaffold itself is asking and none of the project's has completed. Any other requester (a plan
  // from before the scaffold included) keeps them, the stricter check.
  const completed = await deps.workItemRepo.findByProjectAndStatus(task.projectId, "Completed");
  const product =
    item.taskSpec?.origin === "product-scaffold" && !completed.some((done) => done.taskSpec?.origin === "product-scaffold")
      ? "absent"
      : "present";
  let owner: Awaited<ReturnType<ExecutionRoutingDeps["environmentOwner"]>>;
  try {
    owner = await deps.environmentOwner(task.projectId);
  } catch (e) {
    owner = { kind: "none", why: `the project's roster could not be read: ${describeErrorChain(e)}` };
  }
  const previousStatus = item.status;
  let exit: ReturnType<typeof requestEnvironmentChange>;
  try {
    exit = requestEnvironmentChange(item, request, { opened, owner, product });
  } catch (e) {
    if (!(e instanceof InvalidStatusTransition)) throw e;
    console.warn(`[${task.id}] environment-change exit rejected (${e.from} -> ${e.to}); item left at ${e.from} (${request.detail})`);
    return;
  }

  if (exit.kind !== "opened") {
    try {
      await PlanningService.saveWorkItem(deps.workItemRepo, item, previousStatus);
    } catch (e) {
      if (!(e instanceof InvalidStatusTransition)) throw e;
      console.warn(`[${task.id}] environment-change park rejected (${e.from} -> Blocked); item left at ${e.from}`);
      return;
    }
    console.warn(
      `[${task.id}] blocked, environment change needed for ${request.paths.join(", ")}: ` +
        (exit.kind === "bound" ? `past the bound of ${exit.bound} environment task(s)` : `no environment task can be opened: ${exit.why}`),
    );
    await publishBestEffort(deps.eventStore, task.id, takeEvents(item), "execution.routeAsEnvironmentChange");
    return;
  }

  const environment = exit.environment;
  try {
    await deps.workItemRepo.withTransaction(async (tx) => {
      await PlanningService.createWorkItem(tx, environment);
      await tx.addDependency(item.id, environment.id);
      await PlanningService.saveWorkItem(tx, item, previousStatus);
    });
  } catch (e) {
    if (!(e instanceof InvalidStatusTransition)) throw e;
    // An owner moved the item during the dispatch: nothing was written, the environment task included.
    console.warn(`[${task.id}] environment-change exit rejected (${e.from} -> Pending); item left at ${e.from}, no environment task opened`);
    return;
  }
  await publishBestEffort(deps.eventStore, environment.id, takeEvents(environment), "execution.routeAsEnvironmentChange");
  await publishBestEffort(deps.eventStore, task.id, takeEvents(item), "execution.routeAsEnvironmentChange");
  const dispatchCount = await refundBestEffort(deps, task.id, "an environment change request");
  console.warn(
    `[${task.id}] needs a change to the environment recipe (${request.paths.join(", ")}); environment task ${environment.id} opened ` +
      `(${opened + 1} for this task), item back at Pending waiting on it (dispatch count ${dispatchCount})`,
  );
}

/** The check task a stale revision names; null when the stored id is no work item's. */
async function findCheckTask(workItemRepo: WorkItemRepository, checkTaskId: string, field: string): Promise<WorkItem | null> {
  let id: WorkItem["id"];
  try {
    id = parseWorkItemId(checkTaskId, field);
  } catch (e) {
    if (!(e instanceof InvalidId)) throw e;
    console.warn(`[stale-checks] the stored check task id names no work item: ${e.message}`);
    return null;
  }
  return PlanningService.findWorkItem(workItemRepo, id);
}

async function routeAsSuccess(deps: ExecutionRoutingDeps, task: WorkItem): Promise<void> {
  const events = await PlanningService.route(deps.workItemRepo, task.id, true);
  for (const event of events) {
    await deps.eventStore.publish(event);
  }
}

async function routeAsFailure(deps: ExecutionRoutingDeps, task: WorkItem): Promise<void> {
  // The state commit and the audit publish are kept separate: the Failed
  // transition is committed first, then events are published best-effort. A
  // publish failure must NOT re-drive the domain fallback (that would call
  // failWorkItem on an already-Failed item and throw Failed->Failed) — the
  // transition is durable independent of the audit log (ADR-029, mig-phase-5).
  const events = await commitFailure(deps.workItemRepo, task.id);
  await publishBestEffort(deps.eventStore, task.id, events, "execution.routeAsFailure");
}

/**
 * Transitions the task to Failed and returns the resulting domain events. Prefers
 * the lifecycle router; on router failure it falls back to the domain method, but
 * only when the live item can still legally transition to Failed — an item already
 * in Failed (or another terminal state) yields no events rather than crashing.
 */
async function commitFailure(workItemRepo: WorkItemRepository, taskId: WorkItem["id"]): Promise<DomainEvent[]> {
  try {
    return await PlanningService.route(workItemRepo, taskId, false);
  } catch (e) {
    console.warn(`[${taskId}] lifecycle route failed, falling back to domain method:`, e);
    const item = await PlanningService.findWorkItem(workItemRepo, taskId);
    if (!item || !canTransitionTo(item.status, "Failed")) {
      return [];
    }
    const previousStatus = item.status;
    failWorkItem(item, { source: "orchestrator_error", reason: "orchestrator error" });
    await PlanningService.saveWorkItem(workItemRepo, item, previousStatus);
    return takeEvents(item);
  }
}

async function publishBestEffort(
  eventStore: Pick<EventStoreRepository, "publish">,
  workItemId: string,
  events: DomainEvent[],
  site: string,
): Promise<void> {
  for (const event of events) {
    try {
      await eventStore.publish(event);
    } catch (publishError) {
      console.warn(
        `[${site}] failed to publish audit event for ${workItemId} (status transition already committed):`,
        publishError,
      );
    }
  }
}

/**
 * Durably records a returning agent result on an Abandoned work item's
 * blockedReason, so cascade-completion (isSettled) can see the work's outcome
 * without reopening the terminal status. The existing blockedReason is
 * spread with salvaged fields and saved as an Abandoned → Abandoned metadata
 * write (no status transition, no outbound edge needed).
 *
 * Best-effort: a salvage failure is logged (Discipline C) but must not crash
 * processTask — the item is already terminal and the agent spend is sunk.
 */
async function salvagePreemptedResult(
  workItemRepo: WorkItemRepository,
  item: WorkItem,
  outcome: "completed" | "failed" | "blocked",
  detail: string,
): Promise<void> {
  try {
    if (!item.blockedReason) {
      // The item reached Abandoned with no recorded reason — a data integrity
      // gap, not an expected state. Construct a minimal reason so the returning
      // result is not discarded. orchestrator_error is truthful: the orchestrator
      // detected the gap, and the reason text states what happened without
      // asserting a cause we do not know.
      console.warn(
        `[${item.id}] Abandoned item has no blockedReason; ` +
        `constructing orchestrator_error to persist salvaged result (outcome: ${outcome})`,
      );
      item.blockedReason = {
        source: "orchestrator_error",
        reason: "Abandoned with no prior blocked_reason; reason constructed by salvage",
      };
    }
    item.blockedReason = withSalvagedResult(item.blockedReason, outcome, detail);
    item.updatedAt = new Date();
    await PlanningService.saveWorkItem(workItemRepo, item, "Abandoned");
    console.log(
      `[${item.id}] salvaged preempted result (outcome: ${outcome}) ` +
      `on Abandoned item; dispatchCount: ${item.dispatchCount}`,
    );
  } catch (salvageError) {
    // The item is already terminal — a salvage failure does not change its status.
    // Log structured context (Discipline C) so the lost result is visible.
    console.warn(
      `[${item.id}] failed to salvage preempted result ` +
      `(outcome: ${outcome}, detail: ${detail.slice(0, 200)}); ` +
      `item remains Abandoned, result data lost:`,
      salvageError,
    );
  }
}

export async function processTask(
  deps: CoreLoopDeps,
  task: WorkItem,
): Promise<TaskResult> {
  const workItem = await PlanningService.findWorkItem(deps.workItemRepo, task.id);
  if (!workItem) {
    return blockedResult(task.id, "work item not found");
  }
  if (workItem.status !== "Pending") {
    return blockedResult(task.id, "task already picked up by another cycle");
  }

  const previousStatus = workItem.status;
  startWorkItem(workItem);
  await PlanningService.saveWorkItem(deps.workItemRepo, workItem, previousStatus);
  const startEvents = takeEvents(workItem);
  const ancestorEvents = await PlanningService.activateAncestors(deps.workItemRepo, workItem.parentId);
  for (const event of [...startEvents, ...ancestorEvents]) {
    await deps.eventStore.publish(event);
  }

  const routingDeps: ExecutionRoutingDeps = {
    workItemRepo: deps.workItemRepo,
    eventStore: deps.eventStore,
    spendCap: deps.spendCap,
    projects: deps.projectRepo,
    checkDisputes: deps.checkDisputes,
    disputeReports: deps.disputeReports,
    suiteReviewFindings: deps.suiteReviewFindings,
    suiteReviewReports: deps.suiteReviewReports,
    environmentOwner: deps.environmentOwner,
  };
  const workspace = await resolveTargetProjectPath(deps.projectRepo, workItem.projectId, deps.config.workdirBase);
  if (workspace.kind === "rejected") {
    // Before the dispatch is counted, any model call or any cell: without a valid target checkout
    // the work has nowhere to be done or merged, and a re-dispatch meets the same project record.
    await routeAsParked(routingDeps, task.id, {
      source: "environment_unavailable",
      unavailable: "target workspace",
      reason: workspace.reason,
    });
    return blockedResult(task.id, workspace.reason);
  }
  const targetProjectPath = workspace.path;

  // DISPATCH SEAM (migration 018, r9f-t1). The item is now committed InProgress and
  // is about to be handed to the agent. Bump the dispatch counter with a single
  // atomic UPDATE BEFORE executeTask, so the attempt is recorded even if the agent
  // crashes, its output is discarded, or any downstream step throws — the exact
  // Run-9 hole where a discarded output left the retry bound reading zero forever.
  // This is the ONE place a dispatch is counted; every retry-bound consumer
  // (FailureRouter recovery, startup reconciler) reads the resulting
  // dispatch_count off the reloaded WorkItem.
  const attempt = await deps.workItemRepo.incrementDispatchCount(task.id);

  const {
    result,
    output,
    errorEnvelope: execEnvelope,
    routedHere,
  } = await executeTask(
    routingDeps,
    deps.developmentService,
    task,
    targetProjectPath,
    attempt,
  );

  // The target project path is minted, validated, and recorded on the project
  // inside resolveTargetProjectPath, its single writer.

  // Salvage check for completed results: when the agent succeeded but the item
  // was preempted to Abandoned (by HTTP PATCH) during
  // execution, executeTask catches the InvalidStatusTransition from routeAsSuccess
  // and returns a completed result. The result's value — "the work is done" — must
  // be durably recorded on the Abandoned item so cascade-completion (isSettled)
  // can see the work was done without reopening the terminal status.
  if (result.status === "completed") {
    const currentForSalvage = await PlanningService.findWorkItem(deps.workItemRepo, task.id);
    if (currentForSalvage && currentForSalvage.status === "Abandoned") {
      await salvagePreemptedResult(deps.workItemRepo, currentForSalvage, "completed", result.detail);
    }
  }

  // An environment-blocked item is already parked at Blocked, a refused or interrupted one
  // back at Pending (or any was left where an owner moved it): nothing to route or salvage.
  if (routedHere) {
    return result;
  }

  if (result.status === "failed" || result.status === "blocked") {
    let current = await PlanningService.findWorkItem(deps.workItemRepo, task.id);
    if (current && current.status === "InProgress") {
      await handleTaskError(deps, task);
      current = await PlanningService.findWorkItem(deps.workItemRepo, task.id);
    }
    // Exhaustive over WorkItemStatus: adding a status without a case here is
    // a compile error, not a new silent fall-through. executeTask commits the
    // WorkItem to Failed for BOTH failed and blocked TaskResults from an agent
    // dispatch (a "blocked" result is a routine agent outcome — a BLOCKED:
    // marker or turn-limit — not a dependency wait). Blocked status is reached
    // via the HTTP PATCH path, the gate's dependency_unsatisfiable park, and the
    // parked dispatch outcomes (routeAsParked, routeAsStaleChecks), which
    // returned above. Any item that landed at Failed is routed through
    // the FailureRouter so it recovers (replan) or terminates
    // (abandon) rather than sitting in Failed and deadlocking its
    // dependents (Run-8 C2, migration Phase 6).
    if (!current) {
      console.warn(
        `[${task.id}] work item vanished after agent returned ` +
        `(result: ${result.status}); dispatchCount already incremented, ` +
        `agent spend unrecoverable`,
      );
    } else {
      switch (current.status) {
        case "Failed": {
          const failure: RawFailureContext = {
            detail: result.detail,
            raw: execEnvelope ? { ...execEnvelope } : (output ?? {}),
          };
          // dispatchCount was already incremented for this attempt at the dispatch
          // seam above and is not mutated by recoverFailedItem, so it is the exact
          // "attempts so far" count recoverFailedItem itself reads as priorAttempts.
          const attempts = current.dispatchCount;
          const action = await recoverFailedItem(
            {
              workItemRepo: deps.workItemRepo,
              eventPublisher: deps.eventStore,
              failureRouter: deps.failureRouter,
            },
            current,
            failure,
          );
          // Every FailureRouter decision here (replan/abandon) means
          // this dispatch attempt did not succeed (kl-t1): capture it as a
          // failed_approaches lesson so a later brief sees WHY, closing the gap
          // where only a THROWN orchestrator error (the catch block below) ever
          // reached recordFailedApproach. This is the ONLY call site that writes
          // for the typed-failed-results path — the catch block's own
          // recoverFailedItem call does not, so a thrown error never
          // double-writes.
          await recordFailedApproach(
            deps.failedApproachRepo,
            deps.workItemRepo,
            current,
            failure.detail,
            composeRoutedLesson(current.title, action, attempts, failure.detail),
          );
          break;
        }

        case "InProgress":
          // handleTaskError was called but the concurrent pre-image guard
          // rejected the save — another writer moved the item first. The
          // startup reconciler will requeue on next restart.
          console.warn(
            `[${task.id}] work item still InProgress after handleTaskError ` +
            `(expected Failed); agent result (${result.status}) discarded — ` +
            `startup reconciler will requeue on next restart`,
          );
          break;

        case "Completed":
        case "Pending":
        case "Blocked":
          // Preempted to a non-Abandoned, non-Failed status. The agent's
          // result is not routable. dispatchCount was already incremented.
          console.warn(
            `[${task.id}] work item preempted: expected Failed, ` +
            `found "${current.status}" after agent returned ` +
            `(result: ${result.status}); agent result discarded, ` +
            `dispatchCount already incremented, agent spend unrecoverable`,
          );
          break;

        case "Abandoned": {
          // Preempted to Abandoned while the agent was executing. The
          // agent's result has value: persist it on the existing
          // blockedReason so cascade-completion can see the work's
          // outcome without reopening the terminal status.
          const outcomeKind = result.status === "blocked" ? "blocked" as const : "failed" as const;
          await salvagePreemptedResult(deps.workItemRepo, current, outcomeKind, result.detail);
          await recordFailedApproach(
            deps.failedApproachRepo,
            deps.workItemRepo,
            current,
            result.detail,
            `Preempted to Abandoned during execution (result: ${result.status}). ` +
            `Agent spend incurred, result salvaged.`,
          );
          break;
        }

        default: {
          const _exhaustive: never = current.status;
          throw new Error(
            `Unhandled WorkItemStatus in processTask post-agent ladder: ` +
            `${String(_exhaustive)}`,
          );
        }
      }
    }
  }

  return result;
}

async function handleTaskError(deps: CoreLoopDeps, task: WorkItem): Promise<void> {
  // Commit the Failed transition first, then publish best-effort. A publish
  // failure must not re-drive the domain fallback onto an already-Failed item
  // (Failed->Failed) — the transition is durable independent of the audit
  // publish (ADR-029, mig-phase-5).
  let events: DomainEvent[];
  try {
    events = await PlanningService.route(deps.workItemRepo, task.id, false);
  } catch (e) {
    console.warn(`[${task.id}] lifecycle route also failed:`, e);
    const item = await PlanningService.findWorkItem(deps.workItemRepo, task.id);
    if (!item || !canTransitionTo(item.status, "Failed")) {
      events = [];
    } else {
      const previousStatus = item.status;
      failWorkItem(item, { source: "orchestrator_error", reason: "orchestrator error" });
      await PlanningService.saveWorkItem(deps.workItemRepo, item, previousStatus);
      events = takeEvents(item);
    }
  }
  await publishBestEffort(deps.eventStore, task.id, events, "execution.handleTaskError");
}

/**
 * Recovers from a THROWN orchestrator error during `processTask` (as opposed to
 * a typed failed/blocked TaskResult, which processTask already routes itself):
 * commits the item to Failed, records the failed-approach lesson, and routes it
 * through the SAME FailureRouter policy as the clean-failure path — without
 * this the item strands at Failed until the next process restart (the gate
 * selects Pending only, so its dependents deadlock). Fully fail-closed: if
 * recovery itself throws (including the item lookup), the item is left at
 * Failed for the STARTUP reconciler to retry and the caller's cycle loop
 * continues — a single task's recovery must never crash the batch.
 */
export async function handleProcessingError(
  deps: CoreLoopDeps,
  task: WorkItem,
  error: unknown,
): Promise<TaskResult> {
  console.warn(`[${task.id}] task processing failed with orchestrator error:`, error);
  await handleTaskError(deps, task);

  const chain = wrapError("orchestrator", "processTask", error, { taskId: task.id });
  const envelope: ErrorEnvelope = {
    outcome: "failed",
    summary: chain.message,
    chain,
  };

  const result = failedResult(task.id, chain.message);
  await recordFailedApproach(deps.failedApproachRepo, deps.workItemRepo, task, chain.message);

  try {
    const current = await PlanningService.findWorkItem(deps.workItemRepo, task.id);
    if (!current) {
      console.warn(
        `[${task.id}] work item vanished during orchestrator error recovery; ` +
        `item left for startup reconciler`,
      );
    } else {
      // Exhaustive over WorkItemStatus so a new member is a compile error
      // here, not a silent skip of recovery.
      switch (current.status) {
        case "Failed":
          await recoverFailedItem(
            {
              workItemRepo: deps.workItemRepo,
              eventPublisher: deps.eventStore,
              failureRouter: deps.failureRouter,
            },
            current,
            { detail: chain.message, raw: { ...envelope } },
          );
          break;

        case "InProgress":
          // handleTaskError was called but the concurrent pre-image guard
          // rejected the transition. The startup reconciler will requeue.
          console.warn(
            `[${task.id}] work item still InProgress after handleTaskError ` +
            `in error recovery (expected Failed); ` +
            `item left for startup reconciler`,
          );
          break;

        case "Completed":
        case "Pending":
        case "Blocked":
        case "Abandoned":
          // Preempted by an external actor while the agent was executing.
          // Recovery is not meaningful for a non-Failed item.
          console.warn(
            `[${task.id}] work item preempted during error recovery: ` +
            `expected Failed, found "${current.status}"; ` +
            `recovery skipped, dispatchCount already incremented`,
          );
          break;

        default: {
          const _exhaustive: never = current.status;
          throw new Error(
            `Unhandled WorkItemStatus in handleProcessingError: ` +
            `${String(_exhaustive)}`,
          );
        }
      }
    }
  } catch (recoveryError) {
    console.warn(
      `[${task.id}] recovery after orchestrator error failed; item left at Failed for the startup reconciler:`,
      recoveryError,
    );
  }

  return result;
}
