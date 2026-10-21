import { InvalidId, parseWorkItemId } from "@ashara/shared";
import type { StoredBlockedReason } from "../work-item-language/blocked-reason.js";
import type { WorkItem } from "../domain/index.js";
import {
  PlanningService,
  blockWorkItem,
  exitDisputedCheck,
  exitStaleChecks,
  exitSuiteReview,
  giveUpWorkItem,
  requeueWorkItem,
  requestEnvironmentChange,
} from "../domain/index.js";
import type { GiveUpCause } from "./give-up-causes.js";
import type { ExecutionRoutingDeps } from "./routing-deps.js";
import type { ItemWrite, ReopenPlan } from "./reopen.js";
import { reopen } from "./reopen.js";

/** The block a dispatch parks a task with: the loop takes its exit by itself (parked-exits.ts). */
export type ParkedReason = Extract<StoredBlockedReason, { source: "merge_unrecorded" | "orphan_unreconciled" }>;

interface StaleChecksResult {
  readonly checkTaskId: string;
  readonly revision: number;
  readonly detail: string;
}

/** An implementer's dispute of one stored check, as development returned it. */
interface DisputedCheckResult {
  /** The task whose stored checks hold the disputed check: the item itself, or a task already merged. */
  readonly checksOf: string;
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
    readonly kind: "contradiction" | "outside-vision" | "undecided-item";
    readonly problem: string;
    readonly evidence: string;
  }>;
  readonly detail: string;
}

/** A turn that did not fit its model's context window, as development returned it. */
interface ContextExceededResult {
  readonly model: { readonly provider: string; readonly modelId: string };
  readonly windowTokens: number;
  readonly outputReserveTokens: number;
  readonly projectedInputTokens: number | null;
  readonly wider: { readonly provider: string; readonly modelId: string; readonly windowTokens: number } | null;
  readonly detail: string;
}

/** An implementer's finished work that changed environment recipe files, as development returned it. */
interface EnvironmentChangeResult {
  readonly paths: readonly string[];
  readonly need: string;
  readonly diff: string;
  readonly detail: string;
}

/** A return to Pending: after what, the site its events name, and its write. */
interface Requeue {
  readonly taskId: WorkItem["id"];
  readonly why: string;
  readonly site: string;
  /**
   * `save` when the seam never counted the dispatch, so there is nothing to give back; otherwise
   * the write that gives the counted dispatch back with the requeue (with whatever else belongs
   * to the same routing).
   */
  readonly write: ItemWrite;
}

/**
 * Returns the item to Pending. The dispatch stopped without the task being tried and found
 * wanting (a model call refused before it was sent, a shutdown, a fault beneath it): no failed
 * approach. At a project-cap or configuration refusal the project is blocked already, so the gate
 * skips the item until the owner returns the project to work; a deployment refusal stops the loop.
 */
export async function routeAsRequeued(deps: ExecutionRoutingDeps, requeue: Requeue): Promise<void> {
  const { taskId, why } = requeue;
  await reopen(deps, {
    taskId,
    site: requeue.site,
    vanished: `work item vanished before it could be returned to Pending after ${why}`,
    transition: (item) => requeueWorkItem(item),
    transitionRejected: (e) => ({ message: `requeue after ${why} rejected (${e.from} -> Pending); item left at ${e.from}`, to: "Pending" }),
    plan: () => ({
      before: [],
      write: requeue.write,
      rejected: null,
      log: (dispatchCount) => {
        if (dispatchCount === null) {
          deps.logger.info("delivery.task-requeued", `back to Pending after ${why}, no dispatch counted`, { taskId, refunded: false });
          return;
        }
        deps.logger.info("delivery.task-requeued", `back to Pending after ${why}, its dispatch given back (dispatch count ${dispatchCount})`, {
          taskId,
          dispatchCount,
          refunded: true,
        });
      },
    }),
  });
}

/**
 * A turn that did not fit its model's context window. With a catalog model whose window is larger,
 * the window is recorded on the item as it goes back to Pending with its dispatch given back, in
 * one transaction (a fault leaves neither), and staffing dispatches it next on a model whose window
 * is larger than any it overflowed: each overflow raises the recorded window, so these requeues end
 * within the catalog. With none, the task is given up naming the window and the estimate, and its
 * plan repaired, which can cut it smaller.
 */
export async function routeAsContextExceeded(deps: ExecutionRoutingDeps, taskId: WorkItem["id"], exceeded: ContextExceededResult): Promise<void> {
  const { model, windowTokens, wider } = exceeded;
  if (wider === null) {
    await routeAsGivenUp(
      deps,
      taskId,
      {
        source: "context_window_exceeded",
        provider: model.provider,
        model: model.modelId,
        windowTokens,
        outputReserveTokens: exceeded.outputReserveTokens,
        projectedInputTokens: exceeded.projectedInputTokens,
        reason: exceeded.detail,
      },
      "keep",
    );
    return;
  }
  const why =
    `a turn that did not fit the ${windowTokens}-token window of ${model.provider}/${model.modelId}; ` +
    `dispatched next on a model whose window is larger (${wider.provider}/${wider.modelId}, ${wider.windowTokens} tokens)`;
  await routeAsRequeued(deps, { taskId, why, site: "execution.routeAsContextExceeded", write: { kind: "refund-overflow", windowTokens } });
}

/**
 * Parks the item at Blocked with the stated reason. An item that is no longer
 * InProgress (moved by the owner during dispatch) is left where it is: no
 * agent ran, so there is no result to salvage.
 */
export async function routeAsParked(deps: ExecutionRoutingDeps, taskId: WorkItem["id"], reason: ParkedReason): Promise<void> {
  await reopen(deps, {
    taskId,
    site: "execution.routeAsParked",
    vanished: `work item vanished before it could be blocked (${reason.reason})`,
    transition: (item) => blockWorkItem(item, reason),
    transitionRejected: (e) => ({
      message: `${reason.source} block rejected (${e.from} -> Blocked); item left at ${e.from} (${reason.reason})`,
      to: "Blocked",
      source: reason.source,
    }),
    plan: () => ({
      before: [],
      write: { kind: "save" },
      rejected: null,
      log: () =>
        deps.logger.info(
          "delivery.task-parked",
          reason.source === "merge_unrecorded"
            ? `blocked, merge ${reason.mergeCommit} unrecorded, the loop writes it again each cycle: ${reason.reason}`
            : `blocked, main unread for its merge (${reason.step}), the loop reads it again each cycle: ${reason.reason}`,
          { taskId, source: reason.source },
        ),
    }),
  });
}

/**
 * Gives the item up with the stated cause; its abandonment opens a plan repair.
 * An item that is no longer open (moved during the dispatch) is left where it is. `refund` gives
 * the dispatch back in the same write as the give-up, when the attempt did no work the retry bound
 * should charge; `keep` leaves it counted.
 */
export async function routeAsGivenUp(deps: ExecutionRoutingDeps, taskId: WorkItem["id"], reason: GiveUpCause, dispatch: "refund" | "keep"): Promise<void> {
  await reopen(deps, {
    taskId,
    site: "execution.routeAsGivenUp",
    vanished: `work item vanished before it could be given up (${reason.reason})`,
    transition: (item) => giveUpWorkItem(item, reason),
    transitionRejected: (e) => ({
      message: `${reason.source} give-up rejected (${e.from} -> Abandoned); item left at ${e.from} (${reason.reason})`,
      to: "Abandoned",
      source: reason.source,
    }),
    plan: () => ({
      before: [],
      write: dispatch === "refund" ? { kind: "refund" } : { kind: "save" },
      rejected: null,
      log: (dispatchCount) => {
        if (dispatchCount === null) {
          deps.logger.info("delivery.task-given-up", `given up (${reason.source}); its plan is repaired: ${reason.reason}`, { taskId, source: reason.source, refunded: false });
          return;
        }
        deps.logger.info("delivery.task-given-up", `given up (${reason.source}), its dispatch given back (dispatch count ${dispatchCount}); its plan is repaired: ${reason.reason}`, {
          taskId,
          source: reason.source,
          dispatchCount,
          refunded: true,
        });
      },
    }),
  });
}

/**
 * The exit of an item whose stored checks went stale (planning's exitStaleChecks): its check task
 * reopened and the item back at Pending waiting on it, with the dispatch given back (no model
 * ran); or, past the rewrite bound or with a check task that cannot be reopened, the item given up
 * and its plan repaired. The check task is saved first: if that save loses a race the item is given
 * up with checks_stale instead, never left waiting on a check task that stayed Completed.
 */
export async function routeAsStaleChecks(deps: ExecutionRoutingDeps, taskId: WorkItem["id"], stale: StaleChecksResult): Promise<void> {
  await reopen(deps, {
    taskId,
    site: "execution.routeAsStaleChecks",
    vanished: `work item vanished before its stale checks could be routed (${stale.detail})`,
    transition: async (item) => {
      const checkTask = await findCheckTask(deps, stale.checkTaskId, "stale checks checkTaskId");
      const checkTaskPrevious = checkTask?.status;
      return { exit: exitStaleChecks(item, checkTask, stale), checkTask, checkTaskPrevious };
    },
    transitionRejected: (e) => ({ message: `stale-checks exit rejected (${e.from} -> ${e.to}); item left at ${e.from} (${stale.detail})`, to: e.to }),
    plan: ({ exit, checkTask, checkTaskPrevious }, item) => ({
      before:
        exit.kind === "rewrite" && checkTask !== null && checkTaskPrevious !== undefined
          ? [
              {
                write: () => PlanningService.saveWorkItem(deps.workItemRepo, checkTask, checkTaskPrevious),
                published: [checkTask],
                rejected: (e) => ({
                  kind: "instead",
                  then: () =>
                    routeAsGivenUp(deps, taskId, {
                      source: "checks_stale",
                      checkTaskId: stale.checkTaskId,
                      reason: `${stale.detail}\nThe check task cannot be reopened: it moved to ${e.from} while it was being reopened`,
                    }, "keep"),
                }),
              },
            ]
          : [],
      // A rewrite sends the item back to wait with its dispatch given back (no model ran), in one write.
      write: exit.kind === "rewrite" ? { kind: "refund" } : { kind: "save" },
      // An owner moved the item during the dispatch; a reopened check task stays reopened and the
      // item keeps its dependency on it wherever the owner put it.
      rejected: (e) => ({
        kind: "left",
        left: { message: `stale-checks exit (${exit.kind}) rejected (${e.from} -> ${item.status}); item left at ${e.from}`, to: item.status },
      }),
      log: (dispatchCount) => {
        switch (exit.kind) {
          case "rewrite":
            deps.logger.info(
              "delivery.check-task-reopened",
              `stored checks revision ${stale.revision} stale; check task ${stale.checkTaskId} reopened to write them ` +
                `again, item back at Pending waiting on it (dispatch count ${dispatchCount})`,
              { taskId, checkTaskId: stale.checkTaskId, revision: stale.revision, dispatchCount },
            );
            return;
          case "bound":
            deps.logger.info(
              "delivery.task-given-up",
              `given up, stored checks revision ${stale.revision} stale past the rewrite bound; check task ${stale.checkTaskId} is not reopened`,
              { taskId, source: "checks_stale", checkTaskId: stale.checkTaskId },
            );
            return;
          case "unreopenable":
            deps.logger.info("delivery.task-given-up", `given up, stored checks stale and check task ${stale.checkTaskId} cannot be reopened: ${exit.why}`, {
              taskId,
              source: "checks_stale",
              checkTaskId: stale.checkTaskId,
            });
            return;
        }
      },
    }),
  });
}

/**
 * The exit of an item whose implementer disputed one of its stored checks (planning's
 * exitDisputedCheck). The dispute is recorded first, durably: its count per check task is the
 * bound. Within it the check task is reopened with the dispute in its brief and saved first, then
 * the item is back at Pending waiting on it, its dispatch given back; past it, or with a check task
 * that cannot be reopened, the item is given up with a check_disputed reason and its plan repaired.
 */
export async function routeAsDisputed(deps: ExecutionRoutingDeps, task: WorkItem, dispute: DisputedCheckResult): Promise<void> {
  const disputes = await deps.checkDisputes.record({
    projectId: task.projectId,
    taskId: task.id,
    checkTaskId: dispute.checkTaskId,
    revision: dispute.revision,
    checkName: dispute.check.name,
    reason: dispute.reason,
    evidence: dispute.evidence,
  });
  await reopen(deps, {
    taskId: task.id,
    site: "execution.routeAsDisputed",
    vanished: `work item vanished before its check dispute could be routed (${dispute.detail})`,
    transition: async (item) => {
      const checkTask = await findCheckTask(deps, dispute.checkTaskId, "check dispute checkTaskId");
      const checkTaskPrevious = checkTask?.status;
      return { exit: exitDisputedCheck(item, checkTask, { ...dispute, disputes }), checkTask, checkTaskPrevious };
    },
    transitionRejected: (e) => ({ message: `check-dispute exit rejected (${e.from} -> ${e.to}); item left at ${e.from} (${dispute.detail})`, to: e.to }),
    plan: ({ exit, checkTask, checkTaskPrevious }, item) => ({
      before:
        exit.kind === "rewrite" && checkTask !== null && checkTaskPrevious !== undefined
          ? [
              {
                write: () => PlanningService.saveWorkItem(deps.workItemRepo, checkTask, checkTaskPrevious),
                published: [checkTask],
                rejected: (e) => ({
                  kind: "instead",
                  then: () =>
                    routeAsGivenUp(deps, task.id, {
                      source: "check_disputed",
                      checkTaskId: dispute.checkTaskId,
                      checkName: dispute.check.name,
                      reason: `${dispute.reason}\nThe check task cannot be reopened: it moved to ${e.from} while it was being reopened`,
                    }, "keep"),
                }),
              },
              {
                // A disputed check of a task already merged may be written by a
                // check task of another plan revision, which the item does not depend on: the edge is what
                // holds it at Pending until the check task has written them again.
                write: async () => {
                  if (!(await deps.workItemRepo.getDependencies(item.id)).includes(checkTask.id)) {
                    await deps.workItemRepo.addDependency(item.id, checkTask.id);
                  }
                },
                published: [],
                rejected: null,
              },
            ]
          : [],
      // A rewrite sends the item back to wait with its dispatch given back, in one write.
      write: exit.kind === "rewrite" ? { kind: "refund" } : { kind: "save" },
      rejected: (e) => ({
        kind: "left",
        left: { message: `check-dispute exit (${exit.kind}) rejected (${e.from} -> ${item.status}); item left at ${e.from}`, to: item.status },
      }),
      log: (dispatchCount) => {
        if (exit.kind === "rewrite") {
          const whose = dispute.checksOf === task.id ? "" : ` of merged task ${dispute.checksOf}`;
          deps.logger.info(
            "delivery.check-task-reopened",
            `check ${JSON.stringify(dispute.check.name)}${whose} disputed (dispute ${disputes} of its check task); check task ` +
              `${dispute.checkTaskId} reopened with the dispute, item back at Pending waiting on it (dispatch count ${dispatchCount})`,
            { taskId: task.id, checkTaskId: dispute.checkTaskId, check: dispute.check.name, disputes, dispatchCount },
          );
          return;
        }
        const why = exit.kind === "bound" ? `dispute ${disputes} is past the bound of ${exit.bound}` : `the check task cannot be reopened: ${exit.why}`;
        deps.logger.info("delivery.task-given-up", `given up, check ${JSON.stringify(dispute.check.name)} of check task ${dispute.checkTaskId} disputed and ${why}`, {
          taskId: task.id,
          source: "check_disputed",
          checkTaskId: dispute.checkTaskId,
          check: dispute.check.name,
        });
      },
    }),
  });
}

/**
 * The exit of a review task whose review of its plan revision's suites found problems (planning's
 * exitSuiteReview). The findings are recorded first, durably: how many reviews named each check
 * task is the bound. Within it every named check task is reopened with the problems in its brief and
 * the review returns to Pending, all in one transaction, its dispatch given back; the review's
 * dependencies on those check tasks hold it until they complete again, and the plan's
 * implementations stay held by their dependency on the review. Past the bound, or with a named
 * check task that cannot be reopened or that moves while it is reopened, the review is given up
 * with a suite_review_unresolved reason and its plan repaired, so no implementation is released on
 * problems nobody answered.
 */
export async function routeAsSuiteReview(deps: ExecutionRoutingDeps, task: WorkItem, review: SuiteReviewProblemsResult): Promise<void> {
  const { timesNamed } = await deps.suiteReviewFindings.record({
    projectId: task.projectId,
    reviewTaskId: task.id,
    problems: review.problems,
  });
  const named = [...new Set(review.problems.flatMap((problem) => problem.checkTaskIds))];
  await reopen(deps, {
    taskId: task.id,
    site: "execution.routeAsSuiteReview",
    vanished: `review task vanished before its findings could be routed (${review.detail})`,
    transition: async (item) => {
      const checkTasks = new Map<string, WorkItem | null>();
      for (const checkTaskId of named) checkTasks.set(checkTaskId, await findCheckTask(deps, checkTaskId, "suite review checkTaskIds"));
      return exitSuiteReview(item, checkTasks, { problems: review.problems, timesNamed });
    },
    transitionRejected: (e) => ({ message: `suite-review exit rejected (${e.from} -> ${e.to}); review left at ${e.from} (${review.detail})`, to: e.to }),
    plan: (exit): ReopenPlan => {
      switch (exit.kind) {
        case "bound":
        case "unreopenable":
          return {
            before: [],
            write: { kind: "save" },
            rejected: (e) => ({ kind: "left", left: { message: `suite-review give-up rejected (${e.from} -> Abandoned); review left at ${e.from}`, to: "Abandoned" } }),
            log: () => {
              const why =
                exit.kind === "bound"
                  ? `review ${exit.times} naming check task ${exit.checkTaskId} is past the bound of ${exit.bound}`
                  : `no check task can be reopened for its problems: ${exit.why}`;
              deps.logger.info("delivery.task-given-up", `given up, the suite review found problems and ${why}; its plan is repaired`, {
                taskId: task.id,
                source: "suite_review_unresolved",
                checkTaskIds: named,
              });
            },
          };
        case "reopened":
          return {
            before: [],
            write: {
              kind: "refund-with",
              items: exit.checkTasks,
              write: async (tx) => {
                for (const checkTask of exit.checkTasks) await PlanningService.saveWorkItem(tx, checkTask, "Completed");
              },
            },
            // Nothing was written: a check task or the review moved while they were being reopened.
            rejected: (e) => ({
              kind: "instead",
              then: () =>
                routeAsGivenUp(deps, task.id, {
                  source: "suite_review_unresolved",
                  checkTaskIds: named,
                  reason: `${review.detail}\nThe check tasks cannot be reopened: ${e.message}`,
                }, "keep"),
            }),
            log: (dispatchCount) =>
              deps.logger.info(
                "delivery.check-tasks-reopened",
                `suite review found ${review.problems.length} problem(s); check task(s) ${named.join(", ")} reopened ` +
                  `with them, review back at Pending waiting on them (dispatch count ${dispatchCount})`,
                { taskId: task.id, checkTaskIds: named, problems: review.problems.length, dispatchCount },
              ),
          };
      }
    },
  });
}

/**
 * The exit of an item whose implementer changed environment recipe files (planning's
 * requestEnvironmentChange). How many environment tasks were already opened for it is read from
 * its dependencies, a durable count; the owner is the role doing the project's environment work.
 * Within the bound the new environment task, the item's dependency on it and the item back at
 * Pending are written in one transaction, and the dispatch is given back (the work was not tried
 * and found wanting); past the bound, or with no owner, the item is given up and its plan repaired.
 */
export async function routeAsEnvironmentChange(deps: ExecutionRoutingDeps, task: WorkItem, request: EnvironmentChangeResult): Promise<void> {
  await reopen(deps, {
    taskId: task.id,
    site: "execution.routeAsEnvironmentChange",
    vanished: `work item vanished before its environment change could be routed (${request.detail})`,
    transition: async (item) => {
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
      // A roster that cannot be read throws through (the port's contract): Ashara's fault, routed
      // uncharged by processTask, never read as "no owner", which would give the task up.
      const owner = await deps.environmentOwner(task.projectId);
      return { exit: requestEnvironmentChange(item, request, { opened, owner, product }), opened };
    },
    transitionRejected: (e) => ({ message: `environment-change exit rejected (${e.from} -> ${e.to}); item left at ${e.from} (${request.detail})`, to: e.to }),
    plan: ({ exit, opened }): ReopenPlan => {
      if (exit.kind !== "opened") {
        return {
          before: [],
          write: { kind: "save" },
          rejected: (e) => ({ kind: "left", left: { message: `environment-change give-up rejected (${e.from} -> Abandoned); item left at ${e.from}`, to: "Abandoned" } }),
          log: () =>
            deps.logger.info(
              "delivery.task-given-up",
              `given up, environment change needed for ${request.paths.join(", ")}: ` +
                (exit.kind === "bound" ? `past the bound of ${exit.bound} environment task(s)` : `no environment task can be opened: ${exit.why}`),
              { taskId: task.id, source: "environment_change", paths: request.paths },
            ),
        };
      }
      const environment = exit.environment;
      return {
        before: [],
        write: {
          kind: "refund-with",
          items: [environment],
          write: async (tx) => {
            await PlanningService.createWorkItem(tx, environment);
            await tx.addDependency(task.id, environment.id);
          },
        },
        // An owner moved the item during the dispatch: nothing was written, the environment task included.
        rejected: (e) => ({
          kind: "left",
          left: { message: `environment-change exit rejected (${e.from} -> Pending); item left at ${e.from}, no environment task opened`, to: "Pending" },
        }),
        log: (dispatchCount) =>
          deps.logger.info(
            "delivery.environment-task-opened",
            `needs a change to the environment recipe (${request.paths.join(", ")}); environment task ${environment.id} opened ` +
              `(${opened + 1} for this task), item back at Pending waiting on it (dispatch count ${dispatchCount})`,
            { taskId: task.id, environmentTaskId: environment.id, paths: request.paths, opened: opened + 1, dispatchCount },
          ),
      };
    },
  });
}

/** The check task a stale revision names; null when the stored id is no work item's. */
async function findCheckTask(deps: Pick<ExecutionRoutingDeps, "workItemRepo" | "logger">, checkTaskId: string, field: string): Promise<WorkItem | null> {
  let id: WorkItem["id"];
  try {
    id = parseWorkItemId(checkTaskId, field);
  } catch (e) {
    if (!(e instanceof InvalidId)) throw e;
    deps.logger.error("delivery.check-task-id-invalid", "the stored check task id names no work item", { checkTaskId, field }, e);
    return null;
  }
  return PlanningService.findWorkItem(deps.workItemRepo, id);
}
