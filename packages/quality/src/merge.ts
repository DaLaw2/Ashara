import { z } from "zod";
import { describeErrorChain } from "@ashara/shared";
import { clearWorktreeSlot, mergeInProgress, runHostGit, targetRepo, treeHasEntry } from "@ashara/execution-infra";
import type { HostRepo } from "@ashara/execution-infra";

/** execFile's rejection carries the child's stderr as a string; anything else carries none. */
function stderrOf(e: unknown): string {
  return typeof e === "object" && e !== null && "stderr" in e && typeof e.stderr === "string" ? e.stderr : "";
}

/** execFile's rejection carries the child's exit status as a number `code`; a spawn failure's is a string. */
function exitCodeOf(e: unknown): number | null {
  return typeof e === "object" && e !== null && "code" in e && typeof e.code === "number" ? e.code : null;
}

type MergeResult =
  | { readonly status: "clean" }
  | { readonly status: "conflict"; readonly files: string[] }
  /** Git refused the merge for a reason other than a conflict, or could not say which files conflict: `cause` is its error. */
  | { readonly status: "error"; readonly message: string; readonly cause: unknown };

type CheckoutReset =
  | { readonly status: "clean" }
  | { readonly status: "error"; readonly message: string };

export function taskBranchName(taskId: string): string {
  return `task/${taskId}`;
}

/**
 * Deletes the task's branch whatever it holds (`-D`): a discarded branch holds commits main never
 * took. Taken when the ownership gate finds the branch changed the environment recipe (an
 * environment task is requested for it, ADR-074 addendum 2 d66 b, d72 B1), so the next attempt
 * starts a fresh branch from main (createWorkdir), and when the task is settled
 * (deleteSettledTaskBranch). No branch is nothing to do; a branch git refuses to delete (a worktree
 * still holds it) throws.
 */
export async function discardTaskBranch(targetPath: string, taskId: string): Promise<"deleted" | "absent"> {
  const branch = taskBranchName(taskId);
  if (!(await branchExists(targetPath, branch))) return "absent";
  await runHostGit(targetRepo(targetPath), ["branch", "-D", branch]);
  return "deleted";
}

/**
 * Deletes the branch of a settled task, its worktree already removed: merged into main, or
 * completed as already delivered there with its own work discarded. No attempt resumes it. The
 * task's verdict is reached, so a branch that cannot be deleted is a leftover in the target,
 * logged at warn with git's cause, never a verdict.
 */
export async function deleteSettledTaskBranch(targetPath: string, taskId: string, settled: string): Promise<void> {
  try {
    await discardTaskBranch(targetPath, taskId);
  } catch (e) {
    console.warn(`[${taskId}] the branch ${taskBranchName(taskId)} of a task ${settled} could not be deleted and is left in ${targetPath}; the settled-branch release deletes it once the task is Completed: ${describeErrorChain(e)}`);
  }
}

/**
 * Releases what a task whose work is recorded on main (`settled`: merged there, or already
 * delivered there) still holds in the target when no dispatch released it (its dispatch faulted, its
 * process died, or its record was written late): the worktree slot under `workdirBase` (git refuses
 * to delete a branch a worktree holds), then the branch. Its work is on main, so a failure leaves a
 * leftover, logged at warn with its cause, never a verdict.
 */
export async function releaseMergedTaskCheckout(workdirBase: string, targetPath: string, taskId: string, settled: string): Promise<void> {
  try {
    await clearWorktreeSlot(workdirBase, targetPath, taskBranchName(taskId));
  } catch (e) {
    console.warn(`[${taskId}] the worktree slot of a task ${settled} could not be cleared, so its branch ${taskBranchName(taskId)} is left in ${targetPath}; the settled-branch release clears both once the task is Completed: ${describeErrorChain(e)}`);
    return;
  }
  await deleteSettledTaskBranch(targetPath, taskId, settled);
}

/**
 * Whether the branch exists. `rev-parse -q --verify` exits 1 with no output for a missing ref; any
 * other failure is no answer and throws, never read as "absent" (a resumed branch recreated with -b).
 */
export async function branchExists(targetPath: string, branch: string): Promise<boolean> {
  try {
    await runHostGit(targetRepo(targetPath), ["rev-parse", "-q", "--verify", `refs/heads/${branch}`]);
    return true;
  } catch (e) {
    if (exitCodeOf(e) === 1 && stderrOf(e).trim() === "") return false;
    throw e;
  }
}

/** The files the staged merge left unmerged; throws when git cannot say, never reads that as "none". */
async function getConflictingFiles(targetPath: string): Promise<string[]> {
  const { stdout } = await runHostGit(targetRepo(targetPath), ["diff", "--name-only", "--diff-filter=U"]);
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
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
 * PASSED its own verification is rejected, retried, escalated and abandoned.
 * Restoring HEAD first makes the merge a
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

/** `--no-commit` stages the merge without moving main; gates run before commitMerge or finalize's reset to HEAD decides its fate. */
export async function tentativeMerge(targetPath: string, branch: string): Promise<MergeResult> {
  try {
    await runHostGit(targetRepo(targetPath), ["merge", "--no-commit", "--no-ff", branch]);
    return { status: "clean" };
  } catch (e) {
    const errMsg = describeErrorChain(e);
    const stderr = stderrOf(e);
    const message = `${errMsg.slice(0, 300)}${stderr ? ` (stderr: ${stderr.slice(0, 200)})` : ""}`;
    let files: string[];
    try {
      files = await getConflictingFiles(targetPath);
    } catch (diffError) {
      console.warn(`[tentativeMerge] merge of ${branch} failed and its conflicting files could not be listed: ${message} | ${describeErrorChain(diffError)}`);
      return { status: "error", message: `${message}; and the conflicting files could not be listed: ${describeErrorChain(diffError).slice(0, 300)}`, cause: diffError };
    }
    // A conflict is the task's outcome, not a failure of git: finalize logs it with its verdict.
    if (files.length > 0) return { status: "conflict", files };
    console.warn(`[tentativeMerge] merge of ${branch} failed without a conflict: ${message}`);
    return { status: "error", message, cause: e };
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
  await runHostGit(targetRepo(targetPath), ["commit", "-m", mergeSubject(taskId)]);
  // The branch is deleted after the worktree is removed (deleteSettledTaskBranch): git refuses to
  // delete a branch a worktree holds.
  const { stdout } = await runHostGit(targetRepo(targetPath), ["rev-parse", "HEAD"]);
  const commit = CommitIdSchema.safeParse(stdout.trim());
  if (!commit.success) throw new MergeCommitUnreadable(taskId, targetPath, stdout);
  return commit.data;
}

/** The subject commitMerge writes on a task's merge commit: what taskMergeOnMain finds main's merges by. */
function mergeSubject(taskId: string): string {
  return `merge: task ${taskId}`;
}

/** A line of `git log` output whose commit field is not a commit id. */
class CommitIdUnparseable extends Error {
  constructor(readonly field: string | undefined) {
    super(`not a commit id: ${JSON.stringify(field)}`);
    this.name = "CommitIdUnparseable";
  }
}

/** Git gave no answer about the target's main: never read as "nothing merged". */
class MainUnreadable extends Error {
  constructor(
    readonly taskId: string,
    readonly targetPath: string,
    readonly step: string,
    options: { readonly cause: unknown },
  ) {
    super(`main of ${targetPath} could not be read for a merge of task ${taskId}: ${step}: ${describeErrorChain(options.cause)}`, options);
    this.name = "MainUnreadable";
  }
}

/**
 * The merge commit commitMerge made on main for the task, read from git: the newest commit on
 * main whose subject is the task's merge subject, or null when main holds none. A target whose
 * repository does not exist yet (no target directory, or no `.git` in it: what ensureTargetGitInit
 * creates before any merge) holds no merge; that is asked of the filesystem first, so git is never
 * run in a directory that is not there (its spawn would fail ENOENT, which says nothing about
 * main). A repository with no main branch (`rev-parse -q --verify` exits 1 with nothing on stderr)
 * holds no merge. A probe that cannot tell, and any other failure of git, is MainUnreadable.
 */
export async function taskMergeOnMain(targetPath: string, taskId: string): Promise<string | null> {
  let repositoryExists: boolean;
  try {
    repositoryExists = await treeHasEntry(targetPath, ".git");
  } catch (e) {
    throw new MainUnreadable(taskId, targetPath, "probe the target's repository", { cause: e });
  }
  if (!repositoryExists) return null;
  const repo = targetRepo(targetPath);
  try {
    await runHostGit(repo, ["rev-parse", "-q", "--verify", "refs/heads/main^{commit}"]);
  } catch (e) {
    if (exitCodeOf(e) === 1 && stderrOf(e).trim() === "") return null;
    throw new MainUnreadable(taskId, targetPath, "rev-parse main", { cause: e });
  }
  let stdout: string;
  try {
    ({ stdout } = await runHostGit(repo, ["log", "--fixed-strings", `--grep=${mergeSubject(taskId)}`, "--format=%H%x1f%s", "refs/heads/main", "--"]));
  } catch (e) {
    throw new MainUnreadable(taskId, targetPath, "log main", { cause: e });
  }
  for (const line of stdout.split("\n")) {
    const [commit, subject] = line.split("\x1f");
    if (subject !== mergeSubject(taskId)) continue;
    const parsed = CommitIdSchema.safeParse(commit);
    if (!parsed.success) throw new MainUnreadable(taskId, targetPath, "log main", { cause: new CommitIdUnparseable(commit) });
    return parsed.data;
  }
  return null;
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
 * merges, the second's branch can conflict with the main it lands on.
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
async function startMainMerge(repo: HostRepo, taskId: string, conflict: MainConflict): Promise<void> {
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
 * before the next attempt. A branch whose tentative merge with main failed the
 * post-merge verification (a tree regression) would otherwise be retried on a tree that never held
 * main's newer work: there the failure cannot reproduce, the attempt's own gate passes again, and
 * the merge fails again for the same reason. With main merged in, the attempt works on the tree the
 * failure was found on, so it can find which side broke it and repair it. "already" when the branch
 * holds main. Any git failure, a conflict included (main moved since conflictWithMain), aborts the
 * merge and throws ConflictRetryUnprepared: the branch is never dispatched without main.
 */
async function mergeMainIntoBranch(repo: HostRepo, taskId: string): Promise<"merged" | "already"> {
  try {
    await runHostGit(repo, ["merge-base", "--is-ancestor", "refs/heads/main", "HEAD"]);
    return "already";
  } catch (e) {
    if (exitCodeOf(e) !== 1) throw new ConflictRetryUnprepared(taskId, "merge-base --is-ancestor", describeErrorChain(e), { cause: e });
  }
  try {
    await runHostGit(repo, ["merge", "--no-ff", "--no-edit", "-m", `Merge main into task/${taskId} for its next attempt`, "--end-of-options", "refs/heads/main"]);
  } catch (e) {
    // A merge git refused before it began stages nothing, and `merge --abort` on it fails: abort only one in progress.
    try {
      if (await mergeInProgress(repo)) await runHostGit(repo, ["merge", "--abort"]);
    } catch (abortError) {
      console.warn(`[mergeMainIntoBranch] the failed merge of main into task ${taskId}'s branch could not be aborted: ${describeErrorChain(abortError)}`);
    }
    throw new ConflictRetryUnprepared(taskId, "merge", describeErrorChain(e), { cause: e });
  }
  return "merged";
}

/**
 * How a resumed task branch's worktree is made ready before its next attempt (createWorkdirForRetry).
 * When the branch conflicts with main, main's merge is left staged with the conflicts in the files
 * (startMainMerge): re-dispatching the branch unchanged would only conflict again.
 * Otherwise main's newer work is merged into it as a commit (mergeMainIntoBranch): the attempt
 * works on the tree its merge will be verified as. Either throws ConflictRetryUnprepared when the
 * merge cannot be prepared.
 */
export function mainMergedForRetry(taskId: string, conflict: MainConflict | null): (repo: HostRepo) => Promise<unknown> {
  return (repo) => (conflict !== null ? startMainMerge(repo, taskId, conflict) : mergeMainIntoBranch(repo, taskId));
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
