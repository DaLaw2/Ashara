import { spawn } from "node:child_process";
import type { ErrorLayer } from "@ashara/shared";
import { wrapError } from "@ashara/shared";
import type { ExecutionEventSink, TaskDescriptor } from "../execution-service.js";
import {
  abortMerge,
  buildMergeAgentBrief,
  captureMainHead,
  commitMerge,
  recoverOrphanedMerge,
  resetCheckoutToHead,
  taskBranchName,
  tentativeMerge,
} from "../merge.js";
import { runVerifyCore } from "../verify-core.js";
import type { CommandRunner } from "../verify-core.js";
import { commitAllChanges, ensureTargetGitInit } from "../workspace.js";
import { checkEntryPointRewrite } from "./entry-point.js";

export type FinalizeResult =
  | { readonly success: true }
  | { readonly success: false; readonly gateFailureContext: string; readonly errorLayer: ErrorLayer };

export interface FinalizeContractInfo {
  readonly entryPointPath: string | null;
}

export interface FinalizeDeps {
  readonly eventSink?: ExecutionEventSink;
  /**
   * How the post-merge verify executes check commands. Required — no fallback.
   * Network-isolated (--network=none) — checks observe the built tree.
   */
  readonly runCommand: CommandRunner;
  /**
   * How the post-merge verify executes toolchain preparation (npm install,
   * cargo build, go mod download). Required — no fallback. Network-enabled
   * because preparation fetches dependencies.
   */
  readonly prepareRunCommand: CommandRunner;
}

async function abortAndFail(
  taskId: string,
  targetProjectPath: string,
  failedLogMessage: string,
  gateFailureContext: string,
  // open-by-design: gateContext carries caller-supplied diagnostic context per gate type
  errorLayerInfo: { operation: string; gateOutput: string; gateContext?: Record<string, unknown> },
): Promise<FinalizeResult> {
  console.log(`[${taskId}] ${failedLogMessage}`);

  let abortError: ErrorLayer | undefined;
  try {
    await abortMerge(targetProjectPath);
  } catch (e) {
    abortError = wrapError("development", "abortMerge", e, { taskId });
  }
  console.log(`[${taskId}] tentative merge aborted — main restored, task branch preserved for retry`);

  const errorLayer = wrapError("development", errorLayerInfo.operation, errorLayerInfo.gateOutput, {
    ...errorLayerInfo.gateContext,
    ...(abortError ? { abortError } : {}),
  });

  return { success: false, gateFailureContext, errorLayer };
}

export async function finalizeSuccess(
  deps: FinalizeDeps,
  workDir: string,
  task: TaskDescriptor,
  targetProjectPath: string | null,
  attempt: number,
  contractInfo: FinalizeContractInfo = { entryPointPath: null },
): Promise<FinalizeResult> {
  try {
    await commitAllChanges(workDir, `ashara: agent output for task ${task.id}`);
  } catch (e: unknown) {
    console.warn(`[finalize] commitAllChanges failed for task ${task.id}: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (targetProjectPath) {
    await recoverOrphanedMerge(targetProjectPath);
    await ensureTargetGitInit(targetProjectPath);

    // Ordered after ensureTargetGitInit so HEAD is guaranteed to exist, and
    // before captureMainHead so the entry-point gate diffs against a clean tree.
    const reset = await resetCheckoutToHead(targetProjectPath);
    if (reset.status === "error") {
      // Fail closed: an unrestorable checkout makes every merge verdict below
      // untrustworthy, so refuse rather than merge onto unknown residue.
      console.log(`[${task.id}] target checkout could not be restored — refusing to merge`);
      return {
        success: false,
        gateFailureContext: `Target checkout could not be restored to HEAD before merge: ${reset.message}`,
        errorLayer: wrapError("development", "resetCheckoutToHead", reset.message, {
          taskId: task.id,
          attempt,
        }),
      };
    }

    const preMergeHead = await captureMainHead(targetProjectPath);
    const mergeResult = await tentativeMerge(targetProjectPath, taskBranchName(task.id));

    if (mergeResult.status === "conflict") {
      await abortMerge(targetProjectPath);
      console.log(`[${task.id}] tentative merge CONFLICT — aborted, branch preserved for retry`);
      const mergeContext = buildMergeAgentBrief(task, mergeResult.files);
      return {
        success: false,
        gateFailureContext: mergeContext,
        errorLayer: wrapError("development", "tentativeMerge", "merge conflict", {
          taskId: task.id,
          attempt,
          conflictFiles: mergeResult.files,
        }),
      };
    }

    if (mergeResult.status === "error") {
      await abortMerge(targetProjectPath).catch(() => {});
      console.log(`[${task.id}] tentative merge FAILED — aborted`);
      return {
        success: false,
        gateFailureContext: `Tentative merge failed: ${mergeResult.message}`,
        errorLayer: wrapError("development", "tentativeMerge", mergeResult.message, {
          taskId: task.id,
          attempt,
        }),
      };
    }

    // Per-task verify uses only verify.toml; contract and taskSpec checks are
    // deferred to integration verify (they reference project-wide files that
    // may not exist in this task's worktree).
    const postMergeVerify = await runVerifyCore(
      {
        workDir: targetProjectPath,
        gitRoot: targetProjectPath,
        checks: [],
        contractChecks: [],
      },
      {
        runCommand: deps.runCommand,
        prepareRunCommand: deps.prepareRunCommand,
        log: (event) => deps.eventSink?.emit({
          ...event,
          event: "post_merge_verify",
          taskId: task.id,
          attempt,
        }),
      },
    );

    if (postMergeVerify.verdict !== "passed") {
      return abortAndFail(
        task.id,
        targetProjectPath,
        "post-merge verification FAILED — aborting tentative merge",
        `Post-merge verify failed (same checks, target environment):\n${postMergeVerify.tiers.deterministic.details}`,
        {
          operation: "postMergeVerify",
          gateOutput: postMergeVerify.tiers.deterministic.details,
          gateContext: { taskId: task.id, attempt },
        },
      );
    }

    // Dirty-tree check: detect tracked-file contamination from check commands.
    // commitMerge commits only staged changes (the merge diff), so check-written
    // modifications would persist in the working tree without being committed.
    // But contamination of tracked files signals a check command that modifies
    // source — that is unexpected and should abort rather than proceed.
    const dirtyFiles = await detectDirtyTrackedFiles(targetProjectPath);
    if (dirtyFiles.length > 0) {
      const fileList = dirtyFiles.slice(0, 20).join(", ");
      return abortAndFail(
        task.id,
        targetProjectPath,
        "post-merge dirty-tree check FAILED — check commands modified tracked files",
        `Check commands modified ${dirtyFiles.length} tracked file(s): ${fileList}`,
        {
          operation: "postMergeDirtyTree",
          gateOutput: `${dirtyFiles.length} tracked file(s) modified by check commands: ${fileList}`,
          gateContext: { taskId: task.id, attempt, dirtyFiles },
        },
      );
    }

    const entryPointCheck = await checkEntryPointRewrite(targetProjectPath, preMergeHead, contractInfo.entryPointPath);
    deps.eventSink?.emit({
      event: "entry_point_rewrite_check",
      taskId: task.id,
      attempt,
      passed: entryPointCheck.passed,
      output: entryPointCheck.output.slice(0, 1000),
    });

    if (!entryPointCheck.passed) {
      return abortAndFail(
        task.id,
        targetProjectPath,
        "entry-point-rewrite check FAILED — aborting tentative merge",
        `Entry-point rewrite check failed:\n${entryPointCheck.output}`,
        {
          operation: "entryPointRewriteCheck",
          gateOutput: entryPointCheck.output,
          gateContext: { taskId: task.id, attempt },
        },
      );
    }

    await commitMerge(targetProjectPath, task.id);
    console.log(`[${task.id}] merge committed to main, task branch deleted`);
  }

  console.log(`[${task.id}] task completed — work dir preserved at: ${workDir}`);

  // The dev_sessions terminal write lives in DevelopmentService.withSessionLifecycle,
  // the one seam every outcome passes through. It used to happen here, on the success
  // path only, which is precisely how six failure returns came to have none.
  return { success: true };
}

// ---------------------------------------------------------------------------
// Dirty-tree detection: tracked files modified by check commands
// ---------------------------------------------------------------------------

/**
 * Run `git diff --name-only` against the index to detect tracked files
 * modified during post-merge verification. Build artifacts in .gitignore
 * are invisible to this check; only modifications to tracked files appear.
 */
function detectDirtyTrackedFiles(cwd: string): Promise<string[]> {
  return new Promise((resolve) => {
    const proc = spawn("git", ["diff", "--name-only"], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    proc.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });

    proc.on("error", () => {
      // git not available — fail open on this specific sub-check rather than
      // blocking the entire finalize. The container boundary is the primary
      // defense; the dirty-tree check is defense-in-depth.
      resolve([]);
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        resolve([]);
        return;
      }
      const files = stdout
        .trim()
        .split("\n")
        .filter((line) => line.length > 0);
      resolve(files);
    });
  });
}
