import type { ProjectId } from "@ashara/shared";
import { describeErrorChain } from "@ashara/shared";
import type { WorkItem } from "./domain/index.js";
import type { MergeKind } from "./work-item-language/blocked-reason.js";
import { assertValidTargetProjectPath } from "./acl/execution-infra-acl.js";
import { releaseMergedTaskCheckout, taskMergeOnMain } from "./acl/quality-acl.js";

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
 * against `workdirBase` before git touches it (the database is a trust boundary). Every other
 * failure throws: a main that cannot be read is never "nothing merged".
 */
export async function mergeOnMainOf(projects: TargetPathSource, workdirBase: string, item: WorkItem): Promise<string | null> {
  const target = await targetOf(projects, workdirBase, item);
  return target === null ? null : taskMergeOnMain(target, item.id);
}

/** The task's target, validated against `workdirBase`; null when its project records none. */
async function targetOf(projects: TargetPathSource, workdirBase: string, item: WorkItem): Promise<string | null> {
  const project = await projects.get(item.projectId);
  if (project === null) throw new TaskProjectMissing(item.id, item.projectId);
  if (project.workspacePath === null) return null;
  await assertValidTargetProjectPath(project.workspacePath, workdirBase);
  return project.workspacePath;
}

/** How a recorded commit settled the task, as its release logs it; a row from before migration 049 records no kind. */
function settledOn(kind: MergeKind | null): string {
  if (kind === "merged") return "merged on main";
  if (kind === "already_delivered") return "already delivered on main";
  return "recorded on main";
}

/**
 * A task whose merge on main is recorded where no dispatch released its checkout: its dispatch
 * faulted after the merge or its process died (mergeOnMainOf), or its record was written late
 * (parked-exits). Its work is on main, so no attempt resumes its branch, whatever its completion
 * meets next: the worktree and branch are released as soon as the record holds. A failure is a
 * leftover in the target, logged at warn with its cause, never a verdict.
 */
export async function releaseMergedTask(projects: TargetPathSource, workdirBase: string, item: WorkItem, kind: MergeKind | null): Promise<void> {
  const settled = settledOn(kind);
  let target: string | null;
  try {
    target = await targetOf(projects, workdirBase, item);
  } catch (e) {
    console.warn(`[${item.id}] ${settled}, but its target could not be read, so its worktree and branch are left: ${describeErrorChain(e)}`);
    return;
  }
  if (target === null) {
    console.warn(`[${item.id}] ${settled}, but its project now records no target, so its worktree and branch are left`);
    return;
  }
  await releaseMergedTaskCheckout(workdirBase, target, item.id, settled);
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
