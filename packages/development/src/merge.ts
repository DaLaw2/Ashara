import { z } from "zod";
import { describeErrorChain } from "@ashara/shared";
import { runHostGit } from "@ashara/execution-infra";
import type { HostRepo } from "@ashara/execution-infra";
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
export async function mergeInProgress(repo: HostRepo): Promise<boolean> {
  try {
    await runHostGit(repo, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
    return true;
  } catch (e) {
    if (exitCodeOf(e) === 1 && stderrOf(e).trim() === "") return false;
    throw e;
  }
}

/** Crash recovery: an orphaned --no-commit merge or a stranded non-main checkout, left by a process that died mid-finalize. */
export async function recoverOrphanedMerge(targetPath: string): Promise<void> {
  if (await mergeInProgress(targetRepo(targetPath))) {
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

/** execFile's rejection carries the child's stdout as a string from runHostGit (`text`). */
function stdoutOf(e: unknown): string {
  return typeof e === "object" && e !== null && "stdout" in e && typeof e.stdout === "string" ? e.stdout : "";
}

function nulSeparated(stdout: string): string[] {
  return stdout.split("\0").filter((entry) => entry.length > 0);
}

/**
 * A task branch that does not merge with main: the main commit it was tried against and the files
 * git could not combine. Two tasks dispatched in one batch start from the same main; once the first
 * merges, the second's branch can conflict with the main it lands on (w12b D2).
 */
export interface MainConflict {
  readonly mainCommit: string;
  readonly files: readonly string[];
}

/**
 * The next attempt of a task whose branch conflicts with main could not be prepared with that
 * conflict in its worktree. The branch is never dispatched as it is instead, since it would conflict
 * again by construction: planning routes the task to plan repair (MERGE_RETRY_UNPREPARED).
 */
export class ConflictRetryUnprepared extends Error {
  constructor(
    readonly taskId: string,
    readonly step: string,
    readonly detail: string,
    options?: { readonly cause?: unknown },
  ) {
    super(`the merge of main into the branch of task ${taskId} could not be prepared: ${step}: ${detail}`, options);
    this.name = "ConflictRetryUnprepared";
  }
}

/**
 * Whether the task's branch conflicts with main now, asked of git's object store alone
 * (`merge-tree`, no work tree touched): null when it merges cleanly, else main's commit and the
 * conflicting files. Any other answer from git throws ConflictRetryUnprepared.
 */
export async function conflictWithMain(targetPath: string, taskId: string): Promise<MainConflict | null> {
  const repo = targetRepo(targetPath);
  let main: string;
  try {
    const { stdout } = await runHostGit(repo, ["rev-parse", "--verify", "--end-of-options", "refs/heads/main^{commit}"]);
    main = CommitIdSchema.parse(stdout.trim());
  } catch (e) {
    throw new ConflictRetryUnprepared(taskId, "rev-parse main", describeErrorChain(e), { cause: e });
  }
  try {
    await runHostGit(repo, ["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", main, `refs/heads/${taskBranchName(taskId)}`]);
    return null;
  } catch (e) {
    // A conflicted merge exits 1 and prints the merged tree, then each conflicted path.
    if (exitCodeOf(e) !== 1) throw new ConflictRetryUnprepared(taskId, "merge-tree", describeErrorChain(e), { cause: e });
    const files = nulSeparated(stdoutOf(e)).slice(1);
    if (files.length === 0) throw new ConflictRetryUnprepared(taskId, "merge-tree", "it reported a conflict but named no file");
    return { mainCommit: main, files: [...new Set(files)].sort() };
  }
}

/**
 * Merges `conflict.mainCommit` into the worktree's branch and leaves the merge staged, git's
 * conflict markers in the files it could not combine, for the implementer to resolve; the attempt's
 * commit (commitAllChanges) concludes it. Git must leave unmerged exactly the files `conflict` names
 * (the files the brief names), or ConflictRetryUnprepared is thrown.
 */
export async function startMainMerge(repo: HostRepo, taskId: string, conflict: MainConflict): Promise<void> {
  let merged = false;
  try {
    await runHostGit(repo, ["merge", "--no-ff", "--no-commit", "--end-of-options", conflict.mainCommit]);
    merged = true;
  } catch (e) {
    if (exitCodeOf(e) !== 1) throw new ConflictRetryUnprepared(taskId, "merge", describeErrorChain(e), { cause: e });
  }
  if (merged) throw new ConflictRetryUnprepared(taskId, "merge", `main ${conflict.mainCommit} merged without the conflict merge-tree found`);
  let unmerged: string[];
  try {
    const { stdout } = await runHostGit(repo, ["diff", "--name-only", "-z", "--diff-filter=U"]);
    unmerged = [...new Set(nulSeparated(stdout))].sort();
  } catch (e) {
    throw new ConflictRetryUnprepared(taskId, "diff --diff-filter=U", describeErrorChain(e), { cause: e });
  }
  if (unmerged.join("\0") !== conflict.files.join("\0")) {
    throw new ConflictRetryUnprepared(
      taskId,
      "merge",
      `git left ${unmerged.length === 0 ? "no file" : unmerged.join(", ")} unmerged, but merge-tree named ${conflict.files.join(", ")}`,
    );
  }
}

/**
 * Merges main into a resumed task branch that merges with it cleanly, as a commit on the branch,
 * before the next attempt (lessons digest P6). A branch whose tentative merge with main failed the
 * post-merge verification (a tree regression) would otherwise be retried on a tree that never held
 * main's newer work: there the failure cannot reproduce, the attempt's own gate passes again, and
 * the merge fails again for the same reason. With main merged in, the attempt works on the tree the
 * failure was found on, so it can find which side broke it and repair it. "already" when the branch
 * holds main. Any git failure, a conflict included (main moved since conflictWithMain), aborts the
 * merge and throws ConflictRetryUnprepared: the branch is never dispatched without main.
 */
export async function mergeMainIntoBranch(repo: HostRepo, taskId: string): Promise<"merged" | "already"> {
  try {
    await runHostGit(repo, ["merge-base", "--is-ancestor", "refs/heads/main", "HEAD"]);
    return "already";
  } catch (e) {
    if (exitCodeOf(e) !== 1) throw new ConflictRetryUnprepared(taskId, "merge-base --is-ancestor", describeErrorChain(e), { cause: e });
  }
  try {
    await runHostGit(repo, ["merge", "--no-ff", "--no-edit", "-m", `Merge main into task/${taskId} for its next attempt`, "--end-of-options", "refs/heads/main"]);
  } catch (e) {
    try {
      await runHostGit(repo, ["merge", "--abort"]);
    } catch (abortError) {
      console.warn(`[mergeMainIntoBranch] git merge --abort failed for task ${taskId}: ${describeErrorChain(abortError)}`);
    }
    throw new ConflictRetryUnprepared(taskId, "merge", describeErrorChain(e), { cause: e });
  }
  return "merged";
}

/** A conflict marker line as git writes one; its length is the conflict-marker-size attribute, 7 by default. */
const CONFLICT_MARKER = "^(<{7,}|>{7,})( |$)";

/**
 * Stages everything in the worktree and returns those of `files` whose staged content still holds a
 * conflict marker line: read from the index, never from the cell-written tree by path.
 */
export async function stagedConflictMarkers(repo: HostRepo, files: readonly string[]): Promise<string[]> {
  await runHostGit(repo, ["add", "-A"]);
  try {
    const { stdout } = await runHostGit(repo, ["--literal-pathspecs", "grep", "--cached", "-l", "-z", "-E", "-e", CONFLICT_MARKER, "--", ...files]);
    return nulSeparated(stdout).sort();
  } catch (e) {
    // grep exits 1 with nothing on stderr when no line matched; any other failure is no answer.
    if (exitCodeOf(e) === 1 && stderrOf(e).trim() === "") return [];
    throw e;
  }
}

/** The brief's section for an attempt that starts with main merged into its branch and conflicts left. */
export function formatConflictForBrief(conflict: MainConflict): string {
  return [
    "## Merge with main in progress",
    "Another task's work reached main after your branch left it, and it changed the same files. Main has been",
    "merged into your worktree, and git could not combine these files:",
    ...conflict.files.map((file) => `- ${file}`),
    "",
    "A file both sides changed holds conflict markers (<<<<<<<, =======, >>>>>>>). A file one side deleted, or a",
    "file git cannot merge line by line, holds no markers: whatever your worktree holds for it when you finish",
    "is its resolution, so keep it, rewrite it or delete it deliberately.",
    "",
    "Resolve every one: keep what main's side does and what your task's side does, and remove every conflict",
    "marker. Then finish your task as usual. Your work is merged only once no marker is left in these files",
    "and your task's checks pass on the merge.",
  ].join("\n");
}
