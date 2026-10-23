import type { createDb } from "@ashara/db";
import { CheckSetFreezeRepository, TaskCheckRepository } from "@ashara/quality";
import type { SuiteReviewSource, TaskCheckStore } from "@ashara/quality";

/** Quality's task-check store over task_checks, work_items and dependencies. */
export function createTaskCheckStore(db: ReturnType<typeof createDb>): TaskCheckStore {
  const repo = new TaskCheckRepository(db);
  return {
    checkFilesOf: (projectId) => repo.checkFilesOf(projectId),
    completedOf: (projectId, exceptTaskId) => repo.completedOf(projectId, exceptTaskId),
    checkedTasksOf: (checkTaskId) => repo.checkedTasksOf(checkTaskId),
    foundationOf: (checkTaskId) => repo.foundationOf(checkTaskId),
    storedOfProject: (projectId, exceptTaskId) => repo.storedOfProject(projectId, exceptTaskId),
    append: (write) => repo.append(write),
    latest: (taskId) => repo.latest(taskId),
    holdEvidenceOf: (taskId) => repo.holdEvidenceOf(taskId),
    recordSetRejection: (rejection) => repo.recordSetRejection(rejection),
  };
}

/** What Quality's review of a plan revision's suites reads: its task checks and its check-set freezes. */
export function createSuiteReviewSource(db: ReturnType<typeof createDb>): SuiteReviewSource {
  const repo = new TaskCheckRepository(db);
  const freezes = new CheckSetFreezeRepository(db);
  return {
    checkTasksUnderReview: (reviewTaskId) => repo.checkTasksUnderReview(reviewTaskId),
    latest: (taskId) => repo.latest(taskId),
    frozen: (reviewTaskId) => freezes.frozen(reviewTaskId),
  };
}
