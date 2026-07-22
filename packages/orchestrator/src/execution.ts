import type { EventStoreRepository } from "@ashara/db";
import type { DomainEvent } from "@ashara/shared";
import type { WorkItem, WorkItemRepository, CoverageHold } from "@ashara/planning";
import {
  PlanningService,
  canTransitionTo,
  failWorkItem,
  takeEvents,
  startWorkItem,
} from "@ashara/planning";
import type { DevelopmentService, TaskDescriptor } from "@ashara/development";
import type { RawFailureContext } from "@ashara/planning";
import { createCoverageRollupGuard } from "@ashara/planning";

import type { TaskResult, TaskCostInfo, CoreLoopDeps } from "./types.js";
import { completedResult, failedResult, blockedResult, zeroCost, costFromOutput } from "./types.js";
import { findEpicId, resolveTargetProjectPath, recordFailedApproach, composeRoutedLesson } from "./task-helpers.js";
import { recoverFailedItem, shouldSplit, splitFailedTask } from "@ashara/planning";

export interface ExecutionRoutingDeps {
  readonly workItemRepo: WorkItemRepository;
  readonly eventStore: EventStoreRepository;
  /**
   * Coverage HOLD (mig9-t2): consulted during cascade-completion so a parent does
   * not settle Completed while its project has an open contract coverage gap.
   * Undefined in observe-only mode (no hold).
   */
  readonly coverageHold?: CoverageHold;
}

export async function executeTask(
  deps: ExecutionRoutingDeps,
  developmentService: DevelopmentService,
  task: WorkItem,
  targetProjectPath: string | null,
): Promise<{
  result: TaskResult;
  output: Record<string, unknown>;
  attempt: number;
}> {
  // Walked up here (not inside @ashara/development, which has no dependency on
  // @ashara/planning) so storeKnowledge/storeFailureKnowledge scope
  // knowledge_entries by the true Epic, not the Story task.parentId points at
  // (kl-t2/Q5 — the epic_id mis-write that made recentFindings effectively
  // globally scoped across projects).
  const epicId = await findEpicId(deps.workItemRepo, task);

  const taskDescriptor: TaskDescriptor = {
    id: task.id,
    title: task.title,
    parentId: task.parentId,
    taskSpec: task.taskSpec as Record<string, unknown> | undefined,
    // Carries FailureRouter's replan context (Failed -> Pending via
    // applyReplan) through to buildBrief, so a replanned attempt is informed
    // by why the prior attempt failed instead of repeating it identically.
    blockedReason: task.blockedReason,
    epicId,
  };

  const execResult = await developmentService.execute(taskDescriptor, targetProjectPath);

  if (execResult.status === "completed") {
    await routeAsSuccess(deps, task);
    return {
      result: completedResult(task.id),
      output: execResult.output,
      attempt: execResult.attempt,
    };
  }

  await routeAsFailure(deps, task);

  if (execResult.status === "blocked") {
    return {
      result: blockedResult(task.id, execResult.detail),
      output: execResult.output,
      attempt: execResult.attempt,
    };
  }

  return {
    result: failedResult(task.id, execResult.detail),
    output: execResult.output,
    attempt: execResult.attempt,
  };
}

async function routeAsSuccess(deps: ExecutionRoutingDeps, task: WorkItem): Promise<void> {
  const events = await PlanningService.route(deps.workItemRepo, task.id, true, deps.coverageHold);
  for (const event of events) {
    await deps.eventStore.publish(event, "Internal");
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
    failWorkItem(item, { reason: "orchestrator error" });
    await PlanningService.saveWorkItem(workItemRepo, item, previousStatus);
    return takeEvents(item);
  }
}

async function publishBestEffort(
  eventStore: EventStoreRepository,
  workItemId: string,
  events: DomainEvent[],
  site: string,
): Promise<void> {
  for (const event of events) {
    try {
      await eventStore.publish(event, "Internal");
    } catch (publishError) {
      console.warn(
        `[${site}] failed to publish audit event for ${workItemId} (status transition already committed):`,
        publishError,
      );
    }
  }
}

export async function processTask(
  deps: CoreLoopDeps,
  task: WorkItem,
): Promise<{ result: TaskResult; costInfo: TaskCostInfo }> {
  const workItem = await PlanningService.findWorkItem(deps.workItemRepo, task.id);
  if (!workItem) {
    return {
      result: blockedResult(task.id, "work item not found"),
      costInfo: zeroCost(),
    };
  }
  if (workItem.status !== "Pending") {
    return {
      result: blockedResult(task.id, "task already picked up by another cycle"),
      costInfo: zeroCost(),
    };
  }

  const previousStatus = workItem.status;
  startWorkItem(workItem);
  await PlanningService.saveWorkItem(deps.workItemRepo, workItem, previousStatus);
  const startEvents = takeEvents(workItem);
  const ancestorEvents = await PlanningService.activateAncestors(deps.workItemRepo, workItem.parentId);
  for (const event of [...startEvents, ...ancestorEvents]) {
    await deps.eventStore.publish(event, "Internal");
  }

  const targetProjectPath = await resolveTargetProjectPath(deps.visionRepo, deps.config.workdirBase);
  const routingDeps: ExecutionRoutingDeps = {
    workItemRepo: deps.workItemRepo,
    eventStore: deps.eventStore,
    coverageHold: buildCoverageHold(deps),
  };

  // DISPATCH SEAM (migration 018, r9f-t1). The item is now committed InProgress and
  // is about to be handed to the agent. Bump the dispatch counter with a single
  // atomic UPDATE BEFORE executeTask, so the attempt is recorded even if the agent
  // crashes, its output is discarded, or any downstream step throws — the exact
  // Run-9 hole where a discarded output left the retry bound reading zero forever.
  // This is the ONE place a dispatch is counted; every retry-bound consumer
  // (FailureRouter recovery, startup reconciler, termination snapshot) reads the
  // resulting dispatch_count off the reloaded WorkItem.
  await deps.workItemRepo.incrementDispatchCount(task.id);

  const { result, output, attempt } = await executeTask(
    routingDeps,
    deps.developmentService,
    task,
    targetProjectPath,
  );
  const costInfo = costFromOutput(output, attempt);

  // The target project path is now minted, validated, and persisted as the
  // source of truth inside resolveTargetProjectPath (single persist point).
  // The former completion-gated persist here was a redundant duplicate
  // writer against the same DB row and has been removed.

  if (result.status === "failed" || result.status === "blocked") {
    let current = await PlanningService.findWorkItem(deps.workItemRepo, task.id);
    if (current && current.status === "InProgress") {
      await handleTaskError(deps, task);
      current = await PlanningService.findWorkItem(deps.workItemRepo, task.id);
    }
    // executeTask commits the WorkItem to status Failed for BOTH failed and
    // blocked TaskResults (a "blocked" result is a routine agent outcome —
    // a BLOCKED: marker or turn-limit — not a dependency wait; dependency
    // Blocked status is only reachable via the HTTP PATCH path). Any item that
    // landed at Failed is routed through the FailureRouter so it recovers
    // (replan) or terminates (abandon/substitute) rather than sitting in Failed
    // and deadlocking its dependents (Run-8 C2, migration Phase 6).
    if (current && current.status === "Failed") {
      const failure: RawFailureContext = { detail: result.detail, raw: output };
      // dispatchCount was already incremented for this attempt at the dispatch
      // seam above and is not mutated by recoverFailedItem, so it is the exact
      // "attempts so far" count recoverFailedItem itself reads as priorAttempts.
      const attempts = current.dispatchCount;
      const finishReason = typeof output.finish_reason === "string" ? output.finish_reason : "unknown";
      const filesChanged = Array.isArray(output.files_changed) ? output.files_changed.length : 0;

      // Split-on-failure: agent hit turn limit while making progress (files
      // changed) — structurally "too big," not a specific bug.
      if (shouldSplit(finishReason, filesChanged, current)) {
        await splitFailedTask({ workItemRepo: deps.workItemRepo, eventPublisher: deps.eventStore }, current, failure);
        await recordFailedApproach(
          deps.failedApproachRepo,
          deps.workItemRepo,
          current,
          failure.detail,
          `Task split: agent hit turn limit (finish_reason=${finishReason}) with ${filesChanged} files changed.`,
        );
      } else {
        const action = await recoverFailedItem(
          {
            workItemRepo: deps.workItemRepo,
            eventPublisher: deps.eventStore,
            failureRouter: deps.failureRouter,
            contractLookup: deps.contractLookup,
          },
          current,
          failure,
        );
        // Every FailureRouter decision here (replan/abandon/substitute) means this
        // dispatch attempt did not succeed (kl-t1): capture it as a failed_approaches
        // lesson so a later brief sees WHY, closing the gap where only a THROWN
        // orchestrator error (the catch block below) ever reached
        // recordFailedApproach. This is the ONLY call site that writes for the
        // typed-failed-results path — the catch block's own recoverFailedItem call
        // does not, so a thrown error never double-writes.
        await recordFailedApproach(
          deps.failedApproachRepo,
          deps.workItemRepo,
          current,
          failure.detail,
          composeRoutedLesson(current.title, action, attempts, failure.detail),
        );
      }
    }
  }

  return { result, costInfo };
}

export async function handleTaskError(deps: CoreLoopDeps, task: WorkItem): Promise<void> {
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
      failWorkItem(item, { reason: "orchestrator error" });
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
  const result = failedResult(task.id, String(error));
  await recordFailedApproach(deps.failedApproachRepo, deps.workItemRepo, task, String(error));

  try {
    const current = await PlanningService.findWorkItem(deps.workItemRepo, task.id);
    if (current && current.status === "Failed") {
      await recoverFailedItem(
        {
          workItemRepo: deps.workItemRepo,
          eventPublisher: deps.eventStore,
          failureRouter: deps.failureRouter,
          contractLookup: deps.contractLookup,
        },
        current,
        { detail: String(error), raw: { orchestratorError: String(error) } },
      );
    }
  } catch (recoveryError) {
    console.warn(
      `[${task.id}] recovery after orchestrator error failed; item left at Failed for the startup reconciler:`,
      recoveryError,
    );
  }

  return result;
}

/** The coverage HOLD predicate for this cycle, or undefined (no repo / observe-only). */
function buildCoverageHold(deps: CoreLoopDeps): CoverageHold | undefined {
  if (!deps.contractRepo) return undefined;
  return createCoverageRollupGuard({
    workItemRepo: deps.workItemRepo,
    contractRepo: deps.contractRepo,
    enforcing: deps.config.coverageEnforcing,
  });
}
