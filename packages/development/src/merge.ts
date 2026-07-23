import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import type { ExecutionEventSink, TaskDescriptor } from "./execution-service.js";
import { commitAllChanges, ensureTargetGitInit, hasGitCommits } from "./workspace.js";

const execFileAsync = promisify(execFile);

interface SyncResult {
  readonly success: boolean;
  readonly error?: string;
}

export type MergeResult =
  | { readonly status: "clean" }
  | { readonly status: "conflict"; readonly files: string[] }
  | { readonly status: "error"; readonly message: string };

export function taskBranchName(taskId: string): string {
  return `task/${taskId}`;
}

export async function branchExists(targetPath: string, branch: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["rev-parse", "--verify", `refs/heads/${branch}`], {
      cwd: targetPath,
    });
    return true;
  } catch {
    return false;
  }
}

/** Idempotent: creates task/{taskId} from main, or no-ops if it already exists. */
export async function createTaskBranch(targetPath: string, taskId: string): Promise<void> {
  await ensureTargetGitInit(targetPath);
  const branch = taskBranchName(taskId);
  if (await branchExists(targetPath, branch)) return;
  await execFileAsync("git", ["branch", branch, "main"], { cwd: targetPath });
}

/** Captures main's HEAD before a tentative merge, for the gates' pre/post diff. */
export async function captureMainHead(targetPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "main"], { cwd: targetPath });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function generatePatch(workDir: string, seedCommit: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "git", ["diff", "--binary", seedCommit, "HEAD"],
    { cwd: workDir, maxBuffer: 50 * 1024 * 1024 },
  );
  return stdout;
}

async function applyPatch(targetPath: string, patch: string): Promise<void> {
  if (patch.length === 0) return;
  const proc = execFile("git", ["apply", "--binary", "--index"], { cwd: targetPath, maxBuffer: 50 * 1024 * 1024 });
  proc.stdin?.write(patch);
  proc.stdin?.end();
  await new Promise<void>((resolve, reject) => {
    proc.on("close", (code) => code === 0 ? resolve() : reject(new Error(`git apply failed with exit code ${code}`)));
    proc.on("error", reject);
  });
}

export async function syncToTaskBranch(
  eventSink: ExecutionEventSink | undefined,
  workDir: string,
  targetProjectPath: string,
  taskId: string,
  attempt: number,
  seedCommit: string,
): Promise<SyncResult> {
  const branch = taskBranchName(taskId);
  try {
    await execFileAsync("git", ["checkout", branch], { cwd: targetProjectPath });

    try {
      await commitAllChanges(workDir, `ashara: pre-sync commit for task ${taskId}`);
    } catch {
      // nothing to commit
    }

    if (await hasGitCommits(workDir)) {
      const patch = await generatePatch(workDir, seedCommit);
      await applyPatch(targetProjectPath, patch);
    }

    const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
      cwd: targetProjectPath,
    });
    if (stdout.trim().length > 0) {
      await execFileAsync("git", ["commit", "-m", `task ${taskId} attempt ${attempt}`], {
        cwd: targetProjectPath,
      });
    }

    await execFileAsync("git", ["checkout", "main"], { cwd: targetProjectPath });

    console.log(`[${taskId}] synced results to ${branch} in ${targetProjectPath}`);
    eventSink?.emit({ event: "sync_success", taskId, attempt, targetProject: targetProjectPath });
    return { success: true };
  } catch (e) {
    const errorMsg = String(e).slice(0, 500);
    console.warn(`[${taskId}] failed to sync to ${branch}:`, e);
    // Best-effort: never leave the target stranded off main after a failed sync.
    await execFileAsync("git", ["checkout", "main"], { cwd: targetProjectPath }).catch(() => {});
    eventSink?.emit({ event: "sync_failed", taskId, attempt, error: errorMsg });
    return { success: false, error: errorMsg };
  }
}

async function getConflictingFiles(targetPath: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["diff", "--name-only", "--diff-filter=U"], {
      cwd: targetPath,
    });
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

/** `--no-commit` stages the merge without moving main; gates run before commitMerge/abortMerge decides its fate. */
export async function tentativeMerge(targetPath: string, branch: string): Promise<MergeResult> {
  try {
    await execFileAsync("git", ["merge", "--no-commit", "--no-ff", branch], { cwd: targetPath });
    return { status: "clean" };
  } catch (e) {
    const files = await getConflictingFiles(targetPath);
    if (files.length > 0) return { status: "conflict", files };
    return { status: "error", message: String(e).slice(0, 500) };
  }
}

export async function commitMerge(targetPath: string, taskId: string): Promise<void> {
  await execFileAsync("git", ["commit", "-m", `merge: task ${taskId}`], { cwd: targetPath });
  await execFileAsync("git", ["branch", "-d", taskBranchName(taskId)], { cwd: targetPath });
}

export async function abortMerge(targetPath: string): Promise<void> {
  try {
    await execFileAsync("git", ["checkout", "--", "."], { cwd: targetPath });
  } catch (e) {
    console.warn(`[abortMerge] git checkout -- . failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    await execFileAsync("git", ["clean", "-fd"], { cwd: targetPath });
  } catch (e) {
    console.warn(`[abortMerge] git clean -fd failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  await execFileAsync("git", ["merge", "--abort"], { cwd: targetPath });
}

/** Crash recovery: an orphaned --no-commit merge or a stranded non-main checkout, left by a process that died mid-finalize. */
export async function recoverOrphanedMerge(targetPath: string): Promise<void> {
  const mergeHeadExists = await access(join(targetPath, ".git", "MERGE_HEAD")).then(
    () => true,
    () => false,
  );
  if (mergeHeadExists) {
    await execFileAsync("git", ["merge", "--abort"], { cwd: targetPath }).catch(() => {});
  }
  try {
    const { stdout } = await execFileAsync("git", ["symbolic-ref", "--short", "HEAD"], {
      cwd: targetPath,
    });
    if (stdout.trim() !== "main") {
      await execFileAsync("git", ["checkout", "main"], { cwd: targetPath });
    }
  } catch {
    // no commits yet, or detached HEAD with nothing to recover onto
  }
}

/**
 * Formats a merge conflict into failure context. No dedicated merge-agent
 * subprocess exists yet (conflicts are near-zero under sequential dispatch,
 * ADR-035) — this text becomes the task's gateFailureContext, which the
 * existing priorAttemptFailure mechanism carries into the retry agent's brief.
 */
export function buildMergeAgentBrief(task: TaskDescriptor, conflictFiles: string[]): string {
  const goal = typeof task.taskSpec?.goal === "string" ? task.taskSpec.goal : task.title;
  return [
    "# Merge Conflict Resolution",
    "",
    "## Task being merged",
    `Title: ${task.title}`,
    `Goal: ${goal}`,
    "",
    "## Conflicting files",
    ...conflictFiles.map((f) => `- ${f}`),
    "",
    "## Rules",
    '- Preserve BOTH sides\' changes: "ours" (main, previously completed tasks) and "theirs" (this task\'s branch)',
    "- Imports, route registrations, and package.json dependencies: keep the union of both sides",
    "- Remove ALL conflict markers (<<<<<<<, =======, >>>>>>>)",
    "- Do NOT delete working code from either side",
  ].join("\n");
}
