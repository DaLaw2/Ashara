import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Pure utility functions (no BC dependencies)
// ---------------------------------------------------------------------------

export async function createWorkdir(
  base: string,
  targetProjectPath: string | null,
  seedBranch?: string,
): Promise<string> {
  await mkdir(base, { recursive: true });
  const workDir = await mkdtemp(join(base, "task-"));

  await execFileAsync("git", ["init"], { cwd: workDir });
  await execFileAsync("git", ["config", "user.email", "ashara-agent@local"], { cwd: workDir });
  await execFileAsync("git", ["config", "user.name", "Ashara Agent"], { cwd: workDir });
  await execFileAsync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: workDir });

  if (targetProjectPath && (await hasGitCommits(targetProjectPath))) {
    const ref = seedBranch ?? "HEAD";
    await execFileAsync("sh", [
      "-c",
      `git -C "${targetProjectPath}" archive "${ref}" | tar -x -C "${workDir}"`,
    ]);
    const { stdout } = await execFileAsync("git", ["status", "--porcelain"], { cwd: workDir });
    if (stdout.trim().length > 0) {
      await execFileAsync("git", ["add", "-A"], { cwd: workDir });
      await execFileAsync("git", ["commit", "-m", "seed from previous task output"], {
        cwd: workDir,
      });
    }
  }

  return workDir;
}

export async function getChangedFiles(workDir: string): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["status", "--porcelain"], { cwd: workDir });
  return stdout
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => line.slice(3).trim());
}

export async function hasGitCommits(dir: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["-C", dir, "rev-parse", "HEAD"]);
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
    await execFileAsync("git", ["init", "-b", "main"], { cwd: targetProjectPath });
    await execFileAsync("git", ["config", "user.email", "ashara-agent@local"], {
      cwd: targetProjectPath,
    });
    await execFileAsync("git", ["config", "user.name", "Ashara Agent"], {
      cwd: targetProjectPath,
    });
  }
}

export async function commitAllChanges(workDir: string, message: string): Promise<void> {
  await execFileAsync("git", ["add", "-A"], { cwd: workDir });
  await execFileAsync("git", ["commit", "-m", message, "--allow-empty-message"], { cwd: workDir });
}

export async function cleanupWorkdir(workDir: string): Promise<void> {
  await rm(workDir, { recursive: true, force: true }).catch(() => {});
}

// bridge: will be replaced by contract.excludePaths when available
const FILE_TREE_SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "coverage", ".next", ".turbo", ".cache",
  "target", "__pycache__", "vendor", "venv", ".venv",
]);

export async function buildFileTree(
  rootDir: string,
  maxDepth: number,
  maxFiles: number,
  contractExcludePaths?: readonly string[],
): Promise<string> {
  // bridge: when no contract excludePaths, use the hardcoded set
  const skipDirs = contractExcludePaths && contractExcludePaths.length > 0
    ? new Set([".git", ...contractExcludePaths])
    : FILE_TREE_SKIP_DIRS;
  const paths: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth || paths.length >= maxFiles) return;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (paths.length >= maxFiles) return;

      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name) || entry.name.startsWith(".")) continue;
        paths.push(relative(rootDir, fullPath) + "/");
        await walk(fullPath, depth + 1);
      } else {
        paths.push(relative(rootDir, fullPath));
      }
    }
  }

  await walk(rootDir, 0);
  return paths.join("\n");
}

export async function ensureTargetGitInit(targetProjectPath: string): Promise<void> {
  // GIT-SAFETY (path minting): refuse before creating/initialising anything
  // inside the repo or under a git working tree (defense in depth).
  await assertValidTargetProjectPath(targetProjectPath);
  await mkdir(targetProjectPath, { recursive: true });
  await ensureGitInitialized(targetProjectPath);
  if (!(await hasGitCommits(targetProjectPath))) {
    await execFileAsync("git", ["commit", "--allow-empty", "-m", "init"], {
      cwd: targetProjectPath,
    });
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

