import type { StoredBlockedReason } from "../work-item-language/blocked-reason.js";
import type { WorkItem } from "../domain/index.js";
import type { TaskRefusal } from "./dispatch-run-deps.js";
import { projectBlockCause } from "../project-halt.js";

/** Every cause a dispatch's routing gives a task up for, after which its plan is repaired. */
export type GiveUpCause = Extract<
  StoredBlockedReason,
  {
    source:
      | "checks_stale"
      | "checks_rewrite_bound"
      | "check_disputed"
      | "suite_review_unresolved"
      | "environment_unavailable"
      | "environment_undefined"
      | "environment_change_needed"
      | "owner_unresolved"
      | "work_budget_spent"
      | "context_window_exceeded"
      | "no_wider_model"
      | "prerequisite_unresolved";
  }
>;

/**
 * Which route writes a dispatch give-up: `given-up`, routeAsGivenUp alone; `check-exit`, the exit of
 * the task's stale or disputed checks (exitStaleChecks), when the revision bound is reached; `owner-wait`,
 * the exit of a wait on an owner outside the task (awaitWork, the client hold), which never counts
 * the attempt as failed; `environment-exit`, the exit of a task whose implementer changed the environment
 * recipe (routeAsEnvironmentChange), past its bound or with no owner. Exhaustive: a cause added to GiveUpCause fails to compile here until its
 * route is named.
 */
export function giveUpRoute(cause: GiveUpCause): "given-up" | "check-exit" | "owner-wait" | "environment-exit" {
  switch (cause.source) {
    case "checks_stale":
    case "check_disputed":
    case "suite_review_unresolved":
    case "environment_unavailable":
    case "environment_undefined":
    case "owner_unresolved":
    case "work_budget_spent":
    case "context_window_exceeded":
    case "no_wider_model":
      return "given-up";
    case "checks_rewrite_bound":
      return "check-exit";
    case "prerequisite_unresolved":
      return "owner-wait";
    case "environment_change_needed":
      return "environment-exit";
  }
  const unrouted: never = cause;
  throw new GiveUpCauseUnrouted(unrouted);
}

/** A give-up cause no route is named for: a stored reason outside the type, read past its parse. */
class GiveUpCauseUnrouted extends Error {
  constructor(readonly cause: unknown) {
    super(`dispatch give-up cause ${JSON.stringify(cause)} has no route`);
    this.name = "GiveUpCauseUnrouted";
  }
}

/**
 * A give-up handed to routeAsGivenUp that another route writes: an owner-wait's end is the wait's own
 * exit, never a failure route, a check revision bound is the check exit's, and an environment change's
 * bound is the environment exit's. Ashara's own defect.
 */
export class GiveUpMisrouted extends Error {
  constructor(
    readonly taskId: string,
    readonly source: GiveUpCause["source"],
    readonly route: "check-exit" | "owner-wait" | "environment-exit",
  ) {
    super(`task ${taskId}: a ${source} give-up is written by its ${route} route, never by routeAsGivenUp`);
    this.name = "GiveUpMisrouted";
  }
}

/** The give-up cause of a task whose work budget the ledger found spent. */
export function workBudgetGiveUp(refusal: Extract<TaskRefusal, { kind: "task_work" }>): GiveUpCause {
  return {
    source: "work_budget_spent",
    budgetRequests: refusal.work.budgetRequests,
    drawnRequests: refusal.work.spentRequests + refusal.work.inFlightRequests,
    reason: refusal.reason,
  };
}

/** A refusal no spend cap made: the project's configuration, with the refusal's class and chain. */
export function configurationRefusal(task: WorkItem, refused: Error): TaskRefusal {
  const { errorClass, reason } = projectBlockCause(refused);
  return { kind: "configuration", projectId: task.projectId, errorClass, reason };
}
