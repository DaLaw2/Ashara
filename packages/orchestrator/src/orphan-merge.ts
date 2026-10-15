import type { ProjectId } from "@ashara/shared";
import { describeErrorChain } from "@ashara/shared";
import type { WorkItem } from "./acl/planning-acl.js";
import { assertValidTargetProjectPath, taskMergeOnMain } from "./acl/development-acl.js";

/** The slice of the Project Record that reading a task's merge on main needs. */
export interface TargetPathSource {
  get(projectId: ProjectId): Promise<{ readonly workspacePath: string | null } | null>;
}

/** The project of a task has no record, so no target whose main could be read. */
class TaskProjectMissing extends Error {
  constructor(
    readonly taskId: string,
    readonly projectId: string,
  ) {
    super(`task ${taskId}'s project ${projectId} has no project record, so its target's main cannot be read`);
    this.name = "TaskProjectMissing";
  }
}

/**
 * The merge commit Z0's merge step made on the target's main for `item`, read from git, or null
 * when main holds none. A project with no workspace recorded has no target: the path is recorded
 * before any dispatch receives it (task-helpers.ts resolveTargetProjectPath), so nothing of the
 * task can be merged; nor in a target whose repository was never created (a dispatch that faulted
 * before its git init), which taskMergeOnMain asks of the filesystem. A stored path is validated
 * before git touches it (the database is a trust boundary). Every other failure throws: a main
 * that cannot be read is never "nothing merged".
 */
export async function mergeOnMainOf(projects: TargetPathSource, item: WorkItem): Promise<string | null> {
  const project = await projects.get(item.projectId);
  if (project === null) throw new TaskProjectMissing(item.id, item.projectId);
  if (project.workspacePath === null) return null;
  await assertValidTargetProjectPath(project.workspacePath);
  return taskMergeOnMain(project.workspacePath, item.id);
}

/**
 * A crash orphan Ashara's own machinery could not settle within its bound (fault class `ashara`,
 * ADR-080 d3 c): the project's cause on record when the task is blocked for it.
 */
export class OrphanUnreconciled extends Error {
  constructor(
    readonly taskId: string,
    readonly step: string,
    readonly attempts: number,
    options: { readonly cause: unknown },
  ) {
    super(
      `task ${taskId}, left InProgress by a dead process, could not be settled in ${attempts} attempt(s): ${step} failed: ` +
        describeErrorChain(options.cause),
      options,
    );
    this.name = "OrphanUnreconciled";
  }
}
