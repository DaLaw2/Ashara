import type { DomainEvent, Logger, ProjectId } from "@ashara/shared";
import { describeErrorChain } from "@ashara/shared";
import type { EventStoreRepository } from "@ashara/db";
import type { StoredBlockedReason } from "./work-item-language/blocked-reason.js";
import type { WorkItemStatus } from "./work-item-language/work-item-status.js";
import { blockedReasonToRecord } from "./work-item-language/blocked-reason.js";
import { TERMINAL_SESSION_PHASES } from "./acl/workplace-acl.js";
import { WorkItemRowCorrupt } from "./work-item-language/work-item-row.js";
import type { DevSessionRepository } from "./acl/workplace-acl.js";
import type { ProjectHaltRepository } from "./repositories/project-halt.js";
import { projectBlockCause } from "./project-halt.js";
import type { WorkItem, WorkItemRepository } from "./domain/index.js";
import type { FailureRouter, RawFailureContext } from "./failure-router.js";
import type { ParkedFailureDeps } from "./lifecycle/failure-recovery.js";
import { blockWorkItem, giveUpWorkItem, PlanningService, requeueWorkItem, takeEvents } from "./domain/index.js";
import { recoverParkedFailedItem } from "./lifecycle/failure-recovery.js";
import { ORPHANED_SESSION_RESOLVER } from "./acl/workplace-acl.js";
import { mergeOnMainOf, OrphanUnreconciled, releaseMergedTask } from "./orphan-merge.js";
import type { TargetPathSource } from "./orphan-merge.js";
import { releaseBranchesOfSettledTasks } from "./settled-branches.js";
import type { SettledTargets } from "./settled-branches.js";

// Delivery's reconcile at startup: its work items, and the branches of those settled. Each other context reconciles its own
// resources in its own call (Workplace its sessions, Execution Infrastructure its cells and task
// worktrees), ordered by the composition root (S9).

interface StartupReconcilerDeps {
  readonly workItemRepo: WorkItemRepository;
  /**
   * Blocks a project one of whose rows does not parse, or whose crash orphan could
   * not be settled; `get` names the target whose main an orphan's merge is read from, and
   * `listWithWorkspace` every target whose settled tasks' branches are released.
   */
  readonly projects: Pick<ProjectHaltRepository, "block"> & TargetPathSource & SettledTargets;
  readonly eventStore: Pick<EventStoreRepository, "publish">;
  readonly failureRouter: FailureRouter;
  /**
   * Whether an orphan's dispatch never finished: its latest session still non-terminal. Read before
   * Workplace's session reconcile closes those sessions.
   */
  readonly devSessionStore: Pick<DevSessionRepository, "dispatchEvidence">;
  /** The workdir base every target workspace lies in (assertValidTargetProjectPath). */
  readonly workdirBase: string;
  readonly logger: Logger;
}

interface ReconcileSummary {
  readonly orphansRequeued: number;
  /** Orphans found InProgress at CRASH_LOOP_BOUND startups in a row: given up (crash_loop), never re-dispatched. */
  readonly orphansGivenUp: number;
  /** Orphans whose merge was found on main: recorded and Completed, never re-dispatched. */
  readonly orphansCompleted: number;
  /** Orphans not settled within the bound: Blocked under a typed cause, never left InProgress. */
  readonly orphansBlocked: number;
  readonly failedReplanned: number;
  readonly failedAbandoned: number;
  /** Parked Failed items whose stored verdict does not parse: left Failed, their project blocked. */
  readonly failedHeld: number;
  readonly failedErrored: number;
  /** Projects blocked because one of their rows does not parse; their items are not reconciled. */
  readonly projectsBlocked: number;
}

/**
 * Each project's items in `status`, read project by project so one corrupt row
 * blocks its own project (recorded durably, logged at warn) and the other
 * projects are still reconciled. A project blocked here yields nothing. Any
 * other failure, a database failure included, throws through.
 */
async function* itemsByProject(
  deps: StartupReconcilerDeps,
  status: WorkItemStatus,
  blocked: Set<ProjectId>,
): AsyncGenerator<WorkItem[]> {
  for (const projectId of await deps.workItemRepo.projectIdsWithStatus(status)) {
    if (blocked.has(projectId)) continue;
    try {
      yield await deps.workItemRepo.findByProjectAndStatus(projectId, status);
    } catch (err) {
      if (!(err instanceof WorkItemRowCorrupt)) throw err;
      blocked.add(projectId);
      const cause = projectBlockCause(err);
      const result = await deps.projects.block(projectId, cause);
      deps.logger.error(
        "delivery.row-corrupt",
        `${cause.errorClass} (item ${err.itemId}, ${err.column}); its ${status} items are not reconciled; project ${projectId} ${result}: ${cause.reason}`,
        { projectId, itemId: err.itemId, column: err.column, status, result },
        err,
      );
    }
  }
}

export async function reconcileWorkItemsOnStartup(deps: StartupReconcilerDeps): Promise<ReconcileSummary> {
  let orphansRequeued = 0;
  let orphansGivenUp = 0;
  let orphansCompleted = 0;
  let orphansBlocked = 0;
  let failedReplanned = 0;
  let failedAbandoned = 0;
  let failedHeld = 0;
  let failedErrored = 0;
  let failedRouted = 0;
  const blockedProjects = new Set<ProjectId>();

  for await (const orphans of itemsByProject(deps, "InProgress", blockedProjects)) {
    for (const orphan of orphans) {
      const settled = await settleOrphan(deps, orphan);
      if (settled === "requeued") orphansRequeued += 1;
      else if (settled === "given-up") orphansGivenUp += 1;
      else if (settled === "completed") orphansCompleted += 1;
      else if (settled === "blocked") orphansBlocked += 1;
    }
  }

  const recoveryDeps: ParkedFailureDeps = {
    workItemRepo: deps.workItemRepo,
    eventPublisher: deps.eventStore,
    failureRouter: deps.failureRouter,
    projects: deps.projects,
    logger: deps.logger,
  };

  for await (const parkedFailed of itemsByProject(deps, "Failed", blockedProjects)) {
    for (const failed of parkedFailed) {
      failedRouted += 1;
      try {
        const action = await recoverParkedFailedItem(recoveryDeps, failed, reconstructFailure(failed));
        if (action === "replan") failedReplanned += 1;
        else if (action === "abandon") failedAbandoned += 1;
        else failedHeld += 1;
      } catch (error) {
        // eslint-disable-next-line ashara/catch-continue -- best effort: the item is counted in failedErrored and left Failed, its recovery retried at the next reconcile
        failedErrored += 1;
        deps.logger.warn("delivery.parked-failed-unrouted", "failed to route parked Failed item; left Failed for the next reconcile", { taskId: failed.id }, error);
      }
    }
  }

  // Last, so a task this pass settled (an orphan Completed, a parked Failed item abandoned) is covered.
  await releaseBranchesOfSettledTasks({ workItemRepo: deps.workItemRepo, projects: deps.projects, workdirBase: deps.workdirBase, logger: deps.logger });

  const summary: ReconcileSummary = {
    orphansRequeued,
    orphansGivenUp,
    orphansCompleted,
    orphansBlocked,
    failedReplanned,
    failedAbandoned,
    failedHeld,
    failedErrored,
    projectsBlocked: blockedProjects.size,
  };
  deps.logger.info(
    "delivery.startup-reconciled",
    `orphans requeued=${orphansRequeued} given-up=${orphansGivenUp} completed=${orphansCompleted} blocked=${orphansBlocked}; ` +
      `parked Failed routed=${failedRouted} (replan=${failedReplanned} abandon=${failedAbandoned} ` +
      `held=${failedHeld} errored=${failedErrored}); ` +
      `projects blocked on a corrupt row=${blockedProjects.size}`,
    { ...summary, failedRouted },
  );
  return summary;
}

/**
 * Crash-orphaned dispatches of one task given back before a further one is left counted: a task
 * whose dispatch keeps dying with the process may be what kills it, and a refund every time would
 * leave its retry bound unmoved. CRASH_LOOP_BOUND, below, ends the re-dispatches themselves.
 */
const MAX_ORPHAN_REFUNDS = 1;

/**
 * Policy: the waits between attempts at settling one crash orphan, and at blocking it; three
 * attempts each. A store or a git call that fails once is retried, never taken as the answer.
 */
const ORPHAN_BACKOFF_MS: readonly number[] = [100, 500];

/**
 * Policy default (a bound that stays as an early stop inside the work ledger): the startups in a
 * row that may find one task InProgress before it is given up (crash_loop) instead of requeued. A task left InProgress by a dead process twice running, with no
 * dispatch of it ending in between, is taken as the dispatch that kills the process. A requeue at
 * every restart ends here first; the work ledger bounds it too, since a dead process's
 * requests stay drawn and a task whose budget they spent is given up (work_budget_spent).
 */
const CRASH_LOOP_BOUND = 2;

type Settled = "requeued" | "given-up" | "completed" | "blocked" | "moved";

/**
 * Settles an InProgress item a previous process left (Discipline A, B). Main is read first: a
 * dead process may have committed the task's merge and died before its record, and a requeue
 * would redo merged work. A merge found is recorded, the worktree and branch the dead process left
 * released (releaseMergedTask), and the task Completed through the path a finished dispatch takes
 * (recordMergeCommit, then PlanningService.route); none found, the startup is counted on the task
 * (recordCrashOrphan, once per startup) and the task requeued (requeueOrphan), or given up as
 * crash_loop once CRASH_LOOP_BOUND startups in a row have found it InProgress. Each attempt re-reads the item, so a partial write of the one before
 * is never built on. Past the bound the task is blocked, never left InProgress: with its merge
 * found but unrecorded, as merge_unrecorded, whose record the loop writes again each cycle;
 * otherwise as orphan_unreconciled under Ashara's own fault class, with the project blocked on it
 * so the operator sees it. A block that cannot be written either throws: the start is refused
 * rather than run with an item InProgress and no attempt alive.
 */
async function settleOrphan(deps: StartupReconcilerDeps, orphan: WorkItem): Promise<Settled> {
  let merge: string | null | undefined;
  let boots: number | undefined;
  let step = "read main for the task's merge";
  let last: unknown = null;
  for (let attempt = 1; attempt <= ORPHAN_BACKOFF_MS.length + 1; attempt++) {
    try {
      step = "re-read the item";
      const item = attempt === 1 ? orphan : await deps.workItemRepo.findById(orphan.id);
      if (item === null || item.status !== "InProgress") {
        deps.logger.info("delivery.orphan-moved", `orphan ${orphan.id} is ${item?.status ?? "gone"} now; left as it is`, {
          taskId: orphan.id,
          status: item?.status ?? "gone",
        });
        return "moved";
      }
      step = "read main for the task's merge";
      if (merge === undefined) merge = await mergeOnMainOf(deps.projects, deps.workdirBase, item);
      if (merge === null) {
        step = "count the startup that found it InProgress";
        if (boots === undefined) boots = await deps.workItemRepo.recordCrashOrphan(item.id);
        if (boots >= CRASH_LOOP_BOUND) {
          step = "give the task up as a crash loop";
          await giveUpCrashLoop(deps, item, boots);
          return "given-up";
        }
        step = "requeue the task";
        await requeueOrphan(deps, item);
        return "requeued";
      }
      step = `record the merge ${merge}`;
      await deps.workItemRepo.recordMergeCommit(item.id, merge, "merged");
      await releaseMergedTask(deps.projects, deps.workdirBase, item, "merged", deps.logger);
      step = `complete the task merged as ${merge}`;
      const events = await PlanningService.route(deps.workItemRepo, item.id, "passed");
      await publishBestEffort(deps, events, item.id);
      deps.logger.info("delivery.orphan-merged", `${item.id} was merged on main as ${merge} by a dead process; merge recorded, Completed, not re-dispatched`, {
        taskId: item.id,
        mergeCommit: merge,
      });
      return "completed";
    } catch (error) {
      // eslint-disable-next-line ashara/catch-continue -- best effort: one attempt of a bounded retry; the last error is kept, and an orphan still unsettled after it is blocked under OrphanUnreconciled, below
      last = error;
      const wait = ORPHAN_BACKOFF_MS[attempt - 1];
      deps.logger.warn(
        "delivery.orphan-settle-failed",
        `orphan ${orphan.id}: ${step} failed on attempt ${attempt} of ${ORPHAN_BACKOFF_MS.length + 1}` +
          `${wait === undefined ? "; blocking it" : `; retrying in ${wait}ms`}`,
        { taskId: orphan.id, step, attempt },
        error,
      );
      if (wait !== undefined) await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  const unsettled = new OrphanUnreconciled(orphan.id, step, ORPHAN_BACKOFF_MS.length + 1, { cause: last });
  const reason: StoredBlockedReason =
    typeof merge === "string"
      ? { source: "merge_unrecorded", mergeCommit: merge, mergeKind: "merged", reason: unsettled.message }
      : { source: "orphan_unreconciled", faultClass: "ashara", step, reason: describeErrorChain(last) };
  const blocked = await blockUnsettled(deps, orphan, reason, unsettled);
  if (blocked === "moved") return "moved";
  if (reason.source === "orphan_unreconciled") {
    try {
      const result = await deps.projects.block(orphan.projectId, projectBlockCause(unsettled));
      deps.logger.error("delivery.project-halted", `project ${orphan.projectId} ${result} on Ashara's own fault: ${unsettled.message}`, {
        taskId: orphan.id,
        projectId: orphan.projectId,
        faultClass: "ashara",
        result,
      }, unsettled);
    } catch (error) {
      // eslint-disable-next-line ashara/catch-continue -- best effort: the orphan is already Blocked with its own exit, which the loop takes each cycle while the project runs
      deps.logger.error("delivery.project-block-failed", `project ${orphan.projectId} could not be blocked on ${unsettled.message}`, {
        taskId: orphan.id,
        projectId: orphan.projectId,
      }, error);
    }
  }
  return "blocked";
}

/** Blocks the orphan under `reason`, within the same bound; throws `unsettled`'s chain when it cannot. */
async function blockUnsettled(
  deps: StartupReconcilerDeps,
  orphan: WorkItem,
  reason: StoredBlockedReason,
  unsettled: OrphanUnreconciled,
): Promise<"blocked" | "moved"> {
  let last: unknown = null;
  for (let attempt = 1; attempt <= ORPHAN_BACKOFF_MS.length + 1; attempt++) {
    try {
      const item = await deps.workItemRepo.findById(orphan.id);
      if (item === null || item.status !== "InProgress") return "moved";
      blockWorkItem(item, reason);
      await deps.workItemRepo.saveOrphanExit(item, "InProgress", "keep-counted");
      await publishBestEffort(deps, takeEvents(item), item.id);
      deps.logger.info("delivery.task-parked", `orphan ${orphan.id} blocked (${reason.source}): ${unsettled.message}`, { taskId: orphan.id, source: reason.source });
      return "blocked";
    } catch (error) {
      // eslint-disable-next-line ashara/catch-continue -- best effort: one attempt of a bounded retry; the last error is kept and thrown as OrphanUnreconciled below, which refuses the start
      last = error;
      const wait = ORPHAN_BACKOFF_MS[attempt - 1];
      deps.logger.warn("delivery.orphan-block-failed", `orphan ${orphan.id}: its block failed on attempt ${attempt}`, { taskId: orphan.id, attempt }, error);
      if (wait !== undefined) await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  throw new OrphanUnreconciled(orphan.id, `block it (${reason.source}) after this: ${unsettled.message}; the block`, ORPHAN_BACKOFF_MS.length + 1, {
    cause: last,
  });
}

/** Gives up an orphan found InProgress at `boots` startups in a row: Abandoned as crash_loop, and its plan repaired. */
async function giveUpCrashLoop(deps: StartupReconcilerDeps, orphan: WorkItem, boots: number): Promise<void> {
  const reason =
    `found InProgress, left by a process that died while it ran, at ${boots} startups in a row with no dispatch of it ` +
    `ending in between (bound ${CRASH_LOOP_BOUND}): its dispatch may be what kills the process`;
  const previousStatus = orphan.status;
  giveUpWorkItem(orphan, { source: "crash_loop", boots, bound: CRASH_LOOP_BOUND, reason });
  await deps.workItemRepo.saveOrphanExit(orphan, previousStatus, "keep-counted");
  await publishBestEffort(deps, takeEvents(orphan), orphan.id);
  deps.logger.info("delivery.task-given-up", `${orphan.id} given up (crash_loop), never re-dispatched; its plan is repaired: ${reason}`, {
    taskId: orphan.id,
    source: "crash_loop",
    boots,
  });
}

/**
 * Requeues an InProgress item left by a previous process, and gives back the dispatch that
 * process counted when the evidence says the dispatch never finished: the item is InProgress and
 * its latest dev_session is still non-terminal. withSessionLifecycle owns every terminal write of
 * a session, so a session that never got one is a dispatch whose execute never returned (a hard
 * kill, a power loss), not an attempt tried and found wanting. Left counted, the conservative
 * direction, when the latest session is terminal (the dispatch finished and only its routing was
 * lost), when there is none (the process died before the dispatch opened its session, which no
 * record tells apart from a session of an earlier dispatch), and past MAX_ORPHAN_REFUNDS.
 */
async function requeueOrphan(deps: StartupReconcilerDeps, orphan: WorkItem): Promise<void> {
  const evidence = await deps.devSessionStore.dispatchEvidence(orphan.id, ORPHANED_SESSION_RESOLVER);
  const unfinished = evidence.latestPhase !== null && !isTerminalSessionPhase(evidence.latestPhase);
  const previousStatus = orphan.status;
  requeueWorkItem(orphan);
  if (!unfinished) {
    await deps.workItemRepo.saveOrphanExit(orphan, previousStatus, "keep-counted");
    deps.logger.info(
      "delivery.orphan-requeued",
      `requeued ${orphan.id}; its dispatch stays counted (latest session ${evidence.latestPhase ?? "none"}, ` +
        `so no record shows a dispatch that never finished)`,
      { taskId: orphan.id, refunded: false },
    );
  } else if (evidence.orphanedBefore >= MAX_ORPHAN_REFUNDS) {
    await deps.workItemRepo.saveOrphanExit(orphan, previousStatus, "keep-counted");
    deps.logger.info(
      "delivery.orphan-requeued",
      `requeued ${orphan.id}; its unfinished dispatch stays counted: ${evidence.orphanedBefore} earlier ` +
        `dispatch(es) of it were already orphaned by a dead process (bound ${MAX_ORPHAN_REFUNDS})`,
      { taskId: orphan.id, refunded: false, orphanedBefore: evidence.orphanedBefore },
    );
  } else {
    // The requeue and its refund are one write: a fault under either leaves the item InProgress for
    // the next attempt of the settlement, never requeued with its unfinished dispatch charged.
    await deps.workItemRepo.saveOrphanExit(orphan, previousStatus, "refund");
    deps.logger.info("delivery.orphan-requeued", `requeued ${orphan.id}; its dispatch never finished (session non-terminal), refunded`, {
      taskId: orphan.id,
      refunded: true,
    });
  }
  await publishBestEffort(deps, takeEvents(orphan), orphan.id);
}

function isTerminalSessionPhase(phase: string): boolean {
  return TERMINAL_SESSION_PHASES.some((terminal) => terminal === phase);
}

function reconstructFailure(item: WorkItem): RawFailureContext {
  // Widen through the exhaustive seam — a new source variant in the
  // discriminated union is a compile error in blockedReasonToRecord,
  // not a silent pass-through.
  // contract-erasing: StoredBlockedReason widened via blockedReasonToRecord for duck-typed access
  const raw: Record<string, unknown> = item.blockedReason
    ? blockedReasonToRecord(item.blockedReason)
    : {};
  const reason = raw["reason"];
  const detail =
    typeof reason === "string" ? reason : "parked Failed item recovered by startup reconciler";
  return { detail, raw };
}

async function publishBestEffort(
  deps: Pick<StartupReconcilerDeps, "eventStore" | "logger">,
  events: DomainEvent[],
  itemId: string,
): Promise<void> {
  for (const event of events) {
    try {
      await deps.eventStore.publish(event);
    } catch (error) {
      // eslint-disable-next-line ashara/catch-continue -- best effort: the transition is committed before its events are published; domain_events is an operator audit log (GET /events is the bearer route) that no verdict, counter, charge or client text reads
      deps.logger.warn(
        "delivery.event-publish-failed",
        `failed to publish audit event for ${itemId} (transition already committed)`,
        { taskId: itemId, site: "startup-reconciler", eventType: event.eventType },
        error,
      );
    }
  }
}
