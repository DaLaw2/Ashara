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
 * Reopens a Completed check task so it writes the checks of the task it decides again. Pinned to a
 * Completed item of work kind "check": a reopened implementation task would merge its work twice.
 * Why it is reopened (`detail`) is left as the next attempt's context, the way a replan leaves it.
 */
function reopenCheckTask(
  item: WorkItem,
  checkedTaskId: string,
  detail: string,
  raw: Record<string, unknown>,
  // open-by-design: the event names why the check task was reopened, per cause
  why: Record<string, unknown>,
): void {
  if (item.status !== "Completed" || item.workKind !== "check" || !canTransitionTo(item.status, "Pending")) {
    throw new InvalidStatusTransition(item.id, item.status, "Pending");
  }
  item.status = "Pending";
  item.blockedReason = {
    source: "replan",
    replanContext: { attempt: item.dispatchCount, detail, raw: { checkedTaskId, ...raw } },
  };
  item.updatedAt = new Date();
  item.events.push(
    createDomainEvent("work_item.reopened", "planning", {
      work_item_id: item.id,
      level: item.level,
      checked_task_id: checkedTaskId,
      ...why,
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
function awaitRewrittenChecks(
  item: WorkItem,
  checkTaskId: string,
  // open-by-design: the event names why the checks are written again, per cause
  why: Record<string, unknown>,
): void {
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
      check_task_id: checkTaskId,
      ...why,
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
  reopenCheckTask(
    reopenable.item,
    task.id,
    `the checks this task recorded for task ${task.id} (revision ${stale.revision}) no longer all fail on main ` +
      `on the project's current environment, so they cannot decide that task; define them again so that each fails on ` +
      `main on the current environment. The red run that rejected them:\n${stale.detail}`,
    { staleRevision: stale.revision },
    { stale_revision: stale.revision },
  );
  awaitRewrittenChecks(task, stale.checkTaskId, { stale_revision: stale.revision });
  return { kind: "rewrite" };
}

/**
 * How many times an implementer may dispute the checks of one check task (ADR-074 addendum 2 d65
 * c). A dispute past it blocks the project for its owner: the implementer and the check author
 * have disagreed that often and nothing in the team settles it.
 */
const CHECK_DISPUTE_BOUND = 2;

/** An implementer's dispute of one stored check (dispute_check). */
interface CheckDispute {
  readonly checkTaskId: string;
  /** The revision of the task's checks the disputed check belongs to. */
  readonly revision: number;
  /** The disputed check as stored. */
  readonly check: { readonly name: string; readonly command: string };
  readonly reason: string;
  /** The output of the implementer's last run_checks; null when it never ran them. */
  readonly evidence: string | null;
  /** How many disputes the check task has drawn, this one included (Quality's durable record). */
  readonly disputes: number;
}

type DisputeExit =
  /** The check task is reopened (Completed -> Pending) with the dispute; the task waits on it at Pending. */
  | { readonly kind: "rewrite" }
  /** Past the bound: nothing is mutated; the caller blocks the project and returns the task to Pending. */
  | { readonly kind: "bound"; readonly bound: number }
  /** The named check task cannot be reopened; the task is parked at Blocked with a check_disputed reason. */
  | { readonly kind: "unreopenable"; readonly why: string };

/** The dispute as the check author reads it in the reopened task's brief. */
function disputeBrief(taskId: string, dispute: CheckDispute): string {
  return [
    `The implementer of task ${taskId} disputes check ${JSON.stringify(dispute.check.name)} of the checks this task ` +
      `recorded for it (revision ${dispute.revision}): it holds that the check cannot pass on correct work. Weigh the ` +
      `dispute and define the task's checks again: fix the check if the dispute is right, or keep it if it is wrong, ` +
      `so that each check fails on main and can pass on correct work.`,
    `The disputed check: ${JSON.stringify(dispute.check.name)}, command: ${dispute.check.command}`,
    `The implementer's reason:\n${dispute.reason}`,
    dispute.evidence === null
      ? `The implementer did not run the checks before disputing.`
      : `The implementer's last run of the checks:\n${dispute.evidence}`,
  ].join("\n\n");
}

/**
 * The exit of an InProgress implementation task whose implementer disputed one of its stored
 * checks. Not the task's failure: within the bound the check task that wrote the check is reopened
 * with the dispute in its brief and the task waits on it, as for stale checks; past the bound the
 * caller blocks the project; a check task that cannot be reopened parks the task at Blocked. Mutates
 * `task` and, on "rewrite", `checkTask`; the caller saves the check task first.
 */
export function exitDisputedCheck(task: WorkItem, checkTask: WorkItem | null, dispute: CheckDispute): DisputeExit {
  if (dispute.disputes > CHECK_DISPUTE_BOUND) return { kind: "bound", bound: CHECK_DISPUTE_BOUND };
  const reopenable = reopenableCheckTask(checkTask, dispute.checkTaskId);
  if (reopenable.kind === "refused") {
    blockWorkItem(task, {
      source: "check_disputed",
      checkTaskId: dispute.checkTaskId,
      checkName: dispute.check.name,
      reason: `${dispute.reason}\nThe check task cannot be reopened: ${reopenable.why}`,
    });
    return { kind: "unreopenable", why: reopenable.why };
  }
  if (task.status !== "InProgress") throw new InvalidStatusTransition(task.id, task.status, "Pending");
  const why = { disputed_check: dispute.check.name, disputed_revision: dispute.revision, dispute: dispute.disputes };
  reopenCheckTask(
    reopenable.item,
    task.id,
    disputeBrief(task.id, dispute),
    { disputedCheck: dispute.check.name, disputedRevision: dispute.revision, dispute: dispute.disputes },
    why,
  );
  awaitRewrittenChecks(task, dispute.checkTaskId, why);
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
