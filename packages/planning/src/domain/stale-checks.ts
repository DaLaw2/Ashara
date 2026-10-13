import { InvalidStatusTransition, canTransitionTo, createDomainEvent } from "@ashara/shared";
import type { WorkItem } from "./work-item.js";
import { blockWorkItem } from "./work-item.js";

/**
 * How many times a check task writes a task's checks again, after its first write, before a task
 * whose checks went stale once more is parked for the operator. Each rewrite is a new revision of
 * the task's checks: a stale revision up to `CHECK_REWRITE_BOUND` reopens the check task, and the
 * revision its last rewrite stores, `CHECK_REWRITE_BOUND + 1`, parks the task when it goes stale.
 */
const CHECK_REWRITE_BOUND = 2;

/** An implementation task's stored checks no longer all fail on main on its dispatch's environment. */
interface StaleChecks {
  readonly checkTaskId: string;
  /** The stale revision: 1 is the check task's first write, each rewrite adds one. */
  readonly revision: number;
  /** The red run on the current environment, for the check author and the operator. */
  readonly detail: string;
}

type StaleChecksExit =
  /** The check task is reopened (Completed -> Pending) and the task waits on it at Pending. */
  | { readonly kind: "rewrite" }
  /** The task is parked at Blocked with a checks_rewrite_bound reason. */
  | { readonly kind: "bound" }
  /** The named check task cannot be reopened; the task is parked at Blocked with a checks_stale reason. */
  | { readonly kind: "unreopenable"; readonly why: string };

/**
 * Reopens a Completed check task so it writes the checks of the task it decides again, on the
 * environment current when it is next dispatched. Pinned to a Completed item of work kind
 * "check": a reopened implementation task would merge its work twice. The reason it is reopened
 * is left as the next attempt's context, the way a replan leaves it.
 */
function reopenCheckTask(item: WorkItem, checkedTaskId: string, stale: StaleChecks): void {
  if (item.status !== "Completed" || item.workKind !== "check" || !canTransitionTo(item.status, "Pending")) {
    throw new InvalidStatusTransition(item.id, item.status, "Pending");
  }
  item.status = "Pending";
  item.blockedReason = {
    source: "replan",
    replanContext: {
      attempt: item.dispatchCount,
      detail:
        `the checks this task recorded for task ${checkedTaskId} (revision ${stale.revision}) no longer all fail on main ` +
        `on the project's current environment, so they cannot decide that task; define them again so that each fails on ` +
        `main on the current environment. The red run that rejected them:\n${stale.detail}`,
      raw: { checkedTaskId, staleRevision: stale.revision },
    },
  };
  item.updatedAt = new Date();
  item.events.push(
    createDomainEvent("work_item.reopened", "planning", {
      work_item_id: item.id,
      level: item.level,
      checked_task_id: checkedTaskId,
      stale_revision: stale.revision,
    }),
  );
}

/**
 * Returns an InProgress implementation task to Pending to wait on its reopened check task: its
 * dependency on that task keeps it from the gate until the check task is Completed again, which
 * is only after the new revision is stored. If the check task is Abandoned instead, the gate parks
 * this task at Blocked with a dependency_unsatisfiable reason naming it. Not a requeue (nothing crashed) and not a replan
 * (nothing failed): it has its own event.
 */
function awaitRewrittenChecks(item: WorkItem, stale: StaleChecks): void {
  if (item.status !== "InProgress" || !canTransitionTo(item.status, "Pending")) {
    throw new InvalidStatusTransition(item.id, item.status, "Pending");
  }
  item.status = "Pending";
  item.blockedReason = undefined;
  item.updatedAt = new Date();
  item.events.push(
    createDomainEvent("work_item.awaiting_checks", "planning", {
      work_item_id: item.id,
      level: item.level,
      check_task_id: stale.checkTaskId,
      stale_revision: stale.revision,
    }),
  );
}

/**
 * The exit of an InProgress implementation task whose stored checks went stale. Within the bound
 * the check task it names is reopened and the task waits on it; past the bound, or when that
 * check task cannot be reopened (missing, not a check task, not Completed), the task is parked at
 * Blocked with a reason naming why. Mutates `task` and, on "rewrite", `checkTask`; the caller
 * saves the check task first, so a task is never left waiting on a check task that stayed Completed.
 */
export function exitStaleChecks(task: WorkItem, checkTask: WorkItem | null, stale: StaleChecks): StaleChecksExit {
  const rewrites = stale.revision - 1;
  if (rewrites >= CHECK_REWRITE_BOUND) {
    blockWorkItem(task, {
      source: "checks_rewrite_bound",
      checkTaskId: stale.checkTaskId,
      revision: stale.revision,
      bound: CHECK_REWRITE_BOUND,
      reason:
        `the checks were written again ${rewrites} time(s), the bound of ${CHECK_REWRITE_BOUND}, and revision ` +
        `${stale.revision} is stale too; check task ${stale.checkTaskId} is not reopened again:\n${stale.detail}`,
    });
    return { kind: "bound" };
  }
  const reopenable = reopenableCheckTask(checkTask, stale.checkTaskId);
  if (reopenable.kind === "refused") {
    blockWorkItem(task, {
      source: "checks_stale",
      checkTaskId: stale.checkTaskId,
      reason: `${stale.detail}\nThe check task cannot be reopened: ${reopenable.why}`,
    });
    return { kind: "unreopenable", why: reopenable.why };
  }
  if (task.status !== "InProgress") throw new InvalidStatusTransition(task.id, task.status, "Pending");
  reopenCheckTask(reopenable.item, task.id, stale);
  awaitRewrittenChecks(task, stale);
  return { kind: "rewrite" };
}

function reopenableCheckTask(
  checkTask: WorkItem | null,
  checkTaskId: string,
): { readonly kind: "reopenable"; readonly item: WorkItem } | { readonly kind: "refused"; readonly why: string } {
  if (checkTask === null) return { kind: "refused", why: `check task ${checkTaskId} is not on record` };
  if (checkTask.id !== checkTaskId) return { kind: "refused", why: `work item ${checkTask.id} is not check task ${checkTaskId}` };
  if (checkTask.workKind !== "check") {
    return { kind: "refused", why: `work item ${checkTask.id} is of work kind ${checkTask.workKind ?? "unrecorded"}, not check` };
  }
  if (checkTask.status !== "Completed") return { kind: "refused", why: `check task ${checkTask.id} is ${checkTask.status}, not Completed` };
  return { kind: "reopenable", item: checkTask };
}
