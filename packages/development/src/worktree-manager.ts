// ---------------------------------------------------------------------------
// WorktreeManager — Resource Handle + Anti-Corruption Layer (ADR-044 Phase 3)
//
// Encapsulates the full git worktree lifecycle (acquire -> use -> merge ->
// release) behind a branded handle. The handle is the workDir path, branded
// so callers cannot fabricate one from a raw string. All operations validate
// the handle against a tracked set — using a released handle is a hard error.
//
// MergeSession encapsulates the tentative-merge lifecycle (merge -> verify ->
// entryPoint -> commit/abort). commit() enforces that verify and entryPoint
// gates have been called and passed before moving main forward.
//
// Both classes WRAP the existing workspace.ts / merge.ts / verify-core.ts /
// entry-point.ts functions — no behavioral changes, only lifecycle discipline.
// ---------------------------------------------------------------------------

import { basename } from "node:path";

import type { GateResult } from "./gates/types.js";
import { checkEntryPointRewrite } from "./gates/entry-point.js";
import {
  abortMerge,
  branchExists,
  captureMainHead,
  commitMerge,
  recoverOrphanedMerge,
  taskBranchName,
  tentativeMerge,
} from "./merge.js";
import type { MergeResult } from "./merge.js";
import type { CoreVerifyDeps, CoreVerifyResult } from "./verify-core.js";
import { runVerifyCore } from "./verify-core.js";
import {
  commitAllChanges,
  createWorkdir,
  createWorkdirForRetry,
  ensureTargetGitInit,
  getChangedFiles,
  removeWorktree,
  WorkspaceError,
} from "./workspace.js";

// ---------------------------------------------------------------------------
// Branded handle
// ---------------------------------------------------------------------------

declare const WorktreeHandleBrand: unique symbol;

/**
 * Branded workDir path. Only {@link WorktreeManager.acquire} mints these.
 * The runtime value is the workDir string; the brand exists only at the
 * type level to prevent callers from passing arbitrary paths.
 */
export type WorktreeHandle = string & { readonly [WorktreeHandleBrand]: true };

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class WorktreeLifecycleError extends WorkspaceError {
  constructor(
    public readonly phase: string,
    public readonly handle: string | undefined,
    context: { readonly targetPath?: string; readonly workDir?: string; readonly taskId?: string },
    cause?: unknown,
  ) {
    super(`lifecycle:${phase}`, context, cause);
    this.name = "WorktreeLifecycleError";
  }
}

export class MergeSessionError extends Error {
  constructor(
    public readonly phase: string,
    public readonly targetProjectPath: string,
    public readonly detail: string,
    cause?: unknown,
  ) {
    super(`merge-session ${phase}: ${detail}`);
    this.name = "MergeSessionError";
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

// ---------------------------------------------------------------------------
// MergeSession
// ---------------------------------------------------------------------------

/** Gate pass/fail tracking — commit() requires both gates to have passed. */
interface GateState {
  verifyCalled: boolean;
  verifyPassed: boolean;
  entryPointCalled: boolean;
  entryPointPassed: boolean;
}

/**
 * Encapsulates a tentative merge lifecycle. Created only by
 * {@link WorktreeManager.beginMerge}; callers run verify + entryPoint gates,
 * then commit (move main forward) or abort (restore pre-merge state).
 */
export class MergeSession {
  private readonly gateState: GateState = {
    verifyCalled: false,
    verifyPassed: false,
    entryPointCalled: false,
    entryPointPassed: false,
  };
  private concluded = false;

  /** @internal — only WorktreeManager.beginMerge() should construct this. */
  constructor(
    private readonly targetProjectPath: string,
    private readonly taskBranch: string,
    private readonly preMergeHead: string | null,
    /** The merge result from tentativeMerge — exposed so the caller can inspect conflict state. */
    public readonly mergeResult: MergeResult,
  ) {}

  /**
   * Run deterministic verification checks against the merged target tree.
   * Must be called (and must pass) before {@link commit}.
   */
  async verify(
    checks: readonly string[],
    verifyDeps: CoreVerifyDeps = {},
  ): Promise<CoreVerifyResult> {
    this.assertNotConcluded("verify");

    const result = await runVerifyCore(
      {
        workDir: this.targetProjectPath,
        gitRoot: this.targetProjectPath,
        checks: [...checks],
      },
      verifyDeps,
    );

    this.gateState.verifyCalled = true;
    this.gateState.verifyPassed = result.passed;
    return result;
  }

  /**
   * Run the entry-point-rewrite check against the merged target tree.
   * Must be called (and must pass) before {@link commit}.
   */
  async checkEntryPoint(entryPointPath: string | null): Promise<GateResult> {
    this.assertNotConcluded("checkEntryPoint");

    const result = await checkEntryPointRewrite(
      this.targetProjectPath,
      this.preMergeHead,
      entryPointPath,
    );

    this.gateState.entryPointCalled = true;
    this.gateState.entryPointPassed = result.passed;
    return result;
  }

  /**
   * Move main forward — finalize the merge. Requires both verify and
   * checkEntryPoint to have been called and passed.
   */
  async commit(taskId: string): Promise<void> {
    this.assertNotConcluded("commit");

    if (!this.gateState.verifyCalled) {
      throw new MergeSessionError(
        "commit",
        this.targetProjectPath,
        "verify() must be called before commit()",
      );
    }
    if (!this.gateState.verifyPassed) {
      throw new MergeSessionError(
        "commit",
        this.targetProjectPath,
        "verify() failed — cannot commit a merge that did not pass verification",
      );
    }
    if (!this.gateState.entryPointCalled) {
      throw new MergeSessionError(
        "commit",
        this.targetProjectPath,
        "checkEntryPoint() must be called before commit()",
      );
    }
    if (!this.gateState.entryPointPassed) {
      throw new MergeSessionError(
        "commit",
        this.targetProjectPath,
        "checkEntryPoint() failed — cannot commit a merge that did not pass entry-point check",
      );
    }

    try {
      await commitMerge(this.targetProjectPath, taskId);
      this.concluded = true;
    } catch (e) {
      throw new MergeSessionError("commit", this.targetProjectPath, "commitMerge failed", e);
    }
  }

  /** Abort the tentative merge — restore main to preMergeHead. */
  async abort(): Promise<void> {
    this.assertNotConcluded("abort");

    try {
      await abortMerge(this.targetProjectPath);
      this.concluded = true;
    } catch (e) {
      throw new MergeSessionError("abort", this.targetProjectPath, "abortMerge failed", e);
    }
  }

  /** True when either commit() or abort() has been called successfully. */
  get isConcluded(): boolean {
    return this.concluded;
  }

  private assertNotConcluded(operation: string): void {
    if (this.concluded) {
      throw new MergeSessionError(
        operation,
        this.targetProjectPath,
        "session already concluded (committed or aborted)",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// WorktreeManager
// ---------------------------------------------------------------------------

export class WorktreeManager {
  private readonly tracked = new Set<WorktreeHandle>();

  constructor(private readonly worktreeBase: string) {}

  // ---- Phase 1: Acquire ----------------------------------------------------

  /**
   * Acquire a worktree handle for a task. Initializes the target project's git
   * repo if needed, creates a worktree (new or retry), and returns a branded
   * handle that gates all subsequent operations.
   */
  async acquire(
    targetProjectPath: string,
    taskId: string,
    opts?: { retry?: boolean },
  ): Promise<WorktreeHandle> {
    const taskBranch = taskBranchName(taskId);

    try {
      await ensureTargetGitInit(targetProjectPath);

      const branchAlreadyExists = await branchExists(targetProjectPath, taskBranch);
      const shouldRetry = opts?.retry ?? branchAlreadyExists;

      const info = shouldRetry
        ? await createWorkdirForRetry(this.worktreeBase, targetProjectPath, taskBranch)
        : await createWorkdir(this.worktreeBase, targetProjectPath, taskBranch);

      const handle = info.workDir as WorktreeHandle;
      this.tracked.add(handle);
      return handle;
    } catch (e) {
      if (e instanceof WorkspaceError) throw e;
      throw new WorktreeLifecycleError(
        "acquire",
        undefined,
        { targetPath: targetProjectPath, taskId },
        e,
      );
    }
  }

  // ---- Phase 2: Use --------------------------------------------------------

  /** List changed files in the worktree (git status --porcelain). */
  async getChangedFiles(handle: WorktreeHandle): Promise<string[]> {
    this.assertTracked(handle, "getChangedFiles");
    return getChangedFiles(handle);
  }

  /** Stage all and commit in the worktree. */
  async commitChanges(handle: WorktreeHandle, message: string): Promise<void> {
    this.assertTracked(handle, "commitChanges");
    await commitAllChanges(handle, message);
  }

  // ---- Phase 3: Merge ------------------------------------------------------

  /**
   * Begin a tentative merge of the task branch into main. Performs crash
   * recovery first (orphaned merges from prior runs), then stages the merge
   * without moving main. Returns a {@link MergeSession} for gate evaluation.
   */
  async beginMerge(
    handle: WorktreeHandle,
    targetProjectPath: string,
  ): Promise<MergeSession> {
    this.assertTracked(handle, "beginMerge");

    try {
      await recoverOrphanedMerge(targetProjectPath);
      await ensureTargetGitInit(targetProjectPath);

      const preMergeHead = await captureMainHead(targetProjectPath);
      const taskBranch = this.taskBranchFromHandle(handle);
      const mergeResult = await tentativeMerge(targetProjectPath, taskBranch);

      return new MergeSession(targetProjectPath, taskBranch, preMergeHead, mergeResult);
    } catch (e) {
      if (e instanceof MergeSessionError) throw e;
      throw new WorktreeLifecycleError(
        "beginMerge",
        handle,
        { targetPath: targetProjectPath, workDir: handle },
        e,
      );
    }
  }

  // ---- Phase 4: Release ----------------------------------------------------

  /**
   * Release the worktree handle — removes the worktree and optionally deletes
   * the task branch. After release, the handle is invalid; any further
   * operations with it throw.
   */
  async release(
    handle: WorktreeHandle,
    targetProjectPath: string,
    opts?: { deleteBranch?: boolean },
  ): Promise<void> {
    this.assertTracked(handle, "release");

    try {
      const branchToDelete = opts?.deleteBranch
        ? this.taskBranchFromHandle(handle)
        : undefined;

      await removeWorktree(targetProjectPath, handle, branchToDelete);
    } catch (e) {
      throw new WorktreeLifecycleError(
        "release",
        handle,
        { targetPath: targetProjectPath, workDir: handle },
        e,
      );
    } finally {
      // Always remove from tracking — even if cleanup fails, the handle is
      // logically dead. Callers should not retry release.
      this.tracked.delete(handle);
    }
  }

  // ---- Introspection -------------------------------------------------------

  /** True when the handle is still tracked (not released). */
  isValid(handle: WorktreeHandle): boolean {
    return this.tracked.has(handle);
  }

  /** Number of currently tracked handles. */
  get activeCount(): number {
    return this.tracked.size;
  }

  // ---- Internal helpers ----------------------------------------------------

  private assertTracked(handle: WorktreeHandle, operation: string): void {
    if (!this.tracked.has(handle)) {
      throw new WorktreeLifecycleError(
        operation,
        handle,
        { workDir: handle },
        new Error("handle is not tracked — already released or never acquired"),
      );
    }
  }

  /**
   * Derive the git branch name from the worktree handle (workDir path).
   *
   * createWorkdir() builds the path as: join(base, taskBranch.replace(/\//g, "-")).
   * So for branch "task/abc-123", the dir basename is "task-abc-123".
   * We reverse: basename -> replace first "-" back to "/" -> "task/abc-123".
   *
   * This avoids requiring callers to pass the taskId redundantly when they
   * already hold a handle that encodes it.
   */
  private taskBranchFromHandle(handle: WorktreeHandle): string {
    const dirName = basename(handle);
    // taskBranchName() produces "task/<id>", so the dir is "task-<id>".
    // Restore the first "-" to "/" to recover the branch name.
    const dashIndex = dirName.indexOf("-");
    if (dashIndex === -1) {
      return dirName;
    }
    return dirName.slice(0, dashIndex) + "/" + dirName.slice(dashIndex + 1);
  }
}
