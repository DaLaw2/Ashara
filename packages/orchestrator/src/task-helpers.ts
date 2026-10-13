import { join } from "node:path";
import type { ProjectId } from "@ashara/shared";
import type { FailedApproachRepository } from "@ashara/db";
import type { WorkItem, WorkItemRepository } from "./acl/planning-acl.js";
import { PlanningService } from "./acl/planning-acl.js";
import { assertValidTargetProjectPath } from "./acl/development-acl.js";

// The slice of the Project Record that minting a workspace needs; ProjectRepository
// satisfies it. The vision is Engagement's record and is neither read nor written here.
export interface WorkspacePathStore {
  get(projectId: ProjectId): Promise<{ readonly workspacePath: string | null } | null>;
  recordWorkspacePath(projectId: ProjectId, path: string): Promise<string>;
}

/**
 * The project's target workspace (migration 024): the stored path, or one minted
 * under `workdirBase`, validated and recorded before it is returned. Null, with a
 * warning, when the project is missing or any step fails.
 */
export async function resolveTargetProjectPath(
  store: WorkspacePathStore,
  projectId: ProjectId,
  workdirBase: string,
): Promise<string | null> {
  try {
    const project = await store.get(projectId);
    if (!project) {
      console.warn(`[project ${projectId}] no project record; target project path unresolved`);
      return null;
    }

    if (project.workspacePath) {
      // The DB is a trust boundary: a stale/poisoned row (e.g. a path inside
      // the Ashara repo left over from earlier runs) must be rejected and
      // fail closed, never reused for destructive git sync/reset.
      await assertValidTargetProjectPath(project.workspacePath);
      return project.workspacePath;
    }

    const minted = join(workdirBase, "projects", projectId);
    await assertValidTargetProjectPath(minted);
    // Recorded at minting time, so a workdirBase change across a restart cannot
    // re-mint a divergent path. A racing dispatch that recorded first wins.
    const stored = await store.recordWorkspacePath(projectId, minted);
    if (stored !== minted) await assertValidTargetProjectPath(stored);
    console.log(`[project ${projectId}] target workspace path: ${stored}`);
    return stored;
  } catch (e) {
    console.warn(`[project ${projectId}] failed to resolve target project path:`, e);
    return null;
  }
}

/**
 * Records a failed_approaches row. `learned` defaults to `errorDetail` rather than
 * the pre-fix hard-coded "" (kl-t1 Q1 secondary defect) — the field is never left
 * empty, even for the plain thrown-orchestrator-error call site that has no richer
 * lesson to compose. Callers on the FailureRouter-routed path pass a real lesson
 * via `composeRoutedLesson` below.
 */
export async function recordFailedApproach(
  failedApproachRepo: Pick<FailedApproachRepository, "record">,
  workItemRepo: WorkItemRepository,
  task: WorkItem,
  errorDetail: string,
  learned?: string,
): Promise<void> {
  try {
    const epicId = await findEpicId(workItemRepo, task);
    // FINDING: taskSpec.area was read but never written by any producer — a silent
    // death of the shouldSplit class. The fallback was always taken. Removed the
    // dead read; only the fallback remains.
    const affectedArea = task.title.toLowerCase();

    await failedApproachRepo.record(
      task.id,
      epicId,
      task.title,
      `Task '${task.title}' attempted execution`,
      errorDetail,
      learned ?? errorDetail,
      affectedArea,
    );
  } catch (e) {
    console.warn(`[${task.id}] failed to record failed approach:`, e);
  }
}

/**
 * Deterministic "lesson" text for a FailureRouter-routed failure (kl-t1): every
 * decision — replan or abandon — means
 * this dispatch attempt did not succeed, so each is worth a lesson, composed with
 * zero LLM calls from data already in scope (no distillation — deferred by story
 * decision). Provenance-bearing: names the task, the action taken, and the
 * attempt count, so a later brief's "Failed Approaches" section reads as an
 * imperative lesson rather than a bare error string.
 */
export function composeRoutedLesson(
  title: string,
  action: "replan" | "abandon",
  attempts: number,
  detail: string,
): string {
  const verb = action === "abandon" ? "abandoned" : "replanned for another attempt";
  return `Task '${title}' was ${verb} after ${attempts} attempt(s): ${detail}`;
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
