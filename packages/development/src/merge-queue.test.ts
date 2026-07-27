import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { commitMerge, resetCheckoutToHead, tentativeMerge } from "./merge.js";
import { ensureTargetGitInit } from "./workspace.js";

// ---------------------------------------------------------------------------
// Run 39: post-merge verify runs the project's own build inside the MAIN
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
  target = join(await makeDir("ashara-merge-target-"), "project");
  await ensureTargetGitInit(target);
});

afterAll(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe("target scaffold", () => {
  test("writes no .gitignore — the project's ignores are the project's", async () => {
    const exists = await access(join(target, ".gitignore")).then(() => true, () => false);
    expect(exists).toBe(false);
  });

  test("excludes the control dir through .git/info/exclude instead", async () => {
    const exclude = await readFile(join(target, ".git", "info", "exclude"), "utf-8");
    expect(exclude).toContain(".ashara/");

    await writeFile(join(target, "note.txt"), "x", "utf-8");
    const untracked = await git(target, "status", "--porcelain", "--untracked-files=all");
    expect(untracked).toContain("note.txt");
    expect(untracked).not.toContain(".ashara");
  });

  test("is idempotent — repeated init does not duplicate the exclude entry", async () => {
    await ensureTargetGitInit(target);
    await ensureTargetGitInit(target);
    const exclude = await readFile(join(target, ".git", "info", "exclude"), "utf-8");
    const occurrences = exclude.split("\n").filter((line) => line.trim() === ".ashara/").length;
    expect(occurrences).toBe(1);
  });

  test("commits a root commit even though nothing is scaffolded", async () => {
    await expect(git(target, "rev-parse", "HEAD")).resolves.toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("merge queue vs. build residue in the main checkout", () => {
  test("a tracked build artifact rebuilt by post-merge verify blocks the next merge", async () => {
    await commitOnTaskBranch("task/one", { "main.go": "package main\n", jot: "binary-v1" });
    expect((await tentativeMerge(target, "task/one")).status).toBe("clean");
    await commitMerge(target, "one");

    // Post-merge verify: `go build ./...` regenerates the tracked binary here.
    await writeFile(join(target, "jot"), "binary-v1-rebuilt", "utf-8");

    await commitOnTaskBranch("task/two", { "main.go": "package main\n\nfunc main() {}\n", jot: "binary-v2" });

    const refused = await tentativeMerge(target, "task/two");
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
    await tentativeMerge(target, "task/one");
    await commitMerge(target, "one");

    await writeFile(join(target, "jot"), "binary-v1-rebuilt", "utf-8");
    await writeFile(join(target, "coverage.out"), "untracked residue", "utf-8");

    await commitOnTaskBranch("task/two", { "main.go": "package main\n\nfunc main() {}\n", jot: "binary-v2" });

    expect((await resetCheckoutToHead(target)).status).toBe("clean");
    expect(await git(target, "status", "--porcelain")).toBe("");
    expect((await tentativeMerge(target, "task/two")).status).toBe("clean");
  });

  test("a genuine content conflict is still reported as a conflict", async () => {
    // Both branches fork from the SAME base so the second merge really diverges.
    await commitOnTaskBranch("task/one", { "main.go": "package main // one\n" });
    await commitOnTaskBranch("task/two", { "main.go": "package main // two\n" });

    await tentativeMerge(target, "task/one");
    await commitMerge(target, "one");

    await resetCheckoutToHead(target);
    const result = await tentativeMerge(target, "task/two");
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
