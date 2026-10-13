import { TaskCheckRepository } from "@ashara/db";
import type { createDb } from "@ashara/db";
import type { TaskCheckStore } from "@ashara/development";

/** Quality's task-check store over task_checks, work_items and dependencies (migration 036). */
export function createTaskCheckStore(db: ReturnType<typeof createDb>): TaskCheckStore {
  const repo = new TaskCheckRepository(db);
  return {
    checkFilesOf: (projectId) => repo.checkFilesOf(projectId),
    completedOf: (projectId, exceptTaskId) => repo.completedOf(projectId, exceptTaskId),
    checkedTasksOf: (checkTaskId) => repo.checkedTasksOf(checkTaskId),
    append: (write) => repo.append(write),
    latest: (taskId) => repo.latest(taskId),
  };
}
