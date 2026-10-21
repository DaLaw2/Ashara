import type { DomainEvent } from "@ashara/shared";
import { describeErrorChain } from "@ashara/shared";
import { canTransitionTo } from "../work-item-language/transitions.js";
import type { WorkItem, WorkItemRepository } from "../domain/index.js";
import type { RawFailureContext } from "../failure-router.js";
import { PlanningService, salvagedReason, failWorkItem, takeEvents, startWorkItem } from "../domain/index.js";
import { recoverFailedItem, recoverParkedFailedItem } from "../lifecycle/failure-recovery.js";
import { recordFailedApproach } from "../acl/knowledge-acl.js";
import type { FailureVerdict } from "../acl/quality-acl.js";
import { toRecordedOutcome } from "../acl/workplace-acl.js";
import type { TaskResult, CoreLoopDeps } from "../types.js";
import { blockedResult } from "../types.js";
import type { TaskDescriptor } from "../dispatch/dispatch-types.js";
import { findEpicId, resolveTargetProjectPath } from "../task-helpers.js";
import { publishBestEffort } from "./audit-events.js";
import { workBudgetGiveUp } from "./give-up-causes.js";
import { asharaFaultOf, haltOnProjectRefusal } from "./halt-causes.js";
import { routeAsGivenUp } from "./reopen-routes.js";
import type { ExecutionRoutingDeps } from "./routing-deps.js";
import { routingDepsOf } from "./routing-deps.js";
import type { RoutedExecution } from "./verdict-routing.js";
import { routeAsInfrastructureFault, routeExecution } from "./verdict-routing.js";

/** A dispatch the seam counted: the task, its item as started, and where and as which attempt it runs. */
interface CountedDispatch {
  readonly deps: CoreLoopDeps;
  readonly task: WorkItem;
  readonly workItem: WorkItem;
  readonly routingDeps: ExecutionRoutingDeps;
  readonly targetProjectPath: string;
  readonly attempt: number;
}

/** The task as its dispatch is handed it, from its WorkItem. */
async function descriptorOf(repo: WorkItemRepository, task: WorkItem, attempt: number): Promise<TaskDescriptor> {
  // Walked up here, where the WorkItem hierarchy is read, so storeFailureKnowledge scopes
  // knowledge_entries by the true Epic, not whatever task.parentId points at
  // (an epic_id written from the parent would scope recentFindings across
  // projects).
  const epicId = await findEpicId(repo, task);
  return {
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
    // eslint-disable-next-line no-restricted-syntax -- policy default: a task stored without criteria (epics, HTTP-created tasks; parseStoredSuccessCriteria) gets no acceptance section in its brief; no verdict reads it
    successCriteria: task.successCriteria ?? [],
    overflowedWindowTokens: task.overflowedWindowTokens,
  };
}

/** Runs the counted dispatch and routes what it returned. */
async function dispatchAndRoute(run: CountedDispatch): Promise<RoutedExecution> {
  const descriptor = await descriptorOf(run.routingDeps.workItemRepo, run.task, run.attempt);
  const executed = await run.deps.dispatchService.execute(descriptor, run.targetProjectPath);
  return routeExecution(run.routingDeps, run.task, executed);
}

/** A failed or blocked attempt reached the FailureRouter without Quality's verdict on it: no route is picked by default. */
class FailureVerdictMissing extends Error {
  constructor(
    readonly taskId: string,
    readonly resultStatus: string,
  ) {
    super(`task ${taskId}: a ${resultStatus} attempt reached the failure routing with no verdict on whether another attempt can succeed`);
    this.name = "FailureVerdictMissing";
  }
}

/**
 * Durably records a returning agent result on an Abandoned work item's
 * blockedReason, so cascade-completion (deliveredItsWork) can see the work's outcome
 * without reopening the terminal status. The existing blockedReason is
 * spread with salvaged fields and saved as an Abandoned → Abandoned metadata
 * write (no status transition, no outbound edge needed).
 *
 * Best-effort: a salvage failure is logged (Discipline C) but must not crash
 * processTask — the item is already terminal and the agent spend is sunk.
 */
async function salvagePreemptedResult(
  deps: Pick<CoreLoopDeps, "workItemRepo" | "logger">,
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
      deps.logger.error(
        "delivery.blocked-reason-missing",
        `Abandoned item has no blockedReason; constructing orchestrator_error to persist salvaged result (outcome: ${outcome})`,
        { taskId: item.id, outcome },
      );
      item.blockedReason = {
        source: "orchestrator_error",
        reason: "Abandoned with no prior blocked_reason; reason constructed by salvage",
      };
    }
    item.blockedReason = salvagedReason(item.blockedReason, outcome, detail);
    item.updatedAt = new Date();
    await PlanningService.saveWorkItem(deps.workItemRepo, item, "Abandoned");
    deps.logger.info("delivery.result-salvaged", `salvaged preempted result (outcome: ${outcome}) on Abandoned item; dispatchCount: ${item.dispatchCount}`, {
      taskId: item.id,
      outcome,
      dispatchCount: item.dispatchCount,
    });
  } catch (salvageError) {
    // The item is already terminal — a salvage failure does not change its status.
    // Log structured context (Discipline C) so the lost result is visible.
    // eslint-disable-next-line ashara/catch-continue -- best effort: the item is already terminal (Abandoned by the operator's preemption); without the salvaged outcome its parent stays incomplete (deliveredItsWork), the fail-closed direction, and its abandonment opens a plan repair
    deps.logger.warn(
      "delivery.salvage-failed",
      `failed to salvage preempted result (outcome: ${outcome}, detail: ${detail.slice(0, 200)}); item remains Abandoned, result data lost`,
      { taskId: item.id, outcome },
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

  const routingDeps = routingDepsOf(deps);

  // Before the dispatch seam nothing of the task ran: a throw here is Ashara's own (a store, the
  // audit log, the workspace's record), never the task's, so it is routed uncharged and uncounted.
  let targetProjectPath: string;
  let attempt: number;
  try {
    const startEvents = takeEvents(workItem);
    const ancestorEvents = await PlanningService.activateAncestors(deps.workItemRepo, workItem.parentId);
    await publishBestEffort(deps, task.id, [...startEvents, ...ancestorEvents], "execution.processTask");

    const workspace = await resolveTargetProjectPath(deps.projectRepo, workItem.projectId, deps.config.workdirBase, deps.logger);
    if (workspace.kind === "rejected") {
      // Before the dispatch is counted, any model call or any cell: without a valid target checkout
      // the work has nowhere to be done or merged. Ashara's own record of the project, not the
      // task's: an uncharged fault, within the task's budget; no substrate probe can repair it.
      await routeAsInfrastructureFault(routingDeps, workItem, { class: "ashara", unavailable: "target workspace", reason: workspace.reason }, "not-counted");
      return { taskId: task.id, status: "interrupted", detail: workspace.reason };
    }
    targetProjectPath = workspace.path;

    // The check set an implementation is about to be judged by freezes before it is dispatched;
    // a freeze that cannot be written stops the dispatch, uncounted.
    for (const reviewTaskId of await deps.checkSetFreeze.freezeFor(task.id)) {
      deps.logger.info("delivery.check-set-frozen", `the check set of review task ${reviewTaskId} is frozen: this is the first task dispatched on it`, {
        taskId: task.id,
        reviewTaskId,
      });
    }

    // DISPATCH SEAM. The item is now committed InProgress and
    // is about to be handed to the agent. Bump the dispatch counter with a single
    // atomic UPDATE BEFORE the dispatch runs, so the attempt is recorded even if the agent
    // crashes, its output is discarded, or any downstream step throws: a count taken
    // later would leave the retry bound reading zero forever for a discarded output.
    // This is the ONE place a dispatch is counted; every retry-bound consumer
    // (FailureRouter recovery, startup reconciler) reads the resulting
    // dispatch_count off the reloaded WorkItem.
    attempt = await deps.workItemRepo.incrementDispatchCount(task.id);
  } catch (e) {
    const fault = asharaFaultOf(e, "start the dispatch");
    deps.logger.error("delivery.dispatch-start-failed", "the dispatch could not start, Ashara's own fault, routed uncharged", { taskId: task.id }, e);
    await routeAsInfrastructureFault(routingDeps, workItem, fault, "not-counted");
    return { taskId: task.id, status: "interrupted", detail: fault.reason };
  }

  try {
    // The attempt's own trace, its parent the cycle's: a lane can outlive the cycle that started it.
    return await deps.logger.scope({ projectId: workItem.projectId, taskId: task.id, attempt, trace: "new" }, () =>
      runCountedDispatch({ deps, task, workItem, routingDeps, targetProjectPath, attempt }),
    );
  } catch (e) {
    throw new CountedDispatchThrew(task.id, e);
  }
}

/**
 * A throw out of a dispatch the seam counted. Its recovery (handleProcessingError) reads from it
 * that an item still InProgress holds a counted dispatch to give back: every routing that ends a
 * dispatch its work did not earn writes the refund with its transition (saveRefunded), so an item
 * still InProgress after a counted dispatch has not been refunded.
 */
class CountedDispatchThrew extends Error {
  constructor(
    readonly taskId: string,
    readonly thrown: unknown,
  ) {
    super(`task ${taskId}: its counted dispatch threw: ${describeErrorChain(thrown)}`, { cause: thrown });
    this.name = "CountedDispatchThrew";
  }
}

/** The dispatch after the seam counted it: its run, then its routing. */
async function runCountedDispatch(run: CountedDispatch): Promise<TaskResult> {
  const { deps, task, workItem, routingDeps, attempt } = run;
  let executed: RoutedExecution;
  try {
    executed = await dispatchAndRoute(run);
  } catch (e) {
    const refusal = deps.spendCap.refusalOf(e);
    if (refusal?.kind === "task_work") {
      // The task's spent work budget surfaced as a throw: given up as on a refused result, never
      // requeued, since every re-dispatch meets the same refusal.
      await routeAsGivenUp(routingDeps, task.id, workBudgetGiveUp(refusal), "refund");
      return blockedResult(task.id, refusal.reason);
    }
    // A throw out of the dispatch or its routing (a store, a roster that cannot be read, Z0's own
    // code): never the task's work, so its counted dispatch is refunded and no lesson is written.
    const fault = asharaFaultOf(e, "run or route the dispatch");
    deps.logger.error("delivery.dispatch-threw", "the dispatch threw, Ashara's own fault, routed uncharged", { taskId: task.id, attempt }, e);
    await haltOnProjectRefusal(deps, task, e);
    await routeAsInfrastructureFault(routingDeps, workItem, fault, "counted");
    return { taskId: task.id, status: "interrupted", detail: fault.reason };
  }
  const { result, outcome, errorEnvelope: execEnvelope, verdict, routedHere } = executed;

  // The target project path is minted, validated, and recorded on the project
  // inside resolveTargetProjectPath, its single writer.

  // Salvage check for completed results: when the agent succeeded but the item
  // was preempted to Abandoned (by HTTP PATCH) during
  // execution, the completion routing catches the InvalidStatusTransition from routeAsSuccess
  // and returns a completed result. The result's value — "the work is done" — must
  // be durably recorded on the Abandoned item so cascade-completion (deliveredItsWork)
  // can see the work was done without reopening the terminal status.
  if (result.status === "completed") {
    const currentForSalvage = await PlanningService.findWorkItem(deps.workItemRepo, task.id);
    if (currentForSalvage && currentForSalvage.status === "Abandoned") {
      await salvagePreemptedResult(deps, currentForSalvage, "completed", result.detail);
    }
  }

  // An item routed here is parked at Blocked, given up, or back at Pending (or was left where an
  // owner moved it): nothing to route or salvage.
  if (routedHere) {
    return result;
  }

  if (result.status === "failed" || result.status === "blocked") {
    if (verdict === undefined) throw new FailureVerdictMissing(task.id, result.status);
    let current = await PlanningService.findWorkItem(deps.workItemRepo, task.id);
    if (current && current.status === "InProgress") {
      await handleTaskError(deps, task, verdict);
      current = await PlanningService.findWorkItem(deps.workItemRepo, task.id);
    }
    // Exhaustive over WorkItemStatus: adding a status without a case here is
    // a compile error, not a new silent fall-through. The routing commits the
    // WorkItem to Failed for BOTH failed and blocked TaskResults from an agent
    // dispatch (a "blocked" result is a routine agent outcome — a BLOCKED:
    // marker or turn-limit — not a dependency wait). Blocked status is reached
    // only by the parked dispatch outcomes (routeAsParked), which returned
    // above. Any item that landed at Failed is routed through
    // the FailureRouter so it recovers (replan) or terminates
    // (abandon) rather than sitting in Failed and deadlocking its
    // dependents.
    if (!current) {
      deps.logger.warn(
        "delivery.item-vanished",
        `work item vanished after agent returned (result: ${result.status}); dispatchCount already incremented, agent spend unrecoverable`,
        { taskId: task.id, result: result.status },
      );
    } else {
      switch (current.status) {
        case "Failed": {
          const failure: RawFailureContext = {
            detail: result.detail,
            // With no envelope, the attempt's Outcome as plain data: its claim, read as no verdict.
            raw: execEnvelope ? { ...execEnvelope } : outcome !== null ? { ...toRecordedOutcome(outcome) } : {},
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
              logger: deps.logger,
            },
            current,
            failure,
            verdict,
          );
          // Every FailureRouter decision here (replan/abandon) means
          // this dispatch attempt did not succeed: capture it as a
          // failed_approaches lesson so a later brief sees WHY, closing the gap
          // where only a THROWN orchestrator error (the catch block below) ever
          // reached recordFailedApproach. This is the ONLY call site that writes
          // for the typed-failed-results path — the catch block's own
          // recoverFailedItem call does not, so a thrown error never
          // double-writes.
          await recordFailedApproach(
            deps.failedApproachRepo,
            current,
            () => findEpicId(deps.workItemRepo, current),
            failure.detail,
            { action, attempts },
          );
          break;
        }

        case "InProgress":
          // handleTaskError was called but the concurrent pre-image guard
          // rejected the save — another writer moved the item first. The
          // startup reconciler will requeue on next restart.
          deps.logger.warn(
            "delivery.result-discarded",
            `work item still InProgress after handleTaskError (expected Failed); agent result (${result.status}) discarded — ` +
              `startup reconciler will requeue on next restart`,
            { taskId: task.id, result: result.status, status: current.status },
          );
          break;

        case "Completed":
        case "Pending":
        case "Blocked":
          // Preempted to a non-Abandoned, non-Failed status. The agent's
          // result is not routable. dispatchCount was already incremented.
          deps.logger.warn(
            "delivery.result-discarded",
            `work item preempted: expected Failed, found "${current.status}" after agent returned (result: ${result.status}); ` +
              `agent result discarded, dispatchCount already incremented, agent spend unrecoverable`,
            { taskId: task.id, result: result.status, status: current.status },
          );
          break;

        case "Abandoned": {
          // Preempted to Abandoned while the agent was executing. The
          // agent's result has value: persist it on the existing
          // blockedReason so cascade-completion can see the work's
          // outcome without reopening the terminal status.
          const outcomeKind = result.status === "blocked" ? "blocked" as const : "failed" as const;
          await salvagePreemptedResult(deps, current, outcomeKind, result.detail);
          await recordFailedApproach(
            deps.failedApproachRepo,
            current,
            () => findEpicId(deps.workItemRepo, current),
            result.detail,
            `Preempted to Abandoned during execution (result: ${result.status}). ` +
            `Agent spend incurred, result salvaged.`,
          );
          break;
        }

        default: {
          const _exhaustive: never = current.status;
          throw new UnhandledWorkItemStatus(task.id, "processTask post-agent ladder", _exhaustive);
        }
      }
    }
  }

  return result;
}

async function handleTaskError(deps: CoreLoopDeps, task: WorkItem, verdict: FailureVerdict): Promise<void> {
  // Commit the Failed transition first, then publish best-effort. A publish
  // failure must not re-drive the domain fallback onto an already-Failed item
  // (Failed->Failed) — the transition is durable independent of the audit
  // publish.
  let events: DomainEvent[];
  try {
    events = await PlanningService.route(deps.workItemRepo, task.id, verdict);
  } catch (e) {
    // eslint-disable-next-line ashara/catch-continue -- best effort: a failed route falls back to the domain method below, which commits the Failed transition itself and propagates its own failure
    deps.logger.warn("delivery.route-failed", "lifecycle route failed, falling back to domain method", { taskId: task.id }, e);
    const item = await PlanningService.findWorkItem(deps.workItemRepo, task.id);
    if (!item || !canTransitionTo(item.status, "Failed")) {
      events = [];
    } else {
      const previousStatus = item.status;
      failWorkItem(item, { source: "orchestrator_error", reason: "orchestrator error" }, verdict);
      await PlanningService.saveWorkItem(deps.workItemRepo, item, previousStatus);
      events = takeEvents(item);
    }
  }
  await publishBestEffort(deps, task.id, events, "execution.handleTaskError");
}

/**
 * Recovers from a THROWN orchestrator error during `processTask` (as opposed to a typed TaskResult,
 * which processTask routes itself, its own throws included): the throw is Ashara's own fault, never
 * the task's work, so no lesson is written for it. An item left InProgress is
 * requeued uncharged as Ashara's fault (counted on its fault budget), its dispatch given back with
 * the requeue when the throw came out of a dispatch the seam counted (CountedDispatchThrew): a
 * routing whose write faulted wrote neither its transition nor its refund. An item the
 * agent's failure already committed to Failed is routed through the FailureRouter, so it neither
 * strands at Failed nor deadlocks its dependents. Fully fail-closed: if recovery itself throws, the
 * item is left for the STARTUP reconciler and the caller's cycle loop continues.
 */
export async function handleProcessingError(
  deps: CoreLoopDeps,
  task: WorkItem,
  thrown: unknown,
): Promise<TaskResult> {
  const dispatch = thrown instanceof CountedDispatchThrew ? "counted" : "not-counted";
  const error = thrown instanceof CountedDispatchThrew ? thrown.thrown : thrown;
  deps.logger.error("delivery.processing-failed", `task processing failed with orchestrator error (dispatch ${dispatch})`, { taskId: task.id, dispatch }, error);
  const fault = asharaFaultOf(error, "process the task");

  try {
    await haltOnProjectRefusal(deps, task, error);
    const current = await PlanningService.findWorkItem(deps.workItemRepo, task.id);
    if (!current) {
      deps.logger.warn("delivery.item-vanished", "work item vanished during orchestrator error recovery; item left for startup reconciler", { taskId: task.id });
    } else {
      // Exhaustive over WorkItemStatus so a new member is a compile error here, not a silent skip.
      switch (current.status) {
        case "InProgress":
          await routeAsInfrastructureFault(routingDepsOf(deps), current, fault, dispatch);
          break;

        case "Failed":
          // Routed by the verdict saved with its Failed transition, which survives the interruption.
          await recoverParkedFailedItem(
            {
              workItemRepo: deps.workItemRepo,
              eventPublisher: deps.eventStore,
              failureRouter: deps.failureRouter,
              projects: deps.projectRepo,
              logger: deps.logger,
            },
            current,
            { detail: `the routing of this task's failed attempt was interrupted by Ashara's own fault: ${fault.reason}`, raw: {} },
          );
          break;

        case "Completed":
        case "Pending":
        case "Blocked":
        case "Abandoned":
          deps.logger.info("delivery.recovery-skipped", `work item at "${current.status}" during error recovery: nothing to route, recovery skipped`, {
            taskId: task.id,
            status: current.status,
          });
          break;

        default: {
          const _exhaustive: never = current.status;
          throw new UnhandledWorkItemStatus(task.id, "handleProcessingError", _exhaustive);
        }
      }
    }
  } catch (recoveryError) {
    // eslint-disable-next-line ashara/catch-continue -- best effort: the recovery of a thrown orchestrator error failed: the item stays InProgress, the crash-orphan state the startup reconciler settles from main, and the result returned is interrupted, never a success
    deps.logger.error("delivery.recovery-failed", "recovery after orchestrator error failed; item left for the startup reconciler", { taskId: task.id }, recoveryError);
  }

  return { taskId: task.id, status: "interrupted", detail: fault.reason };
}

/** A work item status no arm of a status ladder handles: the ladder fell behind the status vocabulary. */
class UnhandledWorkItemStatus extends Error {
  constructor(
    readonly taskId: string,
    readonly ladder: string,
    readonly status: unknown,
  ) {
    super(`[${taskId}] unhandled work item status in ${ladder}: ${String(status)}`);
    this.name = "UnhandledWorkItemStatus";
  }
}
