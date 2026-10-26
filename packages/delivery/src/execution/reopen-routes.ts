import { randomUUID } from "node:crypto";
import { InvalidId, parseWorkItemId } from "@ashara/shared";
import type { ExecutionResult } from "../acl/quality-acl.js";
import type { WorkItem } from "../domain/index.js";
import {
  PlanningService,
  awaitWork,
  clientWaitPastBound,
  deliveringTasks,
  exitDisputedCheck,
  exitStaleChecks,
  exitSuiteReview,
  giveUpWorkItem,
  holdForClient,
  requestEnvironmentChange,
} from "../domain/index.js";
import type { MainHoldsNoMerge } from "../requeue-on-main.js";
import { returnToPending } from "../requeue-on-main.js";
import { GiveUpMisrouted, giveUpRoute } from "./give-up-causes.js";
import type { GiveUpCause } from "./give-up-causes.js";
import type { ExecutionRoutingDeps } from "./routing-deps.js";
import type { ItemWrite, ReopenPlan } from "./reopen.js";
import { reopen } from "./reopen.js";
import { mainHoldsNoMergeOf } from "./main-settle.js";

/** The result a dispatch returned with `status`, as development returned it. */
type ResultOf<S extends ExecutionResult["status"]> = Extract<ExecutionResult, { readonly status: S }>;

/** A return to Pending: the task, after what, the site its events name, and its write. */
interface Requeue {
  readonly task: WorkItem;
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
 * Returns the item to Pending once main is read and holds no merge of it (mainHoldsNoMergeOf, which
 * settles the task itself otherwise). The dispatch stopped without the task being tried and found
 * wanting (a model call refused before it was sent, a shutdown, a fault beneath it): no failed
 * approach. At a project-cap or configuration refusal the project is blocked already, so the gate
 * skips the item until the owner returns the project to work; a deployment refusal stops the loop.
 */
export async function routeAsRequeued(deps: ExecutionRoutingDeps, requeue: Requeue): Promise<void> {
  const absent = await mainHoldsNoMergeOf(deps, requeue.task, requeue.why);
  if (absent === null) return;
  await requeueOnAbsence(deps, requeue, absent);
}

/**
 * Returns the item to Pending on the evidence that main holds no merge of it, for a route that reads
 * main itself before what it writes first (routeAsInfrastructureFault counts the fault in between).
 */
export async function requeueOnAbsence(deps: ExecutionRoutingDeps, requeue: Requeue, absent: MainHoldsNoMerge): Promise<void> {
  const { why } = requeue;
  const taskId = requeue.task.id;
  await reopen(deps, {
    taskId,
    site: requeue.site,
    vanished: `work item vanished before it could be returned to Pending after ${why}`,
    transition: (item) => returnToPending(item, absent),
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
export async function routeAsContextExceeded(deps: ExecutionRoutingDeps, task: WorkItem, exceeded: ResultOf<"context_exceeded">): Promise<void> {
  const { model, windowTokens, wider } = exceeded;
  if (wider === null) {
    await routeAsGivenUp(
      deps,
      task.id,
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
  await routeAsRequeued(deps, { task, why, site: "execution.routeAsContextExceeded", write: { kind: "refund-overflow", windowTokens } });
}

/**
 * Gives the item up with the stated cause; its abandonment opens a plan repair. Only a cause no
 * other route writes is given up here (giveUpRoute): an owner-wait's end never reaches it.
 * An item that is no longer open (moved during the dispatch) is left where it is. `refund` gives
 * the dispatch back in the same write as the give-up, when the attempt did no work the retry bound
 * should charge; `keep` leaves it counted.
 */
export async function routeAsGivenUp(deps: ExecutionRoutingDeps, taskId: WorkItem["id"], reason: GiveUpCause, dispatch: "refund" | "keep"): Promise<void> {
  const route = giveUpRoute(reason);
  if (route !== "given-up") throw new GiveUpMisrouted(taskId, reason.source, route);
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
 * The exit of an item whose stored checks went stale (Delivery's exitStaleChecks): its check task
 * reopened and the item back at Pending waiting on it, with the dispatch given back (no model
 * ran); or, past the rewrite bound or with a check task that cannot be reopened, the item given up
 * and its plan repaired. The check task is saved first: if that save loses a race the item is given
 * up with checks_stale instead, never left waiting on a check task that stayed Completed. Main is
 * read first (mainHoldsNoMergeOf), as before every return to Pending.
 */
export async function routeAsStaleChecks(deps: ExecutionRoutingDeps, task: WorkItem, stale: ResultOf<"checks_stale">): Promise<void> {
  if ((await mainHoldsNoMergeOf(deps, task, `its stored checks went stale (${stale.detail})`)) === null) return;
  const taskId = task.id;
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
 * The exit of an item whose implementer disputed one of its stored checks (Delivery's
 * exitDisputedCheck). The dispute is recorded first, durably: its count per check task is the
 * bound. Within it the check task is reopened with the dispute in its brief and saved first, then
 * the item is back at Pending waiting on it, its dispatch given back; past it, or with a check task
 * that cannot be reopened, the item is given up with a check_disputed reason and its plan repaired.
 * Main is read first (mainHoldsNoMergeOf), as before every return to Pending.
 */
export async function routeAsDisputed(deps: ExecutionRoutingDeps, task: WorkItem, dispute: ResultOf<"disputed">): Promise<void> {
  if ((await mainHoldsNoMergeOf(deps, task, `a dispute of its check ${JSON.stringify(dispute.check.name)}`)) === null) return;
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
 * The exit of a review task whose review of its plan revision's suites found problems (Delivery's
 * exitSuiteReview). The findings are recorded first, durably: how many reviews named each check
 * task is the bound. Within it every named check task is reopened with the problems in its brief and
 * the review returns to Pending, all in one transaction, its dispatch given back; the review's
 * dependencies on those check tasks hold it until they complete again, and the plan's
 * implementations stay held by their dependency on the review. Past the bound, or with a named
 * check task that cannot be reopened or that moves while it is reopened, the review is given up
 * with a suite_review_unresolved reason and its plan repaired, so no implementation is released on
 * problems nobody answered. Main is read first (mainHoldsNoMergeOf), as before every return to Pending.
 */
export async function routeAsSuiteReview(deps: ExecutionRoutingDeps, task: WorkItem, review: ResultOf<"suite_review_problems">): Promise<void> {
  if ((await mainHoldsNoMergeOf(deps, task, `a suite review that found ${review.problems.length} problem(s)`)) === null) return;
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
 * The exit of an item whose implementer changed environment recipe files (Delivery's
 * requestEnvironmentChange). How many environment tasks were already opened for it is read from
 * its dependencies, a durable count; the owner is the role doing the project's environment work.
 * Within the bound the new environment task, the item's dependency on it and the item back at
 * Pending are written in one transaction, and the dispatch is given back (the work was not tried
 * and found wanting); past the bound, or with no owner, the item is given up and its plan repaired.
 * Main is read first (mainHoldsNoMergeOf), as before every return to Pending.
 */
export async function routeAsEnvironmentChange(deps: ExecutionRoutingDeps, task: WorkItem, request: ResultOf<"environment_change_requested">): Promise<void> {
  if ((await mainHoldsNoMergeOf(deps, task, `a requested change to ${request.paths.join(", ")}`)) === null) return;
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

/**
 * The exit of an item whose implementer finished blocked on work another task of the plan delivers
 * (Delivery's awaitWork): the open tasks that deliver the interface entries it named are read from
 * the plan, and within the bound of waits the item goes back to Pending with its dependency on each
 * written in the same transaction, its dispatch given back, so the scheduler releases it once they
 * complete. With no such task the need is a gap in the plan, and the item is given up for its plan to
 * be repaired; past the bound it is given up too. No attempt is counted toward the failure router's
 * give-up on any of these. Main is read first (mainHoldsNoMergeOf), as before every return to Pending.
 */
export async function routeAsAwaitingWork(deps: ExecutionRoutingDeps, task: WorkItem, needed: ResultOf<"prerequisite_needed">): Promise<void> {
  if ((await mainHoldsNoMergeOf(deps, task, `a need of ${needed.interfaceEntries.join(", ")}`)) === null) return;
  await reopen(deps, {
    taskId: task.id,
    site: "execution.routeAsAwaitingWork",
    vanished: `work item vanished before its need of other work could be routed (${needed.detail})`,
    transition: async (item) => {
      const delivering = deliveringTasks(
        item,
        needed.interfaceEntries,
        needed.interfaceTable,
        await deps.workItemRepo.listByProject(item.projectId),
        await deps.workItemRepo.listDependenciesByProject(item.projectId),
      );
      if (delivering.kind === "unresolved") throw new NeededEntriesUnresolved(item.id, delivering.problems);
      return awaitWork(item, { interfaceEntries: delivering.keys, reason: `${needed.reason}\n${needed.detail}` }, delivering.owners);
    },
    transitionRejected: (e) => ({ message: `awaiting-work exit rejected (${e.from} -> ${e.to}); item left at ${e.from} (${needed.detail})`, to: e.to }),
    plan: (exit): ReopenPlan => {
      if (exit.kind !== "waiting") {
        return {
          before: [],
          write: { kind: "refund" },
          rejected: (e) => ({ kind: "left", left: { message: `awaiting-work give-up rejected (${e.from} -> Abandoned); item left at ${e.from}`, to: "Abandoned" } }),
          log: () =>
            deps.logger.info(
              "delivery.task-given-up",
              exit.kind === "unplanned"
                ? `given up, it needs ${needed.interfaceEntries.join(", ")} and no open task of the plan delivers it; its plan is repaired`
                : `given up, blocked on other work again past the bound of ${exit.bound} waits; its plan is repaired`,
              { taskId: task.id, source: "prerequisite_unresolved", interfaceEntries: [...needed.interfaceEntries] },
            ),
        };
      }
      return {
        before: [],
        write: {
          kind: "refund-with",
          items: [],
          write: async (tx) => {
            const known = new Set(await tx.getDependencies(task.id));
            for (const owner of exit.on) if (!known.has(owner)) await tx.addDependency(task.id, owner);
          },
        },
        rejected: (e) => ({
          kind: "left",
          left: { message: `awaiting-work exit rejected (${e.from} -> Pending); item left at ${e.from}, no dependency written`, to: "Pending" },
        }),
        log: (dispatchCount) =>
          deps.logger.info(
            "delivery.task-awaiting-work",
            `needs ${needed.interfaceEntries.join(", ")}; back at Pending waiting on ${exit.on.join(", ")} (wait ${exit.waits}, dispatch count ${dispatchCount})`,
            { taskId: task.id, on: [...exit.on], interfaceEntries: [...needed.interfaceEntries], waits: exit.waits, dispatchCount },
          ),
      };
    },
  });
}

/**
 * Development routes a blocked finish here only once every entry it named resolved against the
 * interface its brief showed (agentBlocked), so a name that resolves to none here is Ashara's own
 * defect, never the task's: it stops the routing rather than guess what the task waits on.
 */
class NeededEntriesUnresolved extends Error {
  constructor(
    readonly taskId: WorkItem["id"],
    readonly problems: readonly string[],
  ) {
    super(`task ${taskId}: development routed a need of other work whose entries resolve to none: ${problems.join("; ")}`);
    this.name = "NeededEntriesUnresolved";
  }
}

/**
 * The exit of an item whose implementer finished blocked on a decision only the client can make:
 * within the bound of waits the item holds at Blocked for the client's answer under a question id
 * chosen now, its dispatch given back; the loop posts the question under that id on the question
 * path intake's questions take (Engagement) and takes the item's exit once the answer is read
 * (parked-exits.ts). The hold is written before the question is posted, so no crash between the two
 * leaves a question no task waits on. Past the bound the item is given up and its plan repaired.
 */
export async function routeAsAwaitingClient(deps: ExecutionRoutingDeps, task: WorkItem, needed: ResultOf<"client_decision_needed">): Promise<void> {
  const reason = `${needed.reason}\n${needed.detail}`;
  await reopen(deps, {
    taskId: task.id,
    site: "execution.routeAsAwaitingClient",
    vanished: `work item vanished before its question for the client could be routed (${needed.detail})`,
    transition: (item) => {
      if (clientWaitPastBound(item, reason)) return { kind: "bound" as const };
      const questionId = randomUUID();
      holdForClient(item, { questionId, question: needed.question, assumption: needed.assumption, reason });
      return { kind: "held" as const, questionId };
    },
    transitionRejected: (e) => ({ message: `client-question exit rejected (${e.from} -> ${e.to}); item left at ${e.from} (${needed.detail})`, to: e.to }),
    plan: (exit): ReopenPlan => {
      if (exit.kind === "bound") {
        return {
          before: [],
          write: { kind: "refund" },
          rejected: (e) => ({ kind: "left", left: { message: `client-question give-up rejected (${e.from} -> Abandoned); item left at ${e.from}`, to: "Abandoned" } }),
          log: () =>
            deps.logger.info(
              "delivery.task-given-up",
              "given up, blocked on the client's decision again past the bound of waits; no question posted; its plan is repaired",
              { taskId: task.id, source: "prerequisite_unresolved" },
            ),
        };
      }
      return {
        before: [],
        write: { kind: "refund" },
        rejected: (e) => ({
          kind: "left",
          left: { message: `client-question hold rejected (${e.from} -> Blocked); item left at ${e.from}, no question posted`, to: "Blocked" },
        }),
        log: (dispatchCount) =>
          deps.logger.info(
            "delivery.task-awaiting-client",
            `needs the client's decision; held for the answer to question ${exit.questionId}, which the loop posts (dispatch count ${dispatchCount})`,
            { taskId: task.id, questionId: exit.questionId, dispatchCount },
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
