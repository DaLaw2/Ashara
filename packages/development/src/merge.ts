import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { TaskDescriptor } from "./execution-service.js";

const execFileAsync = promisify(execFile);

export type MergeResult =
  | { readonly status: "clean" }
  | { readonly status: "conflict"; readonly files: string[] }
  | { readonly status: "error"; readonly message: string };

export type CheckoutReset =
  | { readonly status: "clean" }
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

/** Captures main's HEAD before a tentative merge, for the gates' pre/post diff. */
export async function captureMainHead(targetPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "main"], { cwd: targetPath });
    return stdout.trim() || null;
  } catch {
    return null;
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

/**
 * Discards everything in the target's main checkout that HEAD does not contain.
 *
 * The main checkout is the merge queue's staging area, never a workspace: every
 * agent works in a linked worktree and commits there. The only writer here is
 * post-merge verify, which runs the PROJECT's own build and test commands in
 * this directory and therefore leaves whatever residue that stack leaves — a
 * rebuilt binary, a regenerated lockfile, a coverage directory. Anything of that
 * which is tracked makes git refuse the NEXT merge before it starts ("Your local
 * changes to the following files would be overwritten by merge"), so a task that
 * PASSED its own verification is rejected, retried, escalated and abandoned
 * (Run 39, the compiled `jot` binary). Restoring HEAD first makes the merge a
 * function of the two commits alone, whatever the project's build produces.
 *
 * `clean -fd` without `-x` deliberately keeps ignored paths: Ashara's control
 * directory and whatever the project ignores are not merge inputs.
 */
export async function resetCheckoutToHead(targetPath: string): Promise<CheckoutReset> {
  for (const args of [["reset", "--hard", "HEAD"], ["clean", "-fd"]]) {
    try {
      await execFileAsync("git", args, { cwd: targetPath });
    } catch (e) {
      const stderr = e instanceof Error && "stderr" in e && typeof e.stderr === "string" ? e.stderr : "";
      const message = e instanceof Error ? e.message : String(e);
      return {
        status: "error",
        message: `git ${args.join(" ")} failed in ${targetPath}: ${message.slice(0, 300)}${stderr ? ` (stderr: ${stderr.slice(0, 200)})` : ""}`,
      };
    }
  }
  return { status: "clean" };
}

/** `--no-commit` stages the merge without moving main; gates run before commitMerge/abortMerge decides its fate. */
export async function tentativeMerge(targetPath: string, branch: string): Promise<MergeResult> {
  try {
    await execFileAsync("git", ["merge", "--no-commit", "--no-ff", branch], { cwd: targetPath });
    return { status: "clean" };
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    const stderr = (e as { stderr?: string }).stderr ?? "";
    console.warn(`[tentativeMerge] merge failed for ${branch}: ${errMsg.slice(0, 200)} | stderr: ${stderr.slice(0, 300)}`);
    const files = await getConflictingFiles(targetPath);
    if (files.length > 0) return { status: "conflict", files };
    return { status: "error", message: `${errMsg.slice(0, 300)}${stderr ? ` (stderr: ${stderr.slice(0, 200)})` : ""}` };
  }
}

export async function commitMerge(targetPath: string, taskId: string): Promise<void> {
  await execFileAsync("git", ["commit", "-m", `merge: task ${taskId}`], { cwd: targetPath });
  // Branch deletion deferred to cleanupWorkdir — worktree must be removed first
  // (git refuses to delete a branch that has an active worktree).
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
  } catch (e: unknown) {
    console.warn(`[recoverOrphanedMerge] Failed to check/restore HEAD in ${targetPath}: ${e instanceof Error ? e.message : String(e)}`);
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
    "- Import statements, route registrations, and dependency declarations: keep the union of both sides",
    "- Remove ALL conflict markers (<<<<<<<, =======, >>>>>>>)",
    "- Do NOT delete working code from either side",
  ].join("\n");
}
