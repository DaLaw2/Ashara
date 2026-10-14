import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { createWorkItemId, parseProjectId } from "@ashara/shared";
import type { TaskDescriptor } from "../execution-service.js";
import { withTargetCheckout } from "../checkout-lock.js";
import { recoverOrphanedMerge, resetCheckoutToHead, taskBranchName, tentativeMerge } from "../merge.js";
import { ensureTargetGitInit } from "../workspace.js";
import { finalizeSuccess } from "./finalize.js";
import type { FinalizeDeps, PostMergeVerdict } from "./finalize.js";

// ---------------------------------------------------------------------------
// ADR-074 d82 W3: a batch runs two tasks at once, and each finalize resets,
// merges into, checks and commits the one main checkout of the target. Real
// git throughout: the hazard is what git does to a staged merge.
// ---------------------------------------------------------------------------

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

async function hasMergeHead(target: string): Promise<boolean> {
  return git(target, "rev-parse", "-q", "--verify", "MERGE_HEAD").then(
    () => true,
    () => false,
  );
}

function task(): TaskDescriptor {
  return {
    id: createWorkItemId(),
    projectId: parseProjectId("22222222-2222-4222-8222-222222222222", "test"),
    title: "t",
    dispatchCount: 1,
    attempt: 1,
    workKind: "implementation",
    successCriteria: [],
  };
}

/** A target with one task branch per task, each adding its own file, built as the dispatcher builds them. */
async function targetWithBranches(tasks: readonly TaskDescriptor[]): Promise<string> {
  const target = join(await makeDir("ashara-finalize-target-"), "project");
  await ensureTargetGitInit(target);
  for (const [i, t] of tasks.entries()) {
    const workDir = join(await makeDir("ashara-finalize-wt-"), "wt");
    await git(target, "worktree", "add", workDir, "-b", taskBranchName(t.id), "main");
    await writeFile(join(workDir, `file-${i}.txt`), `task ${i}\n`, "utf-8");
    await git(workDir, "add", "-A");
    await git(workDir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", `work ${i}`);
    await git(target, "worktree", "remove", workDir, "--force");
  }
  return target;
}

function deps(postMergeVerify: FinalizeDeps["postMergeVerify"]): FinalizeDeps {
  return { postMergeOperation: "postMergeTaskChecks", postMergeVerify };
}

afterAll(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe("finalize serialises per target checkout", () => {
  test("without the lock, a second finalize's opening steps destroy the first's tentative merge", async () => {
    const [a, b] = [task(), task()];
    const target = await targetWithBranches([a, b]);
    expect((await tentativeMerge(target, taskBranchName(a.id))).status).toBe("clean");
    expect(await hasMergeHead(target)).toBe(true);

    // What finalizeSuccess does first, run while the first task's checks would be running.
    await recoverOrphanedMerge(target);
    await resetCheckoutToHead(target);

    expect(await hasMergeHead(target)).toBe(false);
    expect(await git(target, "status", "--porcelain")).toBe("");
  });

  test("two concurrent finalizes on one target run one at a time; the second merges onto the first's commit", async () => {
    const [a, b] = [task(), task()];
    const target = await targetWithBranches([a, b]);
    // The second caller names the same checkout through a symlink: the lock keys on the canonical path.
    const alias = join(await makeDir("ashara-finalize-alias-"), "link");
    await symlink(target, alias);

    let releaseA: () => void = () => {};
    const aMayFinish = new Promise<void>((done) => {
      releaseA = done;
    });
    let aEntered: () => void = () => {};
    const aVerifying = new Promise<void>((done) => {
      aEntered = done;
    });
    const order: string[] = [];
    const passed: PostMergeVerdict = { passed: true, details: "ok" };

    const finalizeA = finalizeSuccess(
      deps(async () => {
        order.push("a:verify");
        aEntered();
        await aMayFinish;
        order.push("a:verified");
        return passed;
      }),
      a,
      target,
      1,
    );
    await aVerifying;
    const finalizeB = finalizeSuccess(
      deps(async () => {
        order.push("b:verify");
        return passed;
      }),
      b,
      alias,
      1,
    );

    // B is waiting: given time to run, it neither reaches its checks nor touches A's staged merge.
    await new Promise((done) => setTimeout(done, 300));
    expect(order).toEqual(["a:verify"]);
    expect(await hasMergeHead(target)).toBe(true);

    releaseA();
    const [resultA, resultB] = await Promise.all([finalizeA, finalizeB]);
    expect(order).toEqual(["a:verify", "a:verified", "b:verify"]);
    if (!resultA.success || !resultB.success) throw new Error(`a finalize failed: ${JSON.stringify([resultA, resultB])}`);
    expect(await git(target, "rev-parse", `${resultB.mergeCommit}^1`)).toBe(resultA.mergeCommit);
    expect(await git(target, "ls-tree", "--name-only", "main")).toBe("file-0.txt\nfile-1.txt");
  });

  test("a holder that throws releases the checkout for the next", async () => {
    const target = await makeDir("ashara-finalize-throw-");
    const thrown = await withTargetCheckout(target, () => Promise.reject(new Error("holder failed"))).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(Error);
    expect(await withTargetCheckout(target, () => Promise.resolve("next"))).toBe("next");
  });
});
