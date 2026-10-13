import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ASHARA_CONTROL_DIR, CONVERSATION_RECORDS_DIR, isAsharaControlPath, loadSkipDirs } from "@ashara/shared";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Pure utility functions (no BC dependencies)
// ---------------------------------------------------------------------------

export interface WorkdirInfo {
  readonly workDir: string;
  readonly taskBranch: string;
}

export class WorkspaceError extends Error {
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
    await execFileAsync("git", ["worktree", "add", workDir, "-b", taskBranch, "main"], {
      cwd: targetProjectPath,
    });
  } catch (e) {
    throw new WorkspaceError("createWorktree", { targetPath: targetProjectPath, workDir }, e);
  }

  await execFileAsync("git", ["config", "user.email", "ashara-agent@local"], { cwd: workDir });
  await execFileAsync("git", ["config", "user.name", "Ashara Agent"], { cwd: workDir });

  return { workDir, taskBranch };
}

export async function createWorkdirForRetry(
  base: string,
  targetProjectPath: string,
  taskBranch: string,
): Promise<WorkdirInfo> {
  await mkdir(base, { recursive: true });
  const workDir = join(base, taskBranch.replace(/\//g, "-"));

  try {
    await execFileAsync("git", ["worktree", "add", workDir, taskBranch], {
      cwd: targetProjectPath,
    });
  } catch (e) {
    throw new WorkspaceError("createWorktreeRetry", { targetPath: targetProjectPath, workDir }, e);
  }

  await execFileAsync("git", ["config", "user.email", "ashara-agent@local"], { cwd: workDir });
  await execFileAsync("git", ["config", "user.name", "Ashara Agent"], { cwd: workDir });

  return { workDir, taskBranch };
}

export async function removeWorktree(targetProjectPath: string, workDir: string, deleteBranch?: string): Promise<void> {
  try {
    await execFileAsync("git", ["worktree", "remove", workDir, "--force"], {
      cwd: targetProjectPath,
    });
  } catch {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
    await execFileAsync("git", ["worktree", "prune"], { cwd: targetProjectPath }).catch(() => {});
  }
  if (deleteBranch) {
    await execFileAsync("git", ["branch", "-d", deleteBranch], { cwd: targetProjectPath }).catch(() => {});
  }
}

/**
 * Files the agent changed. Ashara's own control directory is excluded: it is
 * written before the agent starts, so counting it would let an agent that
 * produced nothing pass the no-changes gate, and it would be reported as a
 * task deliverable.
 */
export async function getChangedFiles(workDir: string): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["status", "--porcelain"], { cwd: workDir });
  return stdout
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => line.slice(3).trim())
    .filter((path) => !isAsharaControlPath(path));
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
  workDir: string,
  message: string,
): Promise<PartialCommitOutcome> {
  try {
    const files = await getChangedFiles(workDir);
    if (files.length === 0) {
      return { committed: false, reason: "no-changes" };
    }
    await execFileAsync("git", ["add", "-A"], { cwd: workDir });
    await execFileAsync("git", ["commit", "-m", message], { cwd: workDir });
    return { committed: true, filesCount: files.length };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[commitPartialWork] git failure in ${workDir}: ${msg}`);
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

// Bridge set: used only when the caller has no contractExcludePaths AND the
// project has no .gitignore. loadSkipDirs is the primary mechanism; this is
// the last-resort fallback so a project with neither gitignore nor contract
// still gets a usable tree listing.
const FALLBACK_SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "coverage", ".next", ".turbo", ".cache",
  "target", "__pycache__", "vendor", "venv", ".venv",
]);

export async function buildFileTree(
  rootDir: string,
  maxDepth: number,
  maxFiles: number,
  contractExcludePaths?: readonly string[],
): Promise<string> {
  const skipDirs = contractExcludePaths && contractExcludePaths.length > 0
    ? new Set([".git", ...contractExcludePaths])
    : await loadSkipDirs(rootDir).catch(() => FALLBACK_SKIP_DIRS);
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

/**
 * Excludes Ashara's control directory from the target repository without
 * touching the project's `.gitignore`.
 *
 * `.git/info/exclude` is git's per-checkout ignore file: untracked, never
 * merged, never a conflict, and read from the common git dir so every linked
 * worktree inherits it. That is the correct home for an ignore that belongs to
 * this checkout rather than to the project.
 *
 * `.gitignore` is the project's own file, and Ashara cannot author it here: the
 * initial commit happens before any agent runs, so what this project needs
 * ignored is not yet knowable. Writing a guess does not merely add noise — it
 * SUPPRESSES the right answer, because the agent that later learns the stack
 * finds a `.gitignore` already present and leaves it alone. Run 39's Go target
 * inherited `node_modules/`, never got its compiled binary ignored, and
 * deadlocked the merge queue. The project's ignores arrive when the project's
 * stack does: from the agent, in the same commit as the manifest.
 */
async function excludeControlDir(targetProjectPath: string): Promise<void> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "--git-common-dir"], {
    cwd: targetProjectPath,
  });
  const commonDir = stdout.trim();
  const excludePath = join(
    isAbsolute(commonDir) ? commonDir : join(targetProjectPath, commonDir),
    "info",
    "exclude",
  );

  const entry = `${ASHARA_CONTROL_DIR}/`;
  const existing = await readFile(excludePath, "utf-8").catch(() => "");
  if (existing.split("\n").some((line) => line.trim() === entry)) return;

  await mkdir(dirname(excludePath), { recursive: true });
  const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
  await writeFile(excludePath, `${existing}${separator}${entry}\n`, "utf-8");
}

export async function ensureTargetGitInit(targetProjectPath: string): Promise<void> {
  // GIT-SAFETY (path minting): refuse before creating/initialising anything
  // inside the repo or under a git working tree (defense in depth).
  await assertValidTargetProjectPath(targetProjectPath);
  await mkdir(targetProjectPath, { recursive: true });
  await ensureGitInitialized(targetProjectPath);
  await excludeControlDir(targetProjectPath);

  if (!(await hasGitCommits(targetProjectPath))) {
    await execFileAsync("git", ["add", "-A"], { cwd: targetProjectPath });
    // --allow-empty: the root commit exists so `main` and every task branch have
    // somewhere to point. It carries no scaffold of Ashara's own, so on a fresh
    // target there is nothing to commit and the plain form would fail.
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

/**
 * Whether the agent subprocess ran, determining ENOENT semantics.
 * - `"agent-ran"` — the agent was launched; a missing record means it crashed
 *   before writing its first turn. ENOENT is a diagnostic fact and is warned.
 * - `"pre-launch"` — the agent was never launched (stub execution, outer catch
 *   before dispatch). No conversation.jsonl was ever created. ENOENT is
 *   expected and silent.
 */
export type ConversationRecordExpectation = "agent-ran" | "pre-launch";

/**
 * Copies the agent's conversation record out of the worktree to a durable
 * location before cleanup destroys it. The record is the ONLY per-turn trace
 * of what the agent did — without this, diagnosing a run requires capturing
 * the filesystem while the process is still live.
 *
 * Organized as `<workdirBase>/records/<taskId>/conversation.jsonl`, locatable
 * by task id after the worktree is gone.
 *
 * Never throws. The task outcome is already determined by the time this runs,
 * and destroying a good outcome to save a diagnostic artifact would be
 * backwards. Discipline A: persisting the record is a policy decision (the
 * system chooses what to archive), and its output flows into zero verdicts —
 * a persist failure leaves the run no worse than the status quo where the
 * record was always lost.
 */
export async function persistConversationRecord(
  workDir: string,
  taskId: string,
  workdirBase: string,
  expectation: ConversationRecordExpectation,
): Promise<void> {
  const source = join(workDir, ASHARA_CONTROL_DIR, "conversation.jsonl");
  const destDir = join(workdirBase, CONVERSATION_RECORDS_DIR, taskId);
  const dest = join(destDir, "conversation.jsonl");

  try {
    const content = await readFile(source);
    await mkdir(destDir, { recursive: true });
    await writeFile(dest, content);
  } catch (e: unknown) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT") {
      if (expectation === "agent-ran") {
        console.warn(
          `[persistConversationRecord] expected conversation record for task ${taskId} ` +
            `but none exists at ${source} — the agent may have crashed before writing its first turn`,
        );
      }
      return;
    }
    console.warn(
      `[persistConversationRecord] failed to persist conversation record for task ${taskId} ` +
        `from ${source} to ${dest}: ${e instanceof Error ? e.message : String(e)}`,
    );
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

