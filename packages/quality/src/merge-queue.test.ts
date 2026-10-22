import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { ensureTargetGitInit } from "@ashara/execution-infra";
import { recordingLogger } from "@ashara/shared/testing";
import { commitMerge, deleteSettledTaskBranch, releaseMergedTaskCheckout, resetCheckoutToHead, taskMergeOnMain, tentativeMerge } from "./merge.js";

// ---------------------------------------------------------------------------
// Post-merge verify runs the project's own build inside the MAIN
// checkout, so whatever that build produces dirties the checkout the NEXT merge
// needs clean. Real git throughout — the refusal being reproduced is git's own
// ("Your local changes to the following files would be overwritten by merge"),
// and a mock could not produce it.
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

let target: string;

async function makeDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

/** A task branch built in its own worktree, exactly as the dispatcher does. */
async function commitOnTaskBranch(
  branch: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  const workDir = join(await makeDir("ashara-merge-wt-"), branch.replace(/\//g, "-"));
  await git(target, "worktree", "add", workDir, "-b", branch, "main");
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(workDir, name), content, "utf-8");
  }
  await git(workDir, "add", "-A");
  await git(workDir, "commit", "-m", `work on ${branch}`);
  await git(target, "worktree", "remove", workDir, "--force");
}

beforeEach(async () => {
  const base = await makeDir("ashara-merge-target-");
  target = join(base, "project");
  await ensureTargetGitInit(target, base);
});

afterAll(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

describe("target scaffold", () => {
  test("writes no .gitignore — the project's ignores are the project's", async () => {
    await expect(access(join(target, ".gitignore"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("commits a root commit even though nothing is scaffolded", async () => {
    await expect(git(target, "rev-parse", "HEAD")).resolves.toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("the merge record", () => {
  test("commitMerge returns the merge commit now at main, whose second parent is the task branch", async () => {
    await commitOnTaskBranch("task/one", { "a.txt": "a\n" });
    const branchTip = await git(target, "rev-parse", "task/one");
    await tentativeMerge(target, "task/one", recordingLogger());

    const mergeCommit = await commitMerge(target, "one");

    expect(mergeCommit).toBe(await git(target, "rev-parse", "main"));
    expect(await git(target, "rev-parse", `${mergeCommit}^2`)).toBe(branchTip);
  });

  test("taskMergeOnMain finds the merge commitMerge made, and none of another task", async () => {
    await commitOnTaskBranch("task/one", { "a.txt": "a\n" });
    await tentativeMerge(target, "task/one", recordingLogger());
    const mergeCommit = await commitMerge(target, "one");

    expect(await taskMergeOnMain(target, "one")).toBe(mergeCommit);
    expect(await taskMergeOnMain(target, "two")).toBeNull();
  });

  test("a target whose repository does not exist yet holds no merge", async () => {
    const parent = await makeDir("ashara-merge-absent-");
    expect(await taskMergeOnMain(join(parent, "never-created"), "one")).toBeNull();
    await mkdir(join(parent, "no-repo"));
    expect(await taskMergeOnMain(join(parent, "no-repo"), "one")).toBeNull();
  });

  test("a repository git cannot read is MainUnreadable, never no merge", async () => {
    const broken = join(await makeDir("ashara-merge-broken-"), "project");
    await mkdir(join(broken, ".git"), { recursive: true });
    await expect(taskMergeOnMain(broken, "one")).rejects.toMatchObject({ name: "MainUnreadable" });
  });
});

describe("merge queue vs. build residue in the main checkout", () => {
  test("a tracked build artifact rebuilt by post-merge verify blocks the next merge", async () => {
    await commitOnTaskBranch("task/one", { "main.go": "package main\n", jot: "binary-v1" });
    expect((await tentativeMerge(target, "task/one", recordingLogger())).status).toBe("clean");
    await commitMerge(target, "one");

    // Post-merge verify: `go build ./...` regenerates the tracked binary here.
    await writeFile(join(target, "jot"), "binary-v1-rebuilt", "utf-8");

    await commitOnTaskBranch("task/two", { "main.go": "package main\n\nfunc main() {}\n", jot: "binary-v2" });

    const refused = await tentativeMerge(target, "task/two", recordingLogger());
    // Not "conflict": git refuses before the merge starts, so nothing is
    // unmerged and the refusal lands in the error branch. The artifact git
    // names is the only locale-independent part of its message.
    expect(refused.status).toBe("error");
    if (refused.status === "error") {
      expect(refused.message).toContain("jot");
    }
  });

  test("resetCheckoutToHead makes that same merge succeed", async () => {
    await commitOnTaskBranch("task/one", { "main.go": "package main\n", jot: "binary-v1" });
    await tentativeMerge(target, "task/one", recordingLogger());
    await commitMerge(target, "one");

    await writeFile(join(target, "jot"), "binary-v1-rebuilt", "utf-8");
    await writeFile(join(target, "coverage.out"), "untracked residue", "utf-8");

    await commitOnTaskBranch("task/two", { "main.go": "package main\n\nfunc main() {}\n", jot: "binary-v2" });

    expect((await resetCheckoutToHead(target)).status).toBe("clean");
    expect(await git(target, "status", "--porcelain")).toBe("");
    expect((await tentativeMerge(target, "task/two", recordingLogger())).status).toBe("clean");
  });

  test("a genuine content conflict is still reported as a conflict", async () => {
    // Both branches fork from the SAME base so the second merge really diverges.
    await commitOnTaskBranch("task/one", { "main.go": "package main // one\n" });
    await commitOnTaskBranch("task/two", { "main.go": "package main // two\n" });

    await tentativeMerge(target, "task/one", recordingLogger());
    await commitMerge(target, "one");

    await resetCheckoutToHead(target);
    const result = await tentativeMerge(target, "task/two", recordingLogger());
    expect(result.status).toBe("conflict");
    if (result.status === "conflict") {
      expect(result.files).toContain("main.go");
    }
  });

  test("an unrestorable checkout reports the failure rather than merging blind", async () => {
    const missing = join(target, "does-not-exist");
    const result = await resetCheckoutToHead(missing);
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("git reset --hard HEAD failed");
    }
  });
});

describe("a settled task's branch", () => {
  test("is deleted when its work was merged, and when it was discarded with commits main never took", async () => {
    await commitOnTaskBranch("task/merged", { "a.txt": "a\n" });
    await commitOnTaskBranch("task/discarded", { "a.txt": "other\n" });
    await tentativeMerge(target, "task/merged", recordingLogger());
    await commitMerge(target, "merged");

    await deleteSettledTaskBranch(target, "merged", "merged into main", recordingLogger());
    // The conflicting branch of a task completed as already delivered: none of its commits is on main.
    await deleteSettledTaskBranch(target, "discarded", "completed as already delivered", recordingLogger());

    expect(await git(target, "branch", "--list", "task/*")).toBe("");
  });

  test("a branch a worktree still holds is left, with git's cause at warn", async () => {
    await commitOnTaskBranch("task/held", { "a.txt": "a\n" });
    await git(target, "worktree", "add", join(await makeDir("ashara-merge-held-"), "wt"), "task/held");
    const logger = recordingLogger();
    await deleteSettledTaskBranch(target, "held", "completed as already delivered", logger);
    expect(logger.records.map((r) => [r.level, r.event, r.fields?.["branch"]])).toEqual([["warn", "quality.settled-branch-left", "task/held"]]);
    expect(JSON.stringify(logger.records[0]?.error)).toMatch(/branch -D task\/held/);
    expect(await git(target, "branch", "--list", "task/held")).not.toBe("");
  });

  test("of a task found merged on main after its dispatch died, is deleted with the worktree that dispatch left", async () => {
    const workdirBase = dirname(target);
    await commitOnTaskBranch("task/orphan", { "a.txt": "a\n" });
    await tentativeMerge(target, "task/orphan", recordingLogger());
    await commitMerge(target, "orphan");
    const slot = join(workdirBase, "task-orphan");
    await git(target, "worktree", "add", slot, "task/orphan");
    const logger = recordingLogger();
    await releaseMergedTaskCheckout(workdirBase, target, "orphan", "merged on main", logger);
    expect(logger.records).toEqual([]);
    expect(await git(target, "branch", "--list", "task/*")).toBe("");
    expect(await git(target, "worktree", "list", "--porcelain")).not.toContain(slot);
    await expect(access(slot)).rejects.toThrow();
  });
});
