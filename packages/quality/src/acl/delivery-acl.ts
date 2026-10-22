/**
 * Anti-Corruption Layer: Delivery's work-item language, published predicates and published reads.
 *
 * Quality decides the work Delivery hands it and reads the task specification Delivery wrote:
 * what a check task checks, the vision items it traces to, where a task came from. It reads them
 * here, from Delivery's published-language entry alone, never Delivery's services, which call Quality.
 * Which tasks are goal tasks or the product scaffold, whether a project's first plan is written,
 * whether it awaits a plan repair or a correction's revision, and its open halts, it reads in Delivery's published predicates; a
 * project's tasks, a check task's foundation and review, and the lock on the task row its check
 * revisions serialize on, in Delivery's published reads. Neither imports Delivery's services.
 */

export type { StoredTaskSpec } from "@ashara/delivery/work-item";
export { parseWorkItemJsonb } from "@ashara/delivery/work-item";
export { completedGoalTasks, firstPlanned, isProductScaffoldOrigin, isSprint0Origin, openHaltEpisodesWhere, pendingCorrection, pendingRepair } from "@ashara/delivery/predicates";
// What Quality reads of the board (a project's tasks, a check task's foundation and review, the
// task row its check revisions serialize on) it reads in Delivery's published reads, which import
// nothing of Delivery's services.
export {
  checkTasksOfReview,
  checkTasksUnderReview,
  completedGoalTaskExists,
  completedImplementationTaskIds,
  completedScaffolds,
  foundationCandidates,
  implementationTasksCheckedBy,
  lockTask,
  noTaskOpen,
  reviewTasksHeldBy,
  workItemSummaries,
} from "@ashara/delivery/reads";
