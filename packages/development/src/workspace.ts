import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { execFile } from "node:child_process";
import { access, mkdir, realpath, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { freshWorktreeRepo, initHostRepo, runHostGit, targetRepo, type HostRepo } from "./host-git.js";
import { listTreeDir, treeHasDirectory } from "./tree-read.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Pure utility functions (no BC dependencies)
// ---------------------------------------------------------------------------

export interface WorkdirInfo {
  readonly workDir: string;
  readonly taskBranch: string;
  /** Resolved before any cell mounts workDir; every later git call on the worktree goes through it. */
  readonly repo: HostRepo;
}

class WorkspaceError extends Error {
  constructor(
    public readonly operation: string,
    public readonly context: { readonly targetPath?: string; readonly workDir?: string; readonly taskId?: string },
    cause?: unknown,
  ) {
    const causeMsg = cause instanceof Error ? cause.message : String(cause ?? "");
    super(`workspace ${operation} failed: ${causeMsg}`);
    this.name = "WorkspaceError";
  }
}

export async function createWorkdir(
  base: string,
  targetProjectPath: string,
  taskBranch: string,
): Promise<WorkdirInfo> {
  await ensureTargetGitInit(targetProjectPath);
  await mkdir(base, { recursive: true });
  const workDir = join(base, taskBranch.replace(/\//g, "-"));

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

export async function createWorkdirForRetry(
  base: string,
  targetProjectPath: string,
  taskBranch: string,
): Promise<WorkdirInfo> {
  await mkdir(base, { recursive: true });
  const workDir = join(base, taskBranch.replace(/\//g, "-"));

  try {
    await runHostGit(targetRepo(targetProjectPath), ["worktree", "add", workDir, taskBranch]);
  } catch (e) {
    throw new WorkspaceError("createWorktreeRetry", { targetPath: targetProjectPath, workDir }, e);
  }

  return { workDir, taskBranch, repo: await worktreeWithIdentity(targetProjectPath, workDir) };
}

async function removeWorktree(targetProjectPath: string, workDir: string, deleteBranch?: string): Promise<void> {
  const repo = targetRepo(targetProjectPath);
  try {
    await runHostGit(repo, ["worktree", "remove", workDir, "--force"]);
  } catch {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
    await runHostGit(repo, ["worktree", "prune"]).catch(() => {});
  }
  if (deleteBranch) {
    await runHostGit(repo, ["branch", "-d", deleteBranch]).catch(() => {});
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

async function hasGitCommits(dir: string): Promise<boolean> {
  try {
    await runHostGit(targetRepo(dir), ["rev-parse", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Idempotent `git init` + identity config for `targetProjectPath` if it
 * doesn't already have a `.git`. Initializes on branch `main` explicitly —
 * the task-branch merge queue (merge.ts) always branches from and merges
 * into `main` by name, which plain `git init` would otherwise name `master`.
 */
async function ensureGitInitialized(targetProjectPath: string): Promise<void> {
  const isGitRepo = await access(join(targetProjectPath, ".git")).then(
    () => true,
    () => false,
  );
  if (!isGitRepo) {
    await initHostRepo(targetProjectPath);
    const repo = targetRepo(targetProjectPath);
    await runHostGit(repo, ["config", "user.email", "ashara-agent@local"]);
    await runHostGit(repo, ["config", "user.name", "Ashara Agent"]);
  }
}

export async function commitAllChanges(repo: HostRepo, message: string): Promise<void> {
  await runHostGit(repo, ["add", "-A"]);
  await runHostGit(repo, ["commit", "-m", message, "--allow-empty-message"]);
}

// ---------------------------------------------------------------------------
// Partial-work commit (ADR-036 point 6)
// ---------------------------------------------------------------------------

export type PartialCommitOutcome =
  | { readonly committed: true; readonly filesCount: number }
  | { readonly committed: false; readonly reason: "no-changes" }
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
 */
export async function commitPartialWork(
  repo: HostRepo,
  message: string,
): Promise<PartialCommitOutcome> {
  try {
    const files = await getChangedFiles(repo);
    if (files.length === 0) {
      return { committed: false, reason: "no-changes" };
    }
    await runHostGit(repo, ["add", "-A"]);
    await runHostGit(repo, ["commit", "-m", message]);
    return { committed: true, filesCount: files.length };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[commitPartialWork] git failure in ${repo.workTree}: ${msg}`);
    return { committed: false, reason: "git-error", message: msg };
  }
}

export async function cleanupWorkdir(workDir: string, targetProjectPath?: string, taskBranch?: string): Promise<void> {
  if (targetProjectPath) {
    await removeWorktree(targetProjectPath, workDir, taskBranch);
  } else {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
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

export async function ensureTargetGitInit(targetProjectPath: string): Promise<void> {
  // GIT-SAFETY (path minting): refuse before creating/initialising anything
  // inside the repo or under a git working tree (defense in depth).
  await assertValidTargetProjectPath(targetProjectPath);
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

async function resolveAsharaRepoRoot(): Promise<string> {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd: moduleDir,
    });
    return await realpath(stdout.trim());
  } catch (err) {
    // Fail closed: if the repo root can't be determined, refuse rather than
    // proceed as if the target were safe.
    throw new Error(
      `could not determine the Ashara repository root (git rev-parse failed) from "${moduleDir}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// `relative(from, to)` yields "" when the two paths are equal, and a value
// that neither starts with ".." nor is absolute exactly when `to` is `from`
// or a descendant of `from`. So `isInsideOrEqual(relative(a, b))` is true iff
// `b` is inside or equal to `a`.
function isInsideOrEqual(rel: string): boolean {
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Describes how `canonical` violates the Ashara-root boundary relative to
 * `asharaRoot` — "equals", "contains" (canonical is an ancestor of the repo
 * root), or "is inside" (canonical is a descendant) — or `null` if there is
 * no violation. Used by the path-minting guard below (ADR-032 §6).
 */
function describeAsharaRootViolation(canonical: string, asharaRoot: string): string | null {
  const relRootToTarget = relative(asharaRoot, canonical);
  const relTargetToRoot = relative(canonical, asharaRoot);
  const targetInsideOrEqualsRoot = isInsideOrEqual(relRootToTarget);
  const targetContainsRoot = isInsideOrEqual(relTargetToRoot);

  if (!targetInsideOrEqualsRoot && !targetContainsRoot) return null;
  return relRootToTarget === "" ? "equals" : targetContainsRoot ? "contains" : "is inside";
}

// ---------------------------------------------------------------------------
// GIT-SAFETY (path minting): a generated target project must never live inside
// the Ashara repo, and its PARENT directory must not sit inside any git
// working tree. Generated projects belong in standalone locations (e.g.
// /tmp/ashara-work/projects/<uuid>) whose parent is not a git repo. This is
// enforced at the path-MINTING boundary (where a target path is chosen or
// loaded from the DB). The target growing its OWN .git after
// ensureTargetGitInit is fine — the parent-chain check is about creation
// time, before any init.
// ---------------------------------------------------------------------------

/** @testseam workspace-target-path.test.ts asserts the typed rejection */
export class InvalidTargetProjectPath extends Error {
  constructor(
    public readonly path: string,
    public readonly reason: string,
  ) {
    super(`Refusing to use target project path "${path}": ${reason}`);
    this.name = "InvalidTargetProjectPath";
  }
}

// realpath() fails on paths that do not exist yet. A minted target is usually
// not created at validation time, so resolve the nearest existing ancestor and
// re-append the missing tail. Fail closed if NO ancestor resolves.
async function canonicalizeAllowingMissing(inputPath: string): Promise<string> {
  let current = resolve(inputPath);
  const missing: string[] = [];
  for (;;) {
    try {
      const real = await realpath(current);
      return missing.length === 0 ? real : join(real, ...missing.reverse());
    } catch (err) {
      const parent = dirname(current);
      if (parent === current) {
        throw new Error(
          `no existing ancestor could be resolved for "${inputPath}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      missing.push(basename(current));
      current = parent;
    }
  }
}

// Walk startDir and its ancestors looking for a `.git` entry (dir or file).
// Returns the directory that holds the `.git`, or null if none up to the
// filesystem root.
async function findGitWorkingTreeAncestor(startDir: string): Promise<string | null> {
  let current = startDir;
  for (;;) {
    const hasGit = await access(join(current, ".git")).then(
      () => true,
      () => false,
    );
    if (hasGit) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export async function assertValidTargetProjectPath(targetProjectPath: string): Promise<void> {
  let canonical: string;
  try {
    canonical = await canonicalizeAllowingMissing(targetProjectPath);
  } catch (err) {
    throw new InvalidTargetProjectPath(
      targetProjectPath,
      `path could not be canonicalized (fail-closed): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let asharaRoot: string;
  try {
    asharaRoot = await resolveAsharaRepoRoot();
  } catch (err) {
    throw new InvalidTargetProjectPath(
      canonical,
      `could not resolve the Ashara repository root (fail-closed): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 1. Must not equal, contain, or be inside the Ashara repo root.
  const relation = describeAsharaRootViolation(canonical, asharaRoot);
  if (relation !== null) {
    throw new InvalidTargetProjectPath(
      canonical,
      `path ${relation} the Ashara repository root (${asharaRoot}); generated projects must live in a standalone location`,
    );
  }

  // 2. The PARENT chain must not sit inside any git working tree.
  let gitAncestor: string | null;
  try {
    gitAncestor = await findGitWorkingTreeAncestor(dirname(canonical));
  } catch (err) {
    throw new InvalidTargetProjectPath(
      canonical,
      `parent git-worktree inspection failed (fail-closed): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (gitAncestor !== null) {
    throw new InvalidTargetProjectPath(
      canonical,
      `parent directory is inside a git working tree (found .git at "${gitAncestor}"); generated projects must be created outside any git repo`,
    );
  }
}

