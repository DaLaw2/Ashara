import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import {
  cleanupWorkdir,
  commitAllChanges,
  commitPartialWork,
  createWorkdir,
  createWorkdirForRetry,
  ensureTargetGitInit,
  WorktreeCommitFailed,
} from "./workspace.js";
import { environmentErrorOf, unavailableOf } from "./environment-failure.js";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

async function makeDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

afterAll(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

// ---------------------------------------------------------------------------
// ADR-036 point 6: partial work committed before worktree cleanup survives
// into the retry's worktree. The mechanism under test is commitPartialWork +
// createWorkdirForRetry; these tests use real git (no mocks) because the
// claim is about what git does with a branch, not about a function's return.
// ---------------------------------------------------------------------------

describe("commitPartialWork — ADR-036 point 6", () => {
  test("after a failure, the task branch has a commit containing the agent's files and a retry sees them", async () => {
    const base = await makeDir("ashara-partial-");
    const target = join(base, "project");
    await ensureTargetGitInit(target);

    const branch = "task/test-partial";
    const workdirBase = join(base, "work");

    // First dispatch: create worktree, simulate agent producing files, then fail
    const { workDir, repo } = await createWorkdir(workdirBase, target, branch);
    await writeFile(join(workDir, "handler.ts"), 'export function handle() { return "hello"; }', "utf-8");
    await writeFile(join(workDir, "route.ts"), 'import { handle } from "./handler.js";', "utf-8");

    // Partial commit before cleanup (what execution-service now does on failure)
    const outcome = await commitPartialWork(
      repo,
      "ashara: partial work for retry (task test-partial, dispatch 1, agent-blocked)",
    );
    expect(outcome.committed).toBe(true);
    if (outcome.committed) {
      expect(outcome.filesCount).toBe(2);
    }

    // Cleanup destroys the worktree but preserves the branch (no taskBranch arg)
    await cleanupWorkdir(workDir, target);

    // Retry: new worktree from the same branch
    const retry = await createWorkdirForRetry(workdirBase, target, branch);

    // The agent's files survive the worktree destruction
    const handler = await readFile(join(retry.workDir, "handler.ts"), "utf-8");
    expect(handler).toContain("handle");
    const route = await readFile(join(retry.workDir, "route.ts"), "utf-8");
    expect(route).toContain("handle");

    // The commit is identifiable as partial work, not a finalized one
    const log = await git(retry.workDir, "log", "--oneline", "-1");
    expect(log).toContain("partial work for retry");
    expect(log).toContain("agent-blocked");

    await cleanupWorkdir(retry.workDir, target, branch);
  });

  test("nothing to commit returns no-changes, not an error", async () => {
    const base = await makeDir("ashara-partial-empty-");
    const target = join(base, "project");
    await ensureTargetGitInit(target);

    const branch = "task/test-empty";
    const workdirBase = join(base, "work");
    const { workDir, repo } = await createWorkdir(workdirBase, target, branch);

    // Agent produced nothing — normal case
    const outcome = await commitPartialWork(
      repo,
      "ashara: partial work for retry (task test-empty, dispatch 1, agent-failed)",
    );
    expect(outcome).toEqual({ committed: false, reason: "no-changes" });

    await cleanupWorkdir(workDir, target, branch);
  });

  test("a partial commit on a prior dispatch does not break the finalize commit on a successful retry", async () => {
    const base = await makeDir("ashara-partial-then-success-");
    const target = join(base, "project");
    await ensureTargetGitInit(target);

    const branch = "task/test-success-after-partial";
    const workdirBase = join(base, "work");

    // First dispatch: agent writes files, fails, partial commit preserved
    const { workDir: w1, repo: r1 } = await createWorkdir(workdirBase, target, branch);
    await writeFile(join(w1, "v1.ts"), "export const v = 1;", "utf-8");
    await commitPartialWork(r1, "ashara: partial work for retry (task x, dispatch 1, agent-failed)");
    await cleanupWorkdir(w1, target);

    // Second dispatch (retry): agent adds more work, then finalizeSuccess commits
    const { workDir: w2, repo: r2 } = await createWorkdirForRetry(workdirBase, target, branch);
    await writeFile(join(w2, "v2.ts"), "export const v = 2;", "utf-8");
    // This is what finalizeSuccess calls
    await commitAllChanges(r2, "ashara: agent output for task x");

    // Both commits exist on the branch: partial and finalized
    const log = await git(w2, "log", "--oneline");
    expect(log).toContain("partial work for retry");
    expect(log).toContain("agent output for task x");

    // Both files present
    const v1 = await readFile(join(w2, "v1.ts"), "utf-8");
    expect(v1).toContain("v = 1");
    const v2 = await readFile(join(w2, "v2.ts"), "utf-8");
    expect(v2).toContain("v = 2");

    await cleanupWorkdir(w2, target, branch);
  });

  test("a git failure is reported as git-error, not thrown", async () => {
    // A non-git directory — commitPartialWork must not throw
    const nonGitDir = await makeDir("ashara-partial-nogit-");
    await writeFile(join(nonGitDir, "file.txt"), "content", "utf-8");

    const outcome = await commitPartialWork(
      { gitDir: join(nonGitDir, ".git"), workTree: nonGitDir },
      "ashara: partial work for retry (task x, dispatch 1, agent-failed)",
    );
    expect(outcome.committed).toBe(false);
    if (!outcome.committed) {
      expect(outcome.reason).toBe("git-error");
    }
  });
});

describe("commitAllChanges fails closed", () => {
  test("a git refusal throws WorktreeCommitFailed, an environment failure, and the branch gains no commit", async () => {
    const base = await makeDir("ashara-commit-refused-");
    const target = join(base, "project");
    await ensureTargetGitInit(target);
    const branch = "task/test-commit-refused";
    const { workDir, repo } = await createWorkdir(join(base, "work"), target, branch);
    await writeFile(join(workDir, "work.ts"), "export const w = 1;", "utf-8");
    const before = await git(workDir, "rev-parse", "HEAD");
    // A held index lock is a host git that cannot record anything, whatever the work is.
    await writeFile(join(repo.gitDir, "index.lock"), "", "utf-8");

    const thrown = await commitAllChanges(repo, "ashara: agent output for task x").catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(WorktreeCommitFailed);
    if (!(thrown instanceof WorktreeCommitFailed)) return;
    expect(thrown.step).toBe("add");
    expect(thrown.detail).toContain("index.lock");
    const environmentFailure = environmentErrorOf(thrown);
    expect(environmentFailure).toBe(thrown);
    if (environmentFailure === null) return;
    expect(unavailableOf(environmentFailure, "host git")).toBe("host git (add of the task worktree)");
    expect(await git(workDir, "rev-parse", "HEAD")).toBe(before);

    await rm(join(repo.gitDir, "index.lock"));
    await cleanupWorkdir(workDir, target, branch);
  });
});
