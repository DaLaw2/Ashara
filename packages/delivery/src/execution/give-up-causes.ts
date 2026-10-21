import type { StoredBlockedReason } from "../work-item-language/blocked-reason.js";
import type { WorkItem } from "../domain/index.js";
import type { TaskRefusal } from "../types.js";
import { projectBlockCause } from "../project-halt.js";

/** The causes a dispatch gives a task up for, after which its plan is repaired. */
export type GiveUpCause = Extract<
  StoredBlockedReason,
  {
    source:
      | "checks_stale"
      | "check_disputed"
      | "suite_review_unresolved"
      | "environment_unavailable"
      | "environment_undefined"
      | "owner_unresolved"
      | "work_budget_spent"
      | "context_window_exceeded"
      | "no_wider_model";
  }
>;

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
