/**
 * Anti-Corruption Layer: Delivery's work-item language and published predicates.
 *
 * Quality decides the work Delivery hands it and reads the task specification Delivery wrote:
 * what a check task checks, the vision items it traces to, where a task came from, which statuses are
 * settled. It reads them
 * here, from Delivery's published-language entry alone, never Delivery's services, which call Quality.
 * Which tasks are goal tasks, the product scaffold or a review, and whether a project awaits a plan
 * repair or a correction's revision, it reads in Delivery's published predicates, which import
 * nothing of Delivery.
 */

export type { StoredTaskSpec } from "@ashara/delivery/work-item";
export { SETTLED_WORK_ITEM_STATUSES, parseWorkItemJsonb } from "@ashara/delivery/work-item";
export { completedGoalTasks, goalTaskSql, isProductScaffoldOrigin, isSprint0Origin, pendingCorrection, pendingRepair, productScaffoldTask, reviewTask } from "@ashara/delivery/predicates";
