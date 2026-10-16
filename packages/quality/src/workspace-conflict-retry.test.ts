import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { cleanupWorkdir, commitAllChanges, commitPartialWork, createWorkdir, createWorkdirForRetry, ensureTargetGitInit } from "@ashara/execution-infra";
import type { WorkdirInfo } from "@ashara/execution-infra";
import { ConflictRetryUnprepared, conflictWithMain, mainMergedForRetry, stagedConflictMarkers, taskBranchName, tentativeMerge } from "./merge.js";
import type { MainConflict } from "./merge.js";

// Two tasks of one batch leave the same main and change the same file. Once the first is
// merged, the second's branch conflicts with main; its retry must start with that conflict in its
// worktree, never on the branch as it was. Real git throughout.

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd });
  return stdout.trim();
}

/** A retry's worktree of `taskId`'s branch, made ready as a dispatch makes it (mainMergedForRetry). */
function retryWorkdir(workdirBase: string, target: string, taskId: string, conflict: MainConflict | null): Promise<WorkdirInfo> {
  return createWorkdirForRetry(workdirBase, target, taskBranchName(taskId), mainMergedForRetry(taskId, conflict));
}

afterAll(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

/** A target whose main holds task `first`'s change to shared.txt, and task `second`'s branch, cut from the same main, its own. */
async function sameBaseConflict(): Promise<{ readonly target: string; readonly workdirBase: string }> {
  const base = await mkdtemp(join(tmpdir(), "ashara-conflict-retry-"));
  tempDirs.push(base);
  const target = join(base, "project");
  const workdirBase = base;
  await ensureTargetGitInit(target, workdirBase);
  await writeFile(join(target, "shared.txt"), "base\n");
  await git(target, "add", "-A");
  await git(target, "commit", "-q", "-m", "base");
  for (const [taskId, line] of [["first", "first\n"], ["second", "second\n"]] as const) {
    const { workDir, repo } = await createWorkdir(workdirBase, target, taskBranchName(taskId));
    await writeFile(join(workDir, "shared.txt"), line);
    await writeFile(join(workDir, `${taskId}.txt`), line);
    await commitAllChanges(repo, `work of ${taskId}`);
    await cleanupWorkdir(workDir, target);
  }
  await git(target, "merge", "-q", "--no-ff", "-m", "merge first", taskBranchName("first"));
  return { target, workdirBase };
}

describe("a retry of a branch that conflicts with main", () => {
  test("starts with main merged in and the conflict in front of the implementer; resolved, it merges", async () => {
    const { target, workdirBase } = await sameBaseConflict();
    expect((await tentativeMerge(target, taskBranchName("second"))).status).toBe("conflict");
    await git(target, "merge", "--abort");

    const conflict = await conflictWithMain(target, "second");
    expect(conflict).toEqual({ mainCommit: await git(target, "rev-parse", "main"), files: ["shared.txt"] });
    if (conflict === null) return;

    const retry = await retryWorkdir(workdirBase, target, "second", conflict);
    expect(await readFile(join(retry.workDir, "shared.txt"), "utf8")).toMatch(/^<{7} [^\n]*\nsecond\n={7}\nfirst\n>{7} /);
    expect(await readFile(join(retry.workDir, "first.txt"), "utf8")).toBe("first\n");
    expect(await stagedConflictMarkers(retry.repo, conflict.files)).toEqual(["shared.txt"]);
    // A failed attempt commits nothing of the unfinished merge: the next one merges main again.
    expect(await commitPartialWork(retry.repo, "partial")).toEqual({ committed: false, reason: "merge-in-progress" });

    await writeFile(join(retry.workDir, "shared.txt"), "first\nsecond\n");
    expect(await stagedConflictMarkers(retry.repo, conflict.files)).toEqual([]);
    await commitAllChanges(retry.repo, "ashara: agent output for task second");
    await cleanupWorkdir(retry.workDir, target);

    expect(await conflictWithMain(target, "second")).toBeNull();
    expect((await tentativeMerge(target, taskBranchName("second"))).status).toBe("clean");
    await git(target, "commit", "-q", "-m", "merge second");
    expect(await readFile(join(target, "shared.txt"), "utf8")).toBe("first\nsecond\n");
  });

  // A branch whose merge with main failed post-merge verification would be
  // retried on a tree without main's newer work, where the failure cannot reproduce.
  test("a branch that merges cleanly is resumed with main's newer work merged in, once", async () => {
    const { target, workdirBase } = await sameBaseConflict();
    const { workDir, repo } = await createWorkdir(workdirBase, target, taskBranchName("third"));
    await writeFile(join(workDir, "third.txt"), "third\n");
    await commitAllChanges(repo, "work of third");
    await cleanupWorkdir(workDir, target);
    await git(target, "merge", "-q", "--no-ff", "-m", "merge second", "-X", "theirs", taskBranchName("second"));
    expect(await conflictWithMain(target, "third")).toBeNull();

    const retry = await retryWorkdir(workdirBase, target, "third", null);
    expect(await readFile(join(retry.workDir, "second.txt"), "utf8")).toBe("second\n");
    expect(await readFile(join(retry.workDir, "third.txt"), "utf8")).toBe("third\n");
    expect(await git(retry.workDir, "status", "--porcelain")).toBe("");
    expect(await git(retry.workDir, "merge-base", "--is-ancestor", "main", "HEAD")).toBe("");
    const head = await git(retry.workDir, "rev-parse", "HEAD");
    await cleanupWorkdir(retry.workDir, target);

    // Main has not moved since: the branch already holds it, and nothing more is merged.
    const again = await retryWorkdir(workdirBase, target, "third", null);
    expect(await git(again.workDir, "rev-parse", "HEAD")).toBe(head);
    await cleanupWorkdir(again.workDir, target);
  });

  test("a conflict git does not reproduce in the worktree is unprepared, and the worktree is removed", async () => {
    const { target, workdirBase } = await sameBaseConflict();
    const conflict = await conflictWithMain(target, "second");
    if (conflict === null) throw new Error("expected a conflict");

    const stale = { ...conflict, files: ["other.txt"] };
    await expect(retryWorkdir(workdirBase, target, "second", stale)).rejects.toBeInstanceOf(ConflictRetryUnprepared);
    expect(await git(target, "worktree", "list", "--porcelain")).not.toContain("task-second");
    await expect(conflictWithMain(target, "no-such-task")).rejects.toBeInstanceOf(ConflictRetryUnprepared);
  });
});

// The fault-class soak (t-ddd-fix-own-faults): a cleanup whose git failed left a worktree registered
// with its directory gone, or a crash left the directory too; every later `worktree add` there, and
// the deletion of a check branch it held, refused, and the task could never be dispatched again.
describe("a worktree slot left by a crash or a faulted cleanup", () => {
  test("a registration whose directory is gone, or a directory left whole, never stops the next worktree", async () => {
    const { target, workdirBase } = await sameBaseConflict();
    const left = await retryWorkdir(workdirBase, target, "first", null);
    await rm(left.workDir, { recursive: true, force: true });

    const again = await retryWorkdir(workdirBase, target, "first", null);
    expect(again.workDir).toBe(left.workDir);
    await writeFile(join(again.workDir, "residue.txt"), "uncommitted\n");

    // The directory left whole, still registered.
    const third = await retryWorkdir(workdirBase, target, "first", null);
    expect(await readFile(join(third.workDir, "first.txt"), "utf8")).toBe("first\n");
    await expect(readFile(join(third.workDir, "residue.txt"), "utf8")).rejects.toThrow();
    await cleanupWorkdir(third.workDir, target);
  });
});
