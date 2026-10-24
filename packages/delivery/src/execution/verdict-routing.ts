import type { DomainEvent } from "@ashara/shared";
import { describeErrorChain } from "@ashara/shared";
import type { MergeKind } from "../work-item-language/blocked-reason.js";
import type { ErrorEnvelope, Outcome } from "../acl/workplace-acl.js";
import { InvalidStatusTransition, canTransitionTo } from "../work-item-language/transitions.js";
import type { WorkItem } from "../domain/index.js";
import { PlanningService, failWorkItem, takeEvents } from "../domain/index.js";
import type { FailureVerdict } from "../acl/quality-acl.js";
import type { DispatchSteps, TaskRefusal, TaskResult } from "../types.js";
import { blockedResult, completedResult, failedResult } from "../types.js";
import { publishBestEffort } from "./audit-events.js";
import { configurationRefusal, workBudgetGiveUp } from "./give-up-causes.js";
import type { InfrastructureFault } from "./halt-causes.js";
import { INFRASTRUCTURE_FAULT_BUDGET, haltOnFaultBudget, haltOnRefusal } from "./halt-causes.js";
import { MERGE_RECORD_BACKOFF_MS, recordMergeWithRetry } from "./merge-record.js";
import { mainHoldsNoMergeOf, routeAsParked, routeAsSuccess } from "./main-settle.js";
import {
  requeueOnAbsence,
  routeAsAwaitingClient,
  routeAsAwaitingWork,
  routeAsContextExceeded,
  routeAsDisputed,
  routeAsEnvironmentChange,
  routeAsGivenUp,
  routeAsRequeued,
  routeAsStaleChecks,
  routeAsSuiteReview,
} from "./reopen-routes.js";
import type { ExecutionRoutingDeps } from "./routing-deps.js";

/** What a dispatch returned. */
type DispatchResult = Awaited<ReturnType<DispatchSteps["dispatchService"]["execute"]>>;

/** A dispatch's result once routed. */
export interface RoutedExecution {
  readonly result: TaskResult;
  readonly outcome: Outcome | null;
  readonly errorEnvelope?: ErrorEnvelope;
  /** Quality's verdict on an attempt that failed or blocked and was not routed here. */
  readonly verdict?: FailureVerdict;
  /**
   * The item was routed here: parked at Blocked (a merge unrecorded), given up (an environment
   * undefined, an owner unresolved, a bound past, a check task that cannot be reopened), or returned
   * to Pending (a refusal, a shutdown, an infrastructure fault, stale checks being rewritten), so
   * processTask must not run the failed/blocked recovery ladder on it.
   */
  readonly routedHere: boolean;
}

/** A result routed here, with the dispatch's outcome and envelope. */
function routedHere(executed: Exclude<DispatchResult, { status: "completed" }>, result: TaskResult): RoutedExecution {
  return { result, outcome: executed.outcome, errorEnvelope: executed.errorEnvelope, routedHere: true };
}

/** Routes what a dispatch returned to the item's next status, by the result's kind. */
export async function routeExecution(deps: ExecutionRoutingDeps, task: WorkItem, executed: DispatchResult): Promise<RoutedExecution> {
  switch (executed.status) {
    case "environment_change_requested":
      // Not a failure to retry: only environment work may change the recipe, so a replan would
      // meet the same refusal. An environment task is opened for the platform role and the item
      // waits on it, within a bound; its branch is already deleted, so it
      // restarts from main once the environment has changed.
      await routeAsEnvironmentChange(deps, task, executed);
      return routedHere(executed, blockedResult(task.id, executed.detail));

    case "checks_stale":
      // Not a task failure (a replan keeps the item id, so it would meet the same checks): the
      // check task is reopened to write them again and the item waits on it, within a bound.
      await routeAsStaleChecks(deps, task.id, executed);
      return routedHere(executed, blockedResult(task.id, executed.detail));

    case "disputed":
      // Not a task failure and no lesson: the check is its author's to
      // answer, so the check task is reopened with the dispute and the item waits on it, within a
      // bound of disputes per check task; past it the item is given up and its plan repaired.
      await routeAsDisputed(deps, task, executed);
      return routedHere(executed, blockedResult(task.id, executed.detail));

    case "suite_review_problems":
      // Not the review's failure and no lesson: the checks are their
      // authors' to fix, so each named check task is reopened with the findings and the review waits
      // on them to read the new suites, each check task reopened at most once; past that the review
      // is given up and its plan repaired.
      await routeAsSuiteReview(deps, task, executed);
      return routedHere(executed, blockedResult(task.id, executed.detail));

    case "environment_blocked":
      // Not a task failure: the machines the task runs on, or Ashara's own Z0 machinery, failed, so
      // the attempt is not charged and the item goes back to Pending, within its fault budget; past it
      // the project halts under the fault's class (routeAsInfrastructureFault).
      await routeAsInfrastructureFault(deps, task, { class: executed.fault, unavailable: executed.unavailable, reason: executed.detail }, "counted");
      return routedHere(executed, { taskId: task.id, status: "interrupted", detail: executed.detail });

    case "environment_undefined":
      // Not a task failure, so never Failed: a re-dispatch meets the same main. Nothing re-defines or
      // rebuilds main's environment while every environment task is done, so the task is given up
      // and its plan repaired, which can plan a new environment (no item waits on a person). No
      // agent ran, so the dispatch is given back: the count is attempts at the task's work.
      await routeAsGivenUp(deps, task.id, { source: "environment_undefined", reason: executed.detail }, "refund");
      return routedHere(executed, blockedResult(task.id, executed.detail));

    case "owner_unresolved":
      // No roster role can work the task: a re-dispatch meets the same owner and the same roster,
      // and no production path appends a roster revision after the first, so the task is given up,
      // never Failed, and its plan repaired: the repair staffs its new tasks from the latest roster.
      // No agent ran, so the dispatch is given back.
      await routeAsGivenUp(
        deps,
        task.id,
        { source: "owner_unresolved", ownerRoleId: executed.ownerRoleId, rosterRevision: executed.rosterRevision, reason: executed.reason },
        "refund",
      );
      return routedHere(executed, blockedResult(task.id, executed.detail));

    case "interrupted":
      // The shutdown stopped the attempt; it did not fail. No FailureRouter and no lesson: the
      // item goes back to Pending now with its dispatch refunded, so the startup reconciler
      // finds nothing InProgress to requeue and nothing Failed to route. No counter of its own bounds
      // these requeues: the work ledger does, since a refund returns no request drawn, and
      // the task whose budget they spend is given up as work_budget_spent.
      await routeAsRequeued(deps, { task, why: "a shutdown interrupted its attempt", site: "execution.routeAsInterrupted", write: { kind: "refund" } });
      return routedHere(executed, { taskId: task.id, status: "interrupted", detail: executed.detail });

    case "context_exceeded":
      // Not a task failure and no lesson: the same model meets the same window again, so the
      // FailureRouter's replan would only spend the work ledger on it (a
      // bound reached escalates). The task goes on to a model whose window is larger, or is given up.
      await routeAsContextExceeded(deps, task, executed);
      return routedHere(executed, blockedResult(task.id, executed.detail));

    case "no_wider_model":
      // The catalog holds no model whose window is larger than one the task overflowed, and every
      // re-dispatch meets the same catalog: given up, never requeued nor a fault of Ashara's, and its
      // plan repaired, which can cut the work smaller. No agent ran, so the dispatch is given back.
      await routeAsGivenUp(
        deps,
        task.id,
        { source: "no_wider_model", overflowedWindowTokens: executed.overflowedWindowTokens, reason: executed.detail },
        "refund",
      );
      return routedHere(executed, blockedResult(task.id, executed.detail));

    case "prerequisite_needed":
      // Not a task failure and no lesson: what it needs is another task's to deliver, so it waits for
      // that task at Pending, its dispatch given back, never counted toward its give-up; with no task to
      // deliver it, the plan has a gap and is repaired.
      await routeAsAwaitingWork(deps, task, executed);
      return routedHere(executed, blockedResult(task.id, executed.detail));

    case "client_decision_needed":
      // Not a task failure and no lesson: the decision is the client's, so the question goes to the
      // client and the item holds for the answer, its dispatch given back, never counted toward its give-up.
      await routeAsAwaitingClient(deps, task, executed);
      return routedHere(executed, blockedResult(task.id, executed.detail));

    case "refused":
      return routeAsRefused(deps, task, executed);

    case "completed":
      return routeAsCompleted(deps, task, executed);

    case "failed":
    case "blocked":
      await routeAsFailure(deps, task, executed.verdict);
      return {
        result: executed.status === "blocked" ? blockedResult(task.id, executed.detail) : failedResult(task.id, executed.detail),
        outcome: executed.outcome,
        errorEnvelope: executed.errorEnvelope,
        verdict: executed.verdict,
        routedHere: false,
      };
  }
}

/**
 * One rule for every refusal: no lesson, no failure router, the dispatch given back. A
 * refusal no spend cap made (an unpriced model, an unestimable cost) is a configuration
 * fault a re-dispatch would meet again, so the project is blocked until the owner fixes it.
 */
async function routeAsRefused(deps: ExecutionRoutingDeps, task: WorkItem, executed: Extract<DispatchResult, { status: "refused" }>): Promise<RoutedExecution> {
  const refusal: TaskRefusal = deps.spendCap.refusalOf(executed.refusal) ?? configurationRefusal(task, executed.refusal);
  if (refusal.kind === "task_work") {
    // The task's model requests are spent (the work ledger): no grant raises a
    // task's budget, so a re-dispatch meets the same refusal. Given up, never requeued, and its
    // plan repaired; the dispatch is given back, since its attempt was not found wanting.
    await routeAsGivenUp(deps, task.id, workBudgetGiveUp(refusal), "refund");
    return routedHere(executed, blockedResult(task.id, executed.detail));
  }
  await haltOnRefusal(deps, task, refusal);
  const cap =
    refusal.kind === "project"
      ? `project ${refusal.projectId}'s spend cap`
      : refusal.kind === "deployment"
        ? "the deployment's spend cap"
        : refusal.kind === "project_work"
          ? `project ${refusal.projectId}'s work budget`
          : `a configuration fault (${refusal.errorClass})`;
  // These requeues have no counter of their own: each refusal here halts the project
  // (its spend cap, its work budget, its configuration) or stops the loop (the deployment's cap),
  // so the task is dispatched again only after a person's grant or unblock.
  await routeAsRequeued(deps, { task, why: `a refusal at ${cap}: ${refusal.reason}`, site: "execution.routeAsRefused", write: { kind: "refund" } });
  return routedHere(executed, { taskId: task.id, status: "refused", detail: executed.detail, refusal });
}

async function routeAsCompleted(deps: ExecutionRoutingDeps, task: WorkItem, executed: Extract<DispatchResult, { status: "completed" }>): Promise<RoutedExecution> {
  const delivered = executed.delivered;
  let onMain: { readonly mergeCommit: string; readonly mergeKind: MergeKind; readonly what: string } | null = null;
  if (delivered.kind === "merged" || delivered.kind === "already-delivered") {
    // The merge record first, whatever the item's status now (a preempted item merged all the
    // same): the task is never Completed without it (Discipline A). The merge is on main, so a
    // record that cannot be written parks the item rather than leaving it InProgress, which the
    // startup reconciler would requeue and so re-dispatch merged work. Work already delivered
    // merged nothing: its record is main's commit its checks passed on.
    const mergeCommit = delivered.kind === "merged" ? delivered.mergeCommit : delivered.mainCommit;
    const mergeKind: MergeKind = delivered.kind === "merged" ? "merged" : "already_delivered";
    const unrecorded = await recordMergeWithRetry(deps, task.id, mergeCommit, mergeKind);
    const what = delivered.kind === "merged" ? `merged on main as ${mergeCommit}` : `already delivered on main at ${mergeCommit}`;
    if (unrecorded !== null) {
      const detail = `${what}, but the merge record could not be written: ${unrecorded}`;
      await routeAsParked(deps, task.id, { source: "merge_unrecorded", mergeCommit, mergeKind, reason: detail });
      return { result: blockedResult(task.id, detail), outcome: executed.outcome, routedHere: true };
    }
    onMain = { mergeCommit, mergeKind, what };
  }
  try {
    // Work on main is retried within the merge record's bound: a throw here would reach
    // processTask as Ashara's fault, which requeues the task and so redoes merged work.
    await routeAsSuccess(deps, task, onMain === null ? 1 : MERGE_RECORD_BACKOFF_MS.length + 1);
  } catch (e) {
    // The item's status changed while the agent was executing (e.g., preempted
    // to Abandoned by HTTP PATCH). The agent's work
    // succeeded; processTask reloads the item and salvages the result based on
    // its actual status. Any other error must still propagate, but work on main is
    // parked as merge_unrecorded, whose exit completes it, never requeued.
    // eslint-disable-next-line no-restricted-syntax -- not a reopen: a rejected completion is salvaged by processTask, and any other throw parks work already on main
    if (!(e instanceof InvalidStatusTransition)) {
      if (onMain === null) throw e;
      const detail = `${onMain.what} and recorded, but the task could not be Completed: ${describeErrorChain(e)}`;
      await routeAsParked(deps, task.id, { source: "merge_unrecorded", mergeCommit: onMain.mergeCommit, mergeKind: onMain.mergeKind, reason: detail });
      return { result: blockedResult(task.id, detail), outcome: executed.outcome, routedHere: true };
    }
    deps.logger.warn("delivery.transition-rejected", `completion route rejected (${e.from} -> Completed); agent succeeded, processTask will handle salvage`, {
      taskId: task.id,
      from: e.from,
      to: "Completed",
    }, e);
  }
  return {
    result: completedResult(task.id, executed.detail),
    outcome: executed.outcome,
    routedHere: false,
  };
}

/**
 * A fault under a dispatch that is not the task's work:
 * the substrate's or Ashara's own Z0 machinery. Main is read first (mainHoldsNoMergeOf): a fault
 * after the merge commit leaves merged work behind, which is settled there, never counted as a
 * fault nor requeued. Otherwise the fault is counted on the task, durably, and the attempt is not
 * charged and no lesson is written. Within the budget the item goes back to Pending (its dispatch
 * refunded when the seam `counted` it). The fault past the budget halts the project under its
 * class, with one report, and requeues the item the same way: a substrate fault on
 * infrastructure, which the substrate probe resumes; Ashara's own, or its model provider's, as a
 * fault, which the operator repairs. A fault after that gives the item up: the halt could not wait it out.
 */
export async function routeAsInfrastructureFault(
  deps: ExecutionRoutingDeps,
  task: WorkItem,
  fault: InfrastructureFault,
  dispatch: "counted" | "not-counted",
): Promise<void> {
  const absent = await mainHoldsNoMergeOf(deps, task, `a fault that was not its work (${fault.class}: ${fault.unavailable} unavailable)`);
  if (absent === null) return;
  const faults = await deps.workItemRepo.recordInfrastructureFault(task.id);
  if (faults > INFRASTRUCTURE_FAULT_BUDGET + 1) {
    await routeAsGivenUp(deps, task.id, {
      source: "environment_unavailable",
      unavailable: fault.unavailable,
      reason:
        fault.class === "substrate"
          ? `infrastructure fault ${faults} on this task, after its project halted on infrastructure at fault ` +
            `${INFRASTRUCTURE_FAULT_BUDGET + 1} and the substrate probe resumed it: ${fault.reason}`
          : `fault ${faults} on this task that was not its work (${fault.class}), after its project halted at fault ` +
            `${INFRASTRUCTURE_FAULT_BUDGET + 1} and was returned to work: ${fault.reason}`,
    }, dispatch === "counted" ? "refund" : "keep");
    return;
  }
  const why = `infrastructure fault ${faults} of ${INFRASTRUCTURE_FAULT_BUDGET} (${fault.class}: ${fault.unavailable} unavailable)`;
  await requeueOnAbsence(
    deps,
    dispatch === "counted"
      ? { task, why, site: "execution.routeAsInfrastructureFault", write: { kind: "refund" } }
      : { task, why, site: "execution.requeueUncounted", write: { kind: "save" } },
    absent,
  );
  if (faults > INFRASTRUCTURE_FAULT_BUDGET) await haltOnFaultBudget(deps, task, faults, fault);
}

async function routeAsFailure(deps: ExecutionRoutingDeps, task: WorkItem, verdict: FailureVerdict): Promise<void> {
  // The state commit and the audit publish are kept separate: the Failed
  // transition is committed first, then events are published best-effort. A
  // publish failure must NOT re-drive the domain fallback (that would call
  // failWorkItem on an already-Failed item and throw Failed->Failed) — the
  // transition is durable independent of the audit log.
  const events = await commitFailure(deps, task.id, verdict);
  await publishBestEffort(deps, task.id, events, "execution.routeAsFailure");
}

/**
 * Transitions the task to Failed and returns the resulting domain events. Prefers
 * the lifecycle router; on router failure it falls back to the domain method, but
 * only when the live item can still legally transition to Failed — an item already
 * in Failed (or another terminal state) yields no events rather than crashing.
 */
async function commitFailure(
  deps: Pick<ExecutionRoutingDeps, "workItemRepo" | "logger">,
  taskId: WorkItem["id"],
  verdict: FailureVerdict,
): Promise<DomainEvent[]> {
  const { workItemRepo } = deps;
  try {
    return await PlanningService.route(workItemRepo, taskId, verdict);
  } catch (e) {
    deps.logger.warn("delivery.route-failed", "lifecycle route failed, falling back to domain method", { taskId }, e);
    const item = await PlanningService.findWorkItem(workItemRepo, taskId);
    if (!item || !canTransitionTo(item.status, "Failed")) {
      return [];
    }
    const previousStatus = item.status;
    failWorkItem(item, { source: "orchestrator_error", reason: "orchestrator error" }, verdict);
    await PlanningService.saveWorkItem(workItemRepo, item, previousStatus);
    return takeEvents(item);
  }
}
