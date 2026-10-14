import { z } from "zod";
import { describeErrorChain } from "@ashara/shared";
import { runHostGit } from "@ashara/execution-infra";
import type { TaskDescriptor } from "./execution-service.js";
import { targetRepo } from "./host-git.js";

/** execFile's rejection carries the child's stderr as a string; anything else carries none. */
function stderrOf(e: unknown): string {
  return typeof e === "object" && e !== null && "stderr" in e && typeof e.stderr === "string" ? e.stderr : "";
}

/** execFile's rejection carries the child's exit status as a number `code`; a spawn failure's is a string. */
function exitCodeOf(e: unknown): number | null {
  return typeof e === "object" && e !== null && "code" in e && typeof e.code === "number" ? e.code : null;
}

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

/**
 * Deletes the task's branch, so its next attempt starts a fresh one from main (createWorkdir)
 * instead of resuming it. Taken when the ownership gate finds the branch changed the environment
 * recipe (an environment task is requested for it, ADR-074 addendum 2 d66 b, d72 B1): that branch
 * holds edits made and checked on an environment that changes before the task runs again. Nothing
 * of it was merged. No branch
 * is nothing to do; a branch git refuses to delete (a worktree still holds it) throws.
 */
export async function discardTaskBranch(targetPath: string, taskId: string): Promise<"deleted" | "absent"> {
  const branch = taskBranchName(taskId);
  if (!(await branchExists(targetPath, branch))) return "absent";
  await runHostGit(targetRepo(targetPath), ["branch", "-D", branch]);
  return "deleted";
}

export async function branchExists(targetPath: string, branch: string): Promise<boolean> {
  try {
    await runHostGit(targetRepo(targetPath), ["rev-parse", "--verify", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/** Captures main's HEAD before a tentative merge, for the gates' pre/post diff. */
export async function captureMainHead(targetPath: string): Promise<string | null> {
  try {
    const { stdout } = await runHostGit(targetRepo(targetPath), ["rev-parse", "main"]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function getConflictingFiles(targetPath: string): Promise<string[]> {
  try {
    const { stdout } = await runHostGit(targetRepo(targetPath), ["diff", "--name-only", "--diff-filter=U"]);
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
      await runHostGit(targetRepo(targetPath), args);
    } catch (e) {
      const stderr = stderrOf(e);
      const message = describeErrorChain(e);
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
    await runHostGit(targetRepo(targetPath), ["merge", "--no-commit", "--no-ff", branch]);
    return { status: "clean" };
  } catch (e) {
    const errMsg = describeErrorChain(e);
    const stderr = stderrOf(e);
    console.warn(`[tentativeMerge] merge failed for ${branch}: ${errMsg.slice(0, 200)} | stderr: ${stderr.slice(0, 300)}`);
    const files = await getConflictingFiles(targetPath);
    if (files.length > 0) return { status: "conflict", files };
    return { status: "error", message: `${errMsg.slice(0, 300)}${stderr ? ` (stderr: ${stderr.slice(0, 200)})` : ""}` };
  }
}

/** A git object id as `rev-parse` prints it: SHA-1 or SHA-256, lowercase hex (migration 041's CHECK). */
const CommitIdSchema = z.string().regex(/^([0-9a-f]{40}|[0-9a-f]{64})$/);

/** `git rev-parse HEAD` after the merge commit printed something that is not one object id. */
class MergeCommitUnreadable extends Error {
  constructor(
    readonly taskId: string,
    readonly targetPath: string,
    readonly stdout: string,
  ) {
    super(`merge of task ${taskId} in ${targetPath} was committed, but rev-parse HEAD printed no commit id: ${JSON.stringify(stdout.slice(0, 200))}`);
    this.name = "MergeCommitUnreadable";
  }
}

/**
 * Commits the staged merge on main and returns the merge commit, read back from git: the task's
 * merge record (migration 041). A commit id that cannot be read throws, so the task is never
 * completed without its record.
 */
export async function commitMerge(targetPath: string, taskId: string): Promise<string> {
  await runHostGit(targetRepo(targetPath), ["commit", "-m", `merge: task ${taskId}`]);
  // Branch deletion deferred to cleanupWorkdir — worktree must be removed first
  // (git refuses to delete a branch that has an active worktree).
  const { stdout } = await runHostGit(targetRepo(targetPath), ["rev-parse", "HEAD"]);
  const commit = CommitIdSchema.safeParse(stdout.trim());
  if (!commit.success) throw new MergeCommitUnreadable(taskId, targetPath, stdout);
  return commit.data;
}

export async function abortMerge(targetPath: string): Promise<void> {
  try {
    await runHostGit(targetRepo(targetPath), ["checkout", "--", "."]);
  } catch (e) {
    console.warn(`[abortMerge] git checkout -- . failed: ${describeErrorChain(e)}`);
  }
  try {
    await runHostGit(targetRepo(targetPath), ["clean", "-fd"]);
  } catch (e) {
    console.warn(`[abortMerge] git clean -fd failed: ${describeErrorChain(e)}`);
  }
  await runHostGit(targetRepo(targetPath), ["merge", "--abort"]);
}

/**
 * Whether the checkout holds a staged merge (MERGE_HEAD). Asked of git rather than of the
 * filesystem: Z0 reads a target by path only through tree-read.ts. `rev-parse -q --verify` exits 1
 * with no output for a missing ref; any other failure is no answer and throws.
 */
export async function mergeInProgress(targetPath: string): Promise<boolean> {
  try {
    await runHostGit(targetRepo(targetPath), ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
    return true;
  } catch (e) {
    if (exitCodeOf(e) === 1 && stderrOf(e).trim() === "") return false;
    throw e;
  }
}

/** Crash recovery: an orphaned --no-commit merge or a stranded non-main checkout, left by a process that died mid-finalize. */
export async function recoverOrphanedMerge(targetPath: string): Promise<void> {
  if (await mergeInProgress(targetPath)) {
    try {
      await runHostGit(targetRepo(targetPath), ["merge", "--abort"]);
    } catch (e) {
      // Not the verdict: finalize resets the checkout next and refuses to merge while a merge is still staged.
      console.warn(`[recoverOrphanedMerge] git merge --abort failed in ${targetPath}: ${describeErrorChain(e)}`);
    }
  }
  try {
    const { stdout } = await runHostGit(targetRepo(targetPath), ["symbolic-ref", "--short", "HEAD"]);
    if (stdout.trim() !== "main") {
      await runHostGit(targetRepo(targetPath), ["checkout", "main"]);
    }
  } catch (e: unknown) {
    console.warn(`[recoverOrphanedMerge] Failed to check/restore HEAD in ${targetPath}: ${describeErrorChain(e)}`);
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
