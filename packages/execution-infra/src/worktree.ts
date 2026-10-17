import { readdir, access, mkdir, rm } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { describeErrorChain } from "@ashara/shared";
import { canonicalizeAllowingMissing, withTargetCheckout } from "./checkout-lock.js";
import { initHostRepo, runHostGit, type HostRepo } from "./host-git.js";
import { freshWorktreeRepo, targetRepo } from "./target-repo.js";
import { listTreeDir, treeHasDirectory } from "./tree-read.js";

export interface WorkdirInfo {
  readonly workDir: string;
  readonly taskBranch: string;
  /** Resolved before any cell mounts workDir; every later git call on the worktree goes through it. */
  readonly repo: HostRepo;
}

class WorkspaceError extends Error {
  constructor(
    public readonly operation: string,
    public readonly context: { readonly targetPath?: string; readonly workDir?: string; readonly taskBranch?: string },
    cause?: unknown,
  ) {
    super(`workspace ${operation} failed: ${cause === undefined ? "no cause given" : describeErrorChain(cause)}`, { cause });
    this.name = "WorkspaceError";
  }
}

/** execFile's rejection carries the child's stderr as a string; anything else carries none. */
function stderrOf(e: unknown): string {
  return typeof e === "object" && e !== null && "stderr" in e && typeof e.stderr === "string" ? e.stderr : "";
}

/** execFile's rejection carries the child's exit status as a number `code`; a spawn failure's is a string. */
function exitCodeOf(e: unknown): number | null {
  return typeof e === "object" && e !== null && "code" in e && typeof e.code === "number" ? e.code : null;
}

/** The directory a branch's worktree is created at under `base`. */
function workdirOf(base: string, branch: string): string {
  return join(base, branch.replace(/\//g, "-"));
}

/**
 * Clears the slot a branch's worktree is created at of what a crash or a faulted cleanup left: its
 * directory, and every registration whose directory is gone (`worktree prune`). A registration
 * left behind would make every later `worktree add` there, and the deletion of the branch it
 * holds, refuse, and no attempt could ever be dispatched again. Nothing of a worktree at the slot
 * is kept: an attempt's work is kept only as commits on its branch. A failure here throws (rm's or
 * git's): Z0's own, never read as a clear slot.
 */
export async function clearWorktreeSlot(base: string, targetProjectPath: string, branch: string): Promise<void> {
  await rm(workdirOf(base, branch), { recursive: true, force: true });
  await runHostGit(targetRepo(targetProjectPath), ["worktree", "prune"]);
}

/**
 * A fresh worktree of `taskBranch`, created from main under `base`, the workdir base: the target
 * must lie inside it (assertValidTargetProjectPath).
 */
export async function createWorkdir(
  base: string,
  targetProjectPath: string,
  taskBranch: string,
): Promise<WorkdirInfo> {
  // A fresh target's first commit is staged in its main checkout: two first dispatches, or one
  // racing a finalize, must not share that index.
  await withTargetCheckout(targetProjectPath, `the git init before ${taskBranch}'s worktree`, () => ensureTargetGitInit(targetProjectPath, base));
  await mkdir(base, { recursive: true });
  const workDir = workdirOf(base, taskBranch);
  await clearWorktreeSlot(base, targetProjectPath, taskBranch);

  try {
    await runHostGit(targetRepo(targetProjectPath), ["worktree", "add", workDir, "-b", taskBranch, "main"]);
  } catch (e) {
    throw new WorkspaceError("createWorktree", { targetPath: targetProjectPath, workDir }, e);
  }

  return { workDir, taskBranch, repo: await worktreeWithIdentity(targetProjectPath, workDir) };
}

async function worktreeWithIdentity(targetProjectPath: string, workDir: string): Promise<HostRepo> {
  try {
    const repo = await freshWorktreeRepo(targetProjectPath, workDir);
    await runHostGit(repo, ["config", "user.email", "ashara-agent@local"]);
    await runHostGit(repo, ["config", "user.name", "Ashara Agent"]);
    return repo;
  } catch (e) {
    await removeWorktree(targetProjectPath, workDir);
    throw new WorkspaceError("resolveWorktreeRepo", { targetPath: targetProjectPath, workDir }, e);
  }
}

/**
 * The worktree of a branch that already exists, checked out as it is, then made ready by `prepare`
 * before anything else touches it (the caller's merge of main into it). A `prepare` that throws
 * removes the worktree, and its error is rethrown as it is.
 */
export async function createWorkdirForRetry(
  base: string,
  targetProjectPath: string,
  taskBranch: string,
  prepare: (repo: HostRepo) => Promise<unknown>,
): Promise<WorkdirInfo> {
  await mkdir(base, { recursive: true });
  const workDir = workdirOf(base, taskBranch);
  await clearWorktreeSlot(base, targetProjectPath, taskBranch);

  try {
    await runHostGit(targetRepo(targetProjectPath), ["worktree", "add", workDir, taskBranch]);
  } catch (e) {
    throw new WorkspaceError("createWorktreeRetry", { targetPath: targetProjectPath, workDir, taskBranch }, e);
  }

  const repo = await worktreeWithIdentity(targetProjectPath, workDir);
  try {
    await prepare(repo);
  } catch (e) {
    await removeWorktree(targetProjectPath, workDir);
    throw e;
  }
  return { workDir, taskBranch, repo };
}

/**
 * Removes the worktree at `workDir` and its registration. A directory already gone (an earlier
 * cleanup, the startup sweep) leaves at most a registration, which `worktree prune` drops: nothing
 * failed, so nothing is logged. A `worktree remove` that fails is a real failure: the directory is
 * removed and the registration pruned instead, and the failure is logged at warn with its cause and
 * what the fallback left. Never throws: it runs on the way out of paths that carry their own error.
 */
async function removeWorktree(targetProjectPath: string, workDir: string): Promise<void> {
  const repo = targetRepo(targetProjectPath);
  if (await directoryGone(workDir)) {
    try {
      await runHostGit(repo, ["worktree", "prune"]);
    } catch (e) {
      // eslint-disable-next-line ashara/catch-continue -- best effort: worktree removal is cleanup on the way out of a path that carries its own result; the startup sweep removes what it leaves
      console.warn(`[worktree] ${workDir} is gone, but its registration could not be pruned: ${describeErrorChain(e)}`);
    }
    return;
  }
  try {
    await runHostGit(repo, ["worktree", "remove", workDir, "--force"]);
    return;
  } catch (removeError) {
    // eslint-disable-next-line ashara/catch-continue -- best effort: worktree removal is cleanup on the way out of a path that carries its own result; the fallback below removes the directory instead and logs what it leaves
    const left: string[] = [];
    try {
      await rm(workDir, { recursive: true, force: true });
    } catch (e) {
      // eslint-disable-next-line ashara/catch-continue -- best effort: the failure is kept in left and logged below; worktree removal is cleanup the startup sweep finishes
      left.push(`the directory could not be removed either: ${describeErrorChain(e)}`);
    }
    try {
      await runHostGit(repo, ["worktree", "prune"]);
    } catch (e) {
      // eslint-disable-next-line ashara/catch-continue -- best effort: the failure is kept in left and logged below; worktree removal is cleanup the startup sweep finishes
      left.push(`its registration could not be pruned: ${describeErrorChain(e)}`);
    }
    console.warn(
      `[worktree] git worktree remove ${workDir} failed: ${describeErrorChain(removeError)}; ` +
        (left.length === 0 ? "the directory was removed and its registration pruned instead" : left.join("; ")),
    );
  }
}

/** Only ENOENT says the directory is gone; any other answer is not "gone", so its removal is still tried. */
async function directoryGone(path: string): Promise<boolean> {
  try {
    await access(path);
    return false;
  } catch (err) {
    return errnoOf(err) === "ENOENT";
  }
}

/**
 * Files the agent changed. Ashara writes nothing into the worktree (records go to
 * workdirBase/records/), so every change is the agent's.
 */
export async function getChangedFiles(repo: HostRepo): Promise<string[]> {
  const { stdout } = await runHostGit(repo, ["status", "--porcelain"]);
  return stdout
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => line.slice(3).trim());
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

/**
 * Whether HEAD names a commit. `rev-parse -q --verify` exits 1 with no output when it does not (a
 * fresh repository); any other failure is no answer and throws, never read as "no commits", which
 * would stage and commit whatever the checkout holds onto a main that has history.
 */
async function hasGitCommits(dir: string): Promise<boolean> {
  try {
    await runHostGit(targetRepo(dir), ["rev-parse", "-q", "--verify", "HEAD^{commit}"]);
    return true;
  } catch (e) {
    if (exitCodeOf(e) === 1 && stderrOf(e).trim() === "") return false;
    throw e;
  }
}

/** The `.git` probe could not tell whether the entry exists (EACCES, EIO, ...): never read as absent. */
class GitEntryProbeFailed extends Error {
  constructor(
    public readonly dir: string,
    public readonly code: string | undefined,
    cause: unknown,
  ) {
    super(`could not tell whether "${join(dir, ".git")}" exists (${code ?? "unknown error"}): ${describeErrorChain(cause)}`, { cause });
    this.name = "GitEntryProbeFailed";
  }
}

function errnoOf(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err && typeof err.code === "string" ? err.code : undefined;
}

/** Only ENOENT and ENOTDIR mean "no .git"; any other failure is unknown and throws. */
async function hasGitEntry(dir: string): Promise<boolean> {
  try {
    await access(join(dir, ".git"));
    return true;
  } catch (err: unknown) {
    const code = errnoOf(err);
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw new GitEntryProbeFailed(dir, code, err);
  }
}

/**
 * Idempotent `git init` + identity config for `targetProjectPath` if it
 * doesn't already have a `.git`. Initializes on branch `main` explicitly —
 * the task-branch merge queue always branches from and merges
 * into `main` by name, which plain `git init` would otherwise name `master`.
 */
async function ensureGitInitialized(targetProjectPath: string): Promise<void> {
  if (!(await hasGitEntry(targetProjectPath))) {
    await initHostRepo(targetProjectPath);
    const repo = targetRepo(targetProjectPath);
    await runHostGit(repo, ["config", "user.email", "ashara-agent@local"]);
    await runHostGit(repo, ["config", "user.name", "Ashara Agent"]);
  }
}

/**
 * Z0's git refused to record the agent's work on the task branch: the host's git, not the work,
 * failed, so the task is blocked for the operator rather than merged without that work.
 */
export class WorktreeCommitFailed extends Error {
  constructor(
    public readonly workTree: string,
    public readonly step: "add" | "commit",
    public readonly detail: string,
  ) {
    super(`git ${step} of the task worktree ${workTree} failed: ${detail}`);
    this.name = "WorktreeCommitFailed";
  }
}

/**
 * The commit succeeded but the worktree still holds changes it did not record, so the task branch
 * holds only part of the agent's work and must not be merged as if it held all of it.
 */
export class WorktreeCommitIncomplete extends Error {
  constructor(
    public readonly workTree: string,
    public readonly residue: readonly string[],
  ) {
    super(`the task worktree ${workTree} still has uncommitted changes after the commit: ${residue.join(", ")}`);
    this.name = "WorktreeCommitIncomplete";
  }
}

function gitFailureDetail(e: unknown): string {
  if (e instanceof Error) {
    const stderr = "stderr" in e && typeof e.stderr === "string" ? e.stderr.trim() : "";
    return stderr.length > 0 ? `${e.message.split("\n")[0]}; stderr: ${stderr}` : e.message;
  }
  return describeErrorChain(e);
}

/**
 * Commits every change in the worktree to the task branch. Throws WorktreeCommitFailed when git
 * rejects the add or the commit, and WorktreeCommitIncomplete when changes remain after it.
 */
export async function commitAllChanges(repo: HostRepo, message: string): Promise<void> {
  for (const [step, args] of [
    ["add", ["add", "-A"]],
    ["commit", ["commit", "-m", message, "--allow-empty-message"]],
  ] as const) {
    try {
      await runHostGit(repo, args);
    } catch (e) {
      throw new WorktreeCommitFailed(repo.workTree, step, gitFailureDetail(e));
    }
  }
  const residue = await getChangedFiles(repo);
  if (residue.length > 0) throw new WorktreeCommitIncomplete(repo.workTree, residue);
}

// ---------------------------------------------------------------------------
// Partial-work commit (ADR-036 point 6)
// ---------------------------------------------------------------------------

export type PartialCommitOutcome =
  | { readonly committed: true; readonly filesCount: number }
  | { readonly committed: false; readonly reason: "no-changes" }
  /** Main was merged into the worktree for this attempt and its conflicts may still hold markers. */
  | { readonly committed: false; readonly reason: "merge-in-progress" }
  | { readonly committed: false; readonly reason: "git-error"; readonly message: string };

/**
 * Best-effort commit of whatever the agent left in the worktree before cleanup
 * on a failure path. ADR-036 point 6: a retry's worktree seeds from the task
 * branch, so uncommitted work destroyed with the worktree is work lost.
 *
 * Never throws. The caller is already on a failure path, and a commit problem
 * must not replace or mask the original failure (design point 5).
 *
 * "Nothing to commit" is the normal case — an agent that produced nothing —
 * and is silent (design point 1). A real git failure is logged at warn so it
 * stays visible even though no gate reads it (design point 2). The commit
 * message identifies the work as partial (design point 3) — the caller
 * provides a message containing task ID, dispatch number, and failure path.
 *
 * A worktree with main's merge staged is not committed: the commit would conclude the merge with
 * whatever markers are left on the branch, and the next attempt would no longer see the conflict.
 * The merge is discarded with the worktree; the next attempt prepares it again from git.
 */
export async function commitPartialWork(
  repo: HostRepo,
  message: string,
): Promise<PartialCommitOutcome> {
  try {
    if (await mergeInProgress(repo)) {
      console.warn(`[commitPartialWork] ${repo.workTree} holds an unfinished merge of main; nothing is committed, and an attempt that resumes the branch prepares the merge again from git`);
      return { committed: false, reason: "merge-in-progress" };
    }
    const files = await getChangedFiles(repo);
    if (files.length === 0) {
      return { committed: false, reason: "no-changes" };
    }
    await runHostGit(repo, ["add", "-A"]);
    await runHostGit(repo, ["commit", "-m", message]);
    return { committed: true, filesCount: files.length };
  } catch (e: unknown) {
    const msg = describeErrorChain(e);
    console.warn(`[commitPartialWork] git failure in ${repo.workTree}: ${msg}`);
    return { committed: false, reason: "git-error", message: msg };
  }
}

/**
 * Removes the worktree and keeps its branch: a branch is deleted only by whoever settles its task
 * (merge.ts deleteSettledTaskBranch), discards its attempt (discardTaskBranch, dropCheckBranch), or
 * finds its task settled (settled-branches.ts releaseSettledBranches).
 * Never throws: a failure is logged at warn with its cause (removeWorktree), so a caller on its way
 * out of a path carrying its own error needs no catch of its own.
 */
export async function cleanupWorkdir(workDir: string, targetProjectPath: string): Promise<void> {
  await removeWorktree(targetProjectPath, workDir);
}

/**
 * Where every throwaway checkout of a check goes: a detached worktree of the target, made for one
 * run of a check and removed on its way out (withCheckoutCell, the verification's own checkouts).
 */
export function checkoutsRoot(workdirBase: string): string {
  return join(workdirBase, "checkouts");
}

/** Whether `path` lies strictly inside `root`. */
function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** The worktrees of the target at `targetProjectPath` registered strictly inside `root` (raw or canonical). */
async function worktreesUnder(root: string, targetProjectPath: string): Promise<string[]> {
  const roots = [root, await canonicalizeAllowingMissing(root)];
  const { stdout } = await runHostGit(targetRepo(targetProjectPath), ["worktree", "list", "--porcelain"]);
  return stdout
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length))
    .filter((path) => roots.some((each) => isInside(each, path)));
}

/** What one target's removal of throwaway checkouts did. */
interface CheckoutRemoval {
  readonly removed: number;
  /** Checkouts still registered after the removal: each is retried by the next one. */
  readonly left: number;
}

/**
 * Removes every throwaway checkout (checkoutsRoot) the target at `targetProjectPath` still has
 * registered. Run only while no attempt is in flight (at startup and between cycles): a check
 * removes its checkout on its way out, so each one registered then is one a crash or a faulted
 * cleanup left, whichever task it ran for and whatever later settled that task. A removal that
 * fails is logged at warn (removeWorktree) and counted as left; a target whose worktrees cannot be
 * listed throws.
 */
export async function removeThrowawayCheckouts(workdirBase: string, targetProjectPath: string): Promise<CheckoutRemoval> {
  const root = checkoutsRoot(workdirBase);
  const found = await worktreesUnder(root, targetProjectPath);
  if (found.length === 0) return { removed: 0, left: 0 };
  for (const path of found) await removeWorktree(targetProjectPath, path);
  const left = (await worktreesUnder(root, targetProjectPath)).length;
  return { removed: found.length - left, left };
}

interface TreeChild {
  readonly name: string;
  readonly isDirectory: boolean;
}

type ListChildren = (relDir: string) => Promise<readonly TreeChild[]>;

/** Children of every directory named by git's path list, which names files only. */
async function gitListing(rootDir: string): Promise<ListChildren> {
  const { stdout } = await runHostGit(targetRepo(rootDir), ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  const dirs = new Map<string, Map<string, boolean>>();
  for (const path of new Set(stdout.split("\0").filter((p) => p.length > 0))) {
    const segments = path.split("/");
    for (let i = 0; i < segments.length; i++) {
      const parent = segments.slice(0, i).join("/");
      const children = dirs.get(parent) ?? new Map<string, boolean>();
      dirs.set(parent, children);
      children.set(segments[i], i < segments.length - 1 || children.get(segments[i]) === true);
    }
  }
  return async (relDir) => [...(dirs.get(relDir) ?? new Map<string, boolean>())].map(([name, isDirectory]) => ({ name, isDirectory }));
}

/**
 * The tree as an agent should see it, with no knowledge of any stack's directory names. In a git
 * repository the names come from git itself (`ls-files --cached --others --exclude-standard`): the
 * project's own ignore rules, in full gitignore syntax, decide what is left out, and Z0 opens
 * nothing in the cell-writable tree. A target that is not yet a repository has declared nothing to
 * ignore, so every entry is listed, read through tree-read.ts without following any link; the
 * maxFiles cap bounds the output either way.
 */
export async function buildFileTree(
  rootDir: string,
  maxDepth: number,
  maxFiles: number,
): Promise<string> {
  const list: ListChildren = (await treeHasDirectory(rootDir, ".git"))
    ? await gitListing(rootDir)
    : async (relDir) =>
        // eslint-disable-next-line no-restricted-syntax -- policy default: a directory that does not exist lists no entry in the agent's file-tree context; no verdict reads it
        ((await listTreeDir(rootDir, relDir)) ?? []).map((e) => ({ name: e.name, isDirectory: e.kind === "directory" }));
  const paths: string[] = [];

  async function walk(relDir: string, depth: number): Promise<void> {
    if (depth > maxDepth || paths.length >= maxFiles) return;
    const children = [...(await list(relDir))].sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      if (paths.length >= maxFiles) return;
      const rel = relDir === "" ? child.name : `${relDir}/${child.name}`;
      if (child.isDirectory) {
        paths.push(rel + "/");
        await walk(rel, depth + 1);
      } else {
        paths.push(rel);
      }
    }
  }

  await walk("", 0);
  return paths.join("\n");
}

/**
 * Creates the target if it is missing and makes it a repository with a first commit on main. The
 * path is checked against `workdirBase` first (assertValidTargetProjectPath): nothing is created or
 * initialised outside Ashara's own file area.
 */
export async function ensureTargetGitInit(targetProjectPath: string, workdirBase: string): Promise<void> {
  await assertValidTargetProjectPath(targetProjectPath, workdirBase);
  await mkdir(targetProjectPath, { recursive: true });
  await ensureGitInitialized(targetProjectPath);

  if (!(await hasGitCommits(targetProjectPath))) {
    const repo = targetRepo(targetProjectPath);
    await runHostGit(repo, ["add", "-A"]);
    // --allow-empty: the root commit exists so `main` and every task branch have
    // somewhere to point. It carries no scaffold of Ashara's own, so on a fresh
    // target there is nothing to commit and the plain form would fail.
    await runHostGit(repo, ["commit", "--allow-empty", "-m", "init"]);
  }
}

/** A refused target workspace: the orchestrator blocks the project's item on it before dispatch. */
export class InvalidTargetProjectPath extends Error {
  constructor(
    public readonly path: string,
    public readonly reason: string,
  ) {
    super(`Refusing to use target project path "${path}": ${reason}`);
    this.name = "InvalidTargetProjectPath";
  }
}

/**
 * Discipline B: a target workspace is used only strictly inside the workdir base, Ashara's own
 * file area. Both paths are canonicalized first (the realpath of the nearest existing ancestor),
 * so a symbolic link on the way is followed before the prefix check: a link that leads out of the
 * base is refused like any other path outside it. A path that cannot be canonicalized is refused
 * too (fail-closed). The database is a trust boundary, so a stored path is checked like a minted one.
 */
export async function assertValidTargetProjectPath(targetProjectPath: string, workdirBase: string): Promise<void> {
  let canonical: string;
  let base: string;
  try {
    canonical = await canonicalizeAllowingMissing(targetProjectPath);
    base = await canonicalizeAllowingMissing(workdirBase);
  } catch (err) {
    throw new InvalidTargetProjectPath(targetProjectPath, `the path or the workdir base could not be canonicalized (fail-closed): ${describeErrorChain(err)}`);
  }
  if (!isInside(base, canonical)) {
    throw new InvalidTargetProjectPath(canonical, `the path is not inside the workdir base ${base}; every target workspace lives under it`);
  }
}

/**
 * Worktree directories are named after their branch (workdirOf): a task's `task/<id>` branch is
 * `task-<id>` under the workdir base. Only directories with this prefix are the sweep's to delete;
 * every other entry (projects/, records/, checkouts/) is left alone by construction.
 */
const TASK_WORKTREE_PREFIX = "task-";

/** What the startup sweep of task worktrees did: how many it removed, or why it could not run. */
type WorktreeSweep =
  | { readonly kind: "swept"; readonly removed: number }
  /** The workdir base does not exist yet: no worktree was ever created, so there is nothing to clean. */
  | { readonly kind: "no-workdir-base" }
  | { readonly kind: "failed"; readonly step: string; readonly error: unknown };

/**
 * Startup (Discipline B): removes the task worktrees a previous process left whose task is no
 * longer active. `activeTaskIds` names the tasks whose worktree is kept; it is read only when a
 * task worktree is present. One directory that cannot be removed is logged and the rest are
 * still swept.
 */
export async function sweepOrphanedWorktrees(workdirBase: string, activeTaskIds: () => Promise<readonly string[]>): Promise<WorktreeSweep> {
  let names: string[];
  try {
    names = (await readdir(workdirBase, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    if (errnoOf(err) === "ENOENT") {
      console.log(`[worktree-sweep] workdir base ${workdirBase} does not exist yet; no task worktree to clean`);
      return { kind: "no-workdir-base" };
    }
    console.warn(`[worktree-sweep] the workdir base ${workdirBase} could not be listed; no worktree was cleaned:`, err);
    return { kind: "failed", step: "list the workdir base", error: err };
  }
  const taskDirs = names.filter((d) => d.startsWith(TASK_WORKTREE_PREFIX)).map((d) => ({ dirName: d, taskId: d.slice(TASK_WORKTREE_PREFIX.length) }));
  if (taskDirs.length === 0) return { kind: "swept", removed: 0 };

  let active: Set<string>;
  try {
    active = new Set(await activeTaskIds());
  } catch (err) {
    console.warn("[worktree-sweep] the active tasks could not be read; no worktree was cleaned:", err);
    return { kind: "failed", step: "read the active tasks", error: err };
  }
  let removed = 0;
  for (const { dirName, taskId } of taskDirs) {
    if (active.has(taskId)) continue;
    try {
      await rm(join(workdirBase, dirName), { recursive: true, force: true });
      removed += 1;
    } catch (err) {
      // eslint-disable-next-line ashara/catch-continue -- best effort: removing an orphaned worktree is cleanup; the next startup sweep retries it
      console.warn(`[worktree-sweep] failed to remove orphaned worktree ${dirName}:`, err);
    }
  }
  console.log(`[worktree-sweep] removed ${removed} orphaned task worktree(s)`);
  return { kind: "swept", removed };
}
