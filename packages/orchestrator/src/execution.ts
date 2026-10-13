import type { EventStoreRepository } from "@ashara/db";
import type { DomainEvent, StoredBlockedReason } from "@ashara/shared";
import { wrapError, InvalidStatusTransition, withSalvagedResult, canTransitionTo } from "@ashara/shared";
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
} from "./acl/planning-acl.js";
import type { TaskDescriptor } from "./acl/development-acl.js";
import type { TaskResult, CoreLoopDeps, SpendRefusal } from "./types.js";
import { completedResult, failedResult, blockedResult } from "./types.js";
import { findEpicId, resolveTargetProjectPath, recordFailedApproach, composeRoutedLesson } from "./task-helpers.js";

type EnvironmentBlockedReason = Extract<StoredBlockedReason, { source: "environment_unavailable" | "environment_undefined" }>;

interface ExecutionRoutingDeps {
  readonly workItemRepo: WorkItemRepository;
  readonly eventStore: Pick<EventStoreRepository, "publish">;
  readonly spendCap: CoreLoopDeps["spendCap"];
}

async function executeTask(
  deps: ExecutionRoutingDeps,
  developmentService: CoreLoopDeps["developmentService"],
  task: WorkItem,
  targetProjectPath: string | null,
): Promise<{
  result: TaskResult;
  output: AgentOutputJson | null;
  errorEnvelope?: ErrorEnvelope;
  /**
   * The item was routed here, parked at Blocked (environment unavailable or undefined)
   * or returned to Pending (a spend-cap refusal), so processTask must not run the
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
    workKind: task.workKind,
    successCriteria: task.successCriteria ?? [],
  };

  const execResult = await developmentService.execute(taskDescriptor, targetProjectPath);

  if (execResult.status === "environment_blocked" || execResult.status === "environment_undefined") {
    // Not a task failure: re-dispatching cannot make the substrate or the
    // project's environment appear, so the item is parked at Blocked for the
    // operator, never routed to Failed.
    await routeAsEnvironmentBlocked(
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

  if (execResult.status === "refused") {
    const refusal = deps.spendCap.refusalOf(execResult.refusal);
    if (refusal !== null) {
      await routeAsRefused(deps, task.id, refusal);
      return {
        result: { taskId: task.id, status: "refused", detail: execResult.detail, refusal },
        output: execResult.output,
        errorEnvelope: execResult.errorEnvelope,
        routedHere: true,
      };
    }
    // A refusal no spend cap made (an unpriced model): a re-dispatch meets the same price
    // list, so it takes the failure route below, which replans or abandons the item.
  }

  if (execResult.status === "completed") {
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

/**
 * A spend cap refused a model call of this dispatch: no failed approach, so the item
 * goes back to Pending and the dispatch the seam counted is given back. Finance has
 * already blocked the project at a project refusal, so the gate skips the item until
 * the owner returns the project to work; a deployment refusal stops the loop.
 */
async function routeAsRefused(deps: ExecutionRoutingDeps, taskId: WorkItem["id"], refusal: SpendRefusal): Promise<void> {
  const cap = refusal.kind === "project" ? `project ${refusal.projectId}'s spend cap` : "the deployment's spend cap";
  const item = await PlanningService.findWorkItem(deps.workItemRepo, taskId);
  if (!item) {
    console.warn(`[${taskId}] work item vanished before it could be returned to Pending after a refusal at ${cap}: ${refusal.reason}`);
    return;
  }
  const previousStatus = item.status;
  try {
    requeueWorkItem(item);
  } catch (e) {
    if (!(e instanceof InvalidStatusTransition)) throw e;
    console.warn(`[${taskId}] requeue after a refusal at ${cap} rejected (${e.from} -> Pending); item left at ${e.from}: ${refusal.reason}`);
    return;
  }
  await PlanningService.saveWorkItem(deps.workItemRepo, item, previousStatus);
  // A refund that fails leaves the dispatch counted: the retry bound is then charged one
  // attempt too many, the conservative direction, so it is logged and the routing stands.
  let dispatchCount: number | string;
  try {
    dispatchCount = await deps.workItemRepo.refundDispatchCount(taskId);
  } catch (e) {
    dispatchCount = "not refunded";
    console.warn(`[${taskId}] the dispatch refused at ${cap} could not be refunded; it stays counted:`, e);
  }
  console.warn(`[${taskId}] back to Pending after a refusal at ${cap} (dispatch count ${dispatchCount}): ${refusal.reason}`);
  await publishBestEffort(deps.eventStore, taskId, takeEvents(item), "execution.routeAsRefused");
}

/**
 * Parks the item at Blocked with the stated reason. An item that is no longer
 * InProgress (moved by the owner during dispatch) is left where it is: no
 * agent ran, so there is no result to salvage.
 */
async function routeAsEnvironmentBlocked(
  deps: ExecutionRoutingDeps,
  taskId: WorkItem["id"],
  reason: EnvironmentBlockedReason,
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
    console.warn(`[${taskId}] environment block rejected (${e.from} -> Blocked); item left at ${e.from} (${reason.reason})`);
    return;
  }
  await PlanningService.saveWorkItem(deps.workItemRepo, item, previousStatus);
  const what = reason.source === "environment_unavailable" ? `${reason.unavailable} unavailable` : "no environment defined";
  console.warn(`[${taskId}] blocked, ${what}: ${reason.reason}`);
  await publishBestEffort(deps.eventStore, taskId, takeEvents(item), "execution.routeAsEnvironmentBlocked");
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

  const targetProjectPath = await resolveTargetProjectPath(deps.projectRepo, workItem.projectId, deps.config.workdirBase);
  const routingDeps: ExecutionRoutingDeps = {
    workItemRepo: deps.workItemRepo,
    eventStore: deps.eventStore,
    spendCap: deps.spendCap,
  };

  // DISPATCH SEAM (migration 018, r9f-t1). The item is now committed InProgress and
  // is about to be handed to the agent. Bump the dispatch counter with a single
  // atomic UPDATE BEFORE executeTask, so the attempt is recorded even if the agent
  // crashes, its output is discarded, or any downstream step throws — the exact
  // Run-9 hole where a discarded output left the retry bound reading zero forever.
  // This is the ONE place a dispatch is counted; every retry-bound consumer
  // (FailureRouter recovery, startup reconciler) reads the resulting
  // dispatch_count off the reloaded WorkItem.
  await deps.workItemRepo.incrementDispatchCount(task.id);

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

  // An environment-blocked item is already parked at Blocked, a refused one back at
  // Pending (or either was left where an owner moved it): nothing to route or salvage.
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
    // only via the HTTP PATCH path and an environment-blocked dispatch, which
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
