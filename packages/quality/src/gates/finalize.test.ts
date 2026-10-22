import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test, vi } from "vitest";
import { CheckoutHolderOverran, ensureTargetGitInit, mergeInProgress, targetRepo, withTargetCheckout } from "@ashara/execution-infra";
import { createWorkItemId, observeContendedWaits } from "@ashara/shared";
import { recordingLogger } from "@ashara/shared/testing";
import type { Logger } from "@ashara/shared";
import type { DispatchRef } from "../dispatch-result.js";
import { VerificationInfrastructureFault } from "../fault-class.js";
import { recoverOrphanedMerge, resetCheckoutToHead, taskBranchName, tentativeMerge } from "../merge.js";
import { finalizeSuccess } from "./finalize.js";
import type { FinalizeDeps, PostMergeVerdict } from "./finalize.js";

// ---------------------------------------------------------------------------
// A batch runs two tasks at once, and each finalize resets,
// merges into, checks and commits the one main checkout of the target. Real
// git throughout: the hazard is what git does to a staged merge.
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];
/** The workdir base of every target here: finalize initialises a target only inside it. */
const WORKDIR_BASE = await mkdtemp(join(tmpdir(), "ashara-finalize-"));
tempDirs.push(WORKDIR_BASE);

async function makeDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(WORKDIR_BASE, prefix));
  tempDirs.push(dir);
  return dir;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

async function hasMergeHead(target: string): Promise<boolean> {
  return mergeInProgress(targetRepo(target));
}

function task(): DispatchRef {
  return { id: createWorkItemId(), attempt: 1 };
}

/**
 * A target with one task branch per task, each from the same main, built as the dispatcher builds them: each adds
 * its own file, or all write `shared` with their own content (a batch's conflict).
 */
async function targetWithBranches(tasks: readonly DispatchRef[], shared?: string): Promise<string> {
  const target = join(await makeDir("ashara-finalize-target-"), "project");
  await ensureTargetGitInit(target, WORKDIR_BASE);
  for (const [i, t] of tasks.entries()) {
    const workDir = join(await makeDir("ashara-finalize-wt-"), "wt");
    await git(target, "worktree", "add", workDir, "-b", taskBranchName(t.id), "main");
    await writeFile(join(workDir, shared ?? `file-${i}.txt`), `task ${i}\n`, "utf-8");
    await git(workDir, "add", "-A");
    await git(workDir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", `work ${i}`);
    await git(target, "worktree", "remove", workDir, "--force");
  }
  return target;
}

function deps(postMergeVerify: FinalizeDeps["postMergeVerify"], logger: Logger = recordingLogger()): FinalizeDeps {
  return { postMergeOperation: "postMergeTaskChecks", postMergeVerify, presentedConflict: null, workdirBase: WORKDIR_BASE, logger };
}

afterAll(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

describe("finalize serialises per target checkout", () => {
  test("without the lock, a second finalize's opening steps destroy the first's tentative merge", async () => {
    const [a, b] = [task(), task()];
    const target = await targetWithBranches([a, b]);
    expect((await tentativeMerge(target, taskBranchName(a.id), recordingLogger())).status).toBe("clean");
    expect(await hasMergeHead(target)).toBe(true);

    // What finalizeSuccess does first, run while the first task's checks would be running.
    await recoverOrphanedMerge(target, recordingLogger());
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
    const thrown = await withTargetCheckout(target, "thrower", () => Promise.reject(new Error("holder failed"))).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(Error);
    expect(await withTargetCheckout(target, "next", () => Promise.resolve("next"))).toBe("next");
  });

  test("a waiter fails naming the holder once the holder outlasts its declared bound; the stuck checkout is never taken", async () => {
    const target = await makeDir("ashara-finalize-stuck-");
    // A waiter arms its bound only after the real I/O that canonicalises the target, and fake time advanced before
    // that is time its bound never sees. It reaches contendedWait with the bound armed, so count arrivals there.
    let armed = 0;
    let bothArmed: () => void = () => {};
    const waitersArmed = new Promise<void>((done) => {
      bothArmed = done;
    });
    let restoreWaits: () => void = () => {};
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      let releaseStuck: () => void = () => {};
      let extended: () => void = () => {};
      const leaseExtended = new Promise<void>((done) => {
        extended = done;
      });
      const stuck = withTargetCheckout(target, "stuck holder", async (lease) => {
        lease.extend(60_000, "a cell phase");
        extended();
        await new Promise<void>((done) => {
          releaseStuck = done;
        });
      });
      await leaseExtended;
      // Installed once the holder has the checkout, so the only arrivals it counts are the two waiters.
      restoreWaits = observeContendedWaits((kind, waiting) => {
        if (kind === "target-checkout" && ++armed === 2) bothArmed();
        return waiting;
      });
      let waiterSettled = false;
      const waiter = withTargetCheckout(target, "waiter", () => Promise.resolve("ran")).catch((e: unknown) => e);
      void waiter.then(() => {
        waiterSettled = true;
      });
      const third = withTargetCheckout(target, "third", () => Promise.resolve("third ran")).catch((e: unknown) => e);
      await waitersArmed;

      // Past the host-side allowance alone, but inside the extended bound: still waiting.
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 30_000);
      expect(waiterSettled).toBe(false);

      await vi.advanceTimersByTimeAsync(60_000);
      const failed = await waiter;
      expect(failed).toBeInstanceOf(CheckoutHolderOverran);
      if (!(failed instanceof CheckoutHolderOverran)) return;
      expect(failed).toMatchObject({ holder: "stuck holder", waiter: "waiter", boundMs: 5 * 60 * 1000 + 60_000 });
      expect(failed.message).toMatch(/a cell phase 60000 ms/);

      // The third arrival waits behind the stuck holder too, never behind the waiter that gave up.
      expect(await third).toMatchObject({ name: "CheckoutHolderOverran", holder: "stuck holder", waiter: "third" });
      releaseStuck();
      await stuck;
      expect(await withTargetCheckout(target, "after", () => Promise.resolve("after ran"))).toBe("after ran");
    } finally {
      vi.useRealTimers();
      restoreWaits();
    }
  });
});

describe("a tentative merge that cannot be undone", () => {
  test("is a typed infrastructure fault, and no later finalize merges on the checkout until it is restored", async () => {
    const [a, b] = [task(), task()];
    const target = await targetWithBranches([a, b]);
    const lock = join(target, ".git", "index.lock");

    // The check fails, and git's index lock then refuses the reset to HEAD.
    const first = await finalizeSuccess(
      deps(async () => {
        await writeFile(lock, "");
        return { passed: false, details: "check failed" };
      }),
      a,
      target,
      1,
    );
    expect(first.success).toBe(false);
    if (first.success) return;
    expect(first.fault.class).toBe("ashara");
    if (first.fault.class !== "ashara") return;
    expect(first.fault.error).toBeInstanceOf(VerificationInfrastructureFault);
    expect(first.fault.error.message).toMatch(/could not be undone after postMergeTaskChecks: git reset --hard HEAD failed.*index\.lock.*no merge runs on this checkout until it is restored/s);
    expect(first.errorLayer.operation).toBe("postMergeCheckRun");

    let verified = false;
    const blocked = await finalizeSuccess(
      deps(async () => {
        verified = true;
        return { passed: true, details: "ok" };
      }),
      b,
      target,
      1,
    );
    expect(verified).toBe(false);
    expect(blocked.success).toBe(false);
    if (blocked.success) return;
    expect(blocked.fault.class === "ashara" ? blocked.fault.error.step : blocked.fault.class).toBe("restoring the target checkout to HEAD before the merge");

    await rm(lock);
    const restored = await finalizeSuccess(deps(async () => ({ passed: true, details: "ok" })), b, target, 1);
    if (!restored.success) throw new Error(`the finalize after the restore failed: ${JSON.stringify(restored)}`);
    expect(await git(target, "ls-tree", "--name-only", "main")).toBe("file-1.txt");
    expect(await hasMergeHead(target)).toBe(false);
  });
});

describe("a checkout stranded off main", () => {
  test("whose restore failed at the merge recovery is put back on main before the merge, so the merge recorded is on main", async () => {
    const [a, b] = [task(), task()];
    const target = await targetWithBranches([a, b]);
    // A dead finalize left b's branch checked out, with a change that refuses `git checkout main`.
    await git(target, "checkout", "-q", taskBranchName(b.id));
    await writeFile(join(target, "file-1.txt"), "changed by hand\n", "utf-8");

    const result = await finalizeSuccess(deps(async () => ({ passed: true, details: "ok" })), a, target, 1);
    if (!result.success) throw new Error(`the finalize failed: ${JSON.stringify(result)}`);
    expect(await git(target, "rev-parse", "main")).toBe(result.mergeCommit);
    expect(await git(target, "ls-tree", "--name-only", "main")).toBe("file-0.txt");
    expect(await git(target, "symbolic-ref", "--short", "HEAD")).toBe("main");
  });
});

describe("a conflicted merge", () => {
  test("is a failed merge, never a failed verify; one after the attempt was handed its conflict is recorded apart", async () => {
    const [a, b] = [task(), task()];
    const target = await targetWithBranches([a, b], "shared.txt");
    const passed = async (): Promise<PostMergeVerdict> => ({ passed: true, details: "ok" });
    expect((await finalizeSuccess(deps(passed), a, target, 1)).success).toBe(true);

    let verified = false;
    const verify = async (): Promise<PostMergeVerdict> => {
      verified = true;
      return { passed: true, details: "ok" };
    };
    // Undoing a conflicted merge is the normal path: nothing fails, so nothing is logged at warn or error.
    const logger = recordingLogger();
    const stale = await finalizeSuccess(deps(verify, logger), b, target, 1);
    expect(logger.records.filter((r) => r.level === "warn" || r.level === "error")).toEqual([]);
    expect(logger.records.map((r) => [r.level, r.event])).toContainEqual(["info", "quality.merge-conflict"]);
    expect(await git(target, "status", "--porcelain")).toBe("");
    if (stale.success) throw new Error("expected a conflict");
    expect(stale).toMatchObject({ failedStep: "merge", fault: { class: "agent_work" } });
    expect(stale.errorLayer).toMatchObject({ operation: "tentativeMerge", context: { conflictFiles: ["shared.txt"] } });
    expect(stale.gateFailureContext).toContain("- shared.txt");
    expect(stale.gateFailureContext).not.toContain("conflict markers");

    const presented = { mainCommit: await git(target, "rev-parse", "main"), files: ["shared.txt"] };
    const again = await finalizeSuccess({ ...deps(verify), presentedConflict: presented }, b, target, 2);
    if (again.success) throw new Error("expected a conflict");
    expect(again.errorLayer.operation).toBe("tentativeMergeAfterConflict");
    expect(again.gateFailureContext).toContain("conflicted again");
    expect(verified).toBe(false);
    expect(await hasMergeHead(target)).toBe(false);
  });
});

// A merge git refuses without a
// conflict, and a target checkout changed outside the merge, are Z0's own faults, never the task's.
describe("Z0's faults in the merge are blocked under class ashara", () => {
  test("a merge git refuses without a conflict: class ashara under postMergeCheckRun; no check runs", async () => {
    const t = task();
    const target = join(await makeDir("ashara-finalize-nobranch-"), "project");
    await ensureTargetGitInit(target, WORKDIR_BASE);
    let verified = false;

    // The task branch does not exist: git refuses the merge, and no file is left unmerged.
    const result = await finalizeSuccess(
      deps(async () => {
        verified = true;
        return { passed: true, details: "ok" };
      }),
      t,
      target,
      1,
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.fault.class).toBe("ashara");
    expect(result.errorLayer.operation).toBe("postMergeCheckRun");
    expect(verified).toBe(false);
    expect(await hasMergeHead(target)).toBe(false);
  });

  test("a tracked file changed outside the merge before its commit: class ashara, the merge aborted", async () => {
    const a = task();
    const target = await targetWithBranches([a]);

    const result = await finalizeSuccess(
      deps(async () => {
        // Every check runs on a throwaway checkout: a change here is residue no check could leave.
        await writeFile(join(target, "file-0.txt"), "residue\n", "utf-8");
        return { passed: true, details: "ok" };
      }),
      a,
      target,
      1,
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.fault.class).toBe("ashara");
    expect(result.gateFailureContext).toContain("changed outside the merge");
    expect(await hasMergeHead(target)).toBe(false);
  });
});
