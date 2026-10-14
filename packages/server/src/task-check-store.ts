import { TaskCheckRepository } from "@ashara/db";
import type { createDb } from "@ashara/db";
import type { SuiteReviewSource, TaskCheckStore } from "@ashara/development";

/** Quality's task-check store over task_checks, work_items and dependencies (migration 036). */
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
  };
}

/** What Quality's review of a plan revision's suites reads (migration 036, ADR-074 addendum 2 d71 c). */
export function createSuiteReviewSource(db: ReturnType<typeof createDb>): SuiteReviewSource {
  const repo = new TaskCheckRepository(db);
  return {
    checkTasksUnderReview: (reviewTaskId) => repo.checkTasksUnderReview(reviewTaskId),
    latest: (taskId) => repo.latest(taskId),
  };
}
