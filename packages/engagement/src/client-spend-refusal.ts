import { BudgetExceeded, WorkBudgetSpent } from "@ashara/finance";
import type { ProjectId } from "@ashara/shared";

/**
 * The refusal by `projectId`'s own spend cap or work budget that `error` is or carries as a cause, or
 * null: a refusal of the deployment's cap, of another project's, or of a task's budget is not the
 * project's own.
 */
export function ownSpendRefusal(error: unknown, projectId: ProjectId): BudgetExceeded | WorkBudgetSpent | null {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if (current instanceof BudgetExceeded) return current.scope.kind === "project" && current.scope.projectId === projectId ? current : null;
    if (current instanceof WorkBudgetSpent) return current.scope.kind === "project" && current.scope.projectId === projectId ? current : null;
  }
  return null;
}
