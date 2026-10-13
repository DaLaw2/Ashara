import { join } from "node:path";
import type { ProjectId } from "@ashara/shared";
import type { FailedApproachRepository } from "@ashara/db";
import type { WorkItem, WorkItemRepository } from "./acl/planning-acl.js";
import { PlanningService } from "./acl/planning-acl.js";
import { assertValidTargetProjectPath } from "./acl/development-acl.js";

// Narrow structural view of the vision persistence needed to mint, validate,
// and persist a target project path. VisionRepository satisfies this; the
// segregated interface keeps the minting/persist logic unit-testable without a
// live database.
export interface ProjectPathStore {
  getCurrent(projectId: ProjectId): Promise<{ id: string } | null>;
  getProjectPath(visionId: string): Promise<string | null>;
  setProjectPath(visionId: string, path: string): Promise<void>;
}

/** Reads the path off the project's current vision (migration 014), never a global latest. */
export async function resolveTargetProjectPath(
  visionRepo: ProjectPathStore,
  projectId: ProjectId,
  workdirBase: string,
): Promise<string | null> {
  try {
    const vision = await visionRepo.getCurrent(projectId);
    if (!vision) {
      console.warn(`[project ${projectId}] no vision recorded; target project path unresolved`);
      return null;
    }

    const dbPath = await visionRepo.getProjectPath(vision.id);
    if (dbPath) {
      // The DB is a trust boundary: a stale/poisoned row (e.g. a path inside
      // the Ashara repo left over from earlier runs) must be rejected and
      // fail closed, never reused for destructive git sync/reset.
      await assertValidTargetProjectPath(dbPath);
      return dbPath;
    }

    const defaultPath = join(workdirBase, "projects", vision.id);
    await assertValidTargetProjectPath(defaultPath);
    // Persist at minting time (owner ruling: the target path is minted once,
    // validated, and persisted as the source of truth reused thereafter). This
    // closes the gap where the path was only stored after the first COMPLETED
    // task: a workdirBase change across a restart before any completion would
    // otherwise re-mint a divergent path. no-overwrite semantics preserved.
    await persistProjectPath(visionRepo, vision.id, defaultPath);
    return defaultPath;
  } catch (e) {
    console.warn(`[project ${projectId}] failed to resolve target project path:`, e);
    return null;
  }
}

async function persistProjectPath(
  visionRepo: ProjectPathStore,
  visionId: string,
  targetProjectPath: string,
): Promise<void> {
  try {
    const existing = await visionRepo.getProjectPath(visionId);
    if (!existing) {
      await visionRepo.setProjectPath(visionId, targetProjectPath);
      console.log(`Stored target project path for vision ${visionId}: ${targetProjectPath}`);
    }
  } catch (e) {
    console.warn("Failed to persist target project path:", e);
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
  failedApproachRepo: FailedApproachRepository,
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
