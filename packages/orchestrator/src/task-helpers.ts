import { join } from "node:path";
import type { ProjectId } from "@ashara/shared";
import type { WorkItem, WorkItemRepository } from "./acl/planning-acl.js";
import { PlanningService } from "./acl/planning-acl.js";
import { assertValidTargetProjectPath, InvalidTargetProjectPath } from "./acl/execution-infra-acl.js";

// The slice of the Project Record that minting a workspace needs; ProjectRepository
// satisfies it. The vision is Engagement's record and is neither read nor written here.
export interface WorkspacePathStore {
  get(projectId: ProjectId): Promise<{ readonly workspacePath: string | null } | null>;
  recordWorkspacePath(projectId: ProjectId, path: string): Promise<string>;
}

/**
 * A project's target workspace, or why it has none: no project record, or a path the
 * validation refused. A refused workspace is never replaced by another directory.
 */
type TargetWorkspace =
  | { readonly kind: "resolved"; readonly path: string }
  | { readonly kind: "rejected"; readonly reason: string };

/**
 * The project's target workspace (migration 024): the stored path, or one minted
 * under `workdirBase`, validated and recorded before it is returned. Any failure
 * other than a missing record or a refused path (a database error) is thrown.
 */
export async function resolveTargetProjectPath(
  store: WorkspacePathStore,
  projectId: ProjectId,
  workdirBase: string,
): Promise<TargetWorkspace> {
  const project = await store.get(projectId);
  if (!project) {
    return { kind: "rejected", reason: `project ${projectId} has no project record, so no target workspace` };
  }

  try {
    if (project.workspacePath) {
      // The DB is a trust boundary: a stored path outside the workdir base (a
      // poisoned row, or one recorded under a base since moved) is rejected and
      // fails closed, never reused for destructive git sync/reset.
      await assertValidTargetProjectPath(project.workspacePath, workdirBase);
      return { kind: "resolved", path: project.workspacePath };
    }

    const minted = join(workdirBase, "projects", projectId);
    await assertValidTargetProjectPath(minted, workdirBase);
    // Recorded at minting time, so a workdirBase change across a restart cannot
    // re-mint a divergent path: the stored one is refused instead. A racing
    // dispatch that recorded first wins.
    const stored = await store.recordWorkspacePath(projectId, minted);
    if (stored !== minted) await assertValidTargetProjectPath(stored, workdirBase);
    console.log(`[project ${projectId}] target workspace path: ${stored}`);
    return { kind: "resolved", path: stored };
  } catch (e) {
    if (!(e instanceof InvalidTargetProjectPath)) throw e;
    return { kind: "rejected", reason: e.message };
  }
}

export async function findEpicId(
  workItemRepo: WorkItemRepository,
  task: WorkItem,
): Promise<string | null> {
  let currentId = task.parentId;
  while (currentId) {
    const parent = await PlanningService.findWorkItem(workItemRepo, currentId);
    if (!parent) break;
    if (parent.level === "Epic") return parent.id;
    currentId = parent.parentId;
  }
  return null;
}
