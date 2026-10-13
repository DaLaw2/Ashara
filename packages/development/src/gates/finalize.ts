import { runHostGit, type HostRepo } from "@ashara/execution-infra";
import type { ErrorLayer } from "@ashara/shared";
import { wrapError } from "@ashara/shared";
import { environmentErrorOf } from "../environment-failure.js";
import type { EnvironmentError } from "../environment-failure.js";
import type { ExecutionEventSink, TaskDescriptor } from "../execution-service.js";
import { targetRepo } from "../host-git.js";
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
import { commitAllChanges, ensureTargetGitInit } from "../workspace.js";
import { checkEntryPointRewrite } from "./entry-point.js";

export type FinalizeResult =
  | { readonly success: true }
  | {
      readonly success: false;
      readonly gateFailureContext: string;
      readonly errorLayer: ErrorLayer;
      /**
       * Set when the verifier cell's substrate failed, not a check: the caller blocks the task on
       * the environment instead of routing a failure against a tree no check ever ran on.
       */
      readonly environmentFailure: EnvironmentError | null;
    };

export interface FinalizeContractInfo {
  readonly entryPointPath: string | null;
}

/** The post-merge check's verdict on the target checkout holding the tentative merge. */
export interface PostMergeVerdict {
  readonly passed: boolean;
  readonly details: string;
}

export interface FinalizeDeps {
  readonly eventSink?: ExecutionEventSink;
  /**
   * Checks the target checkout holding the tentative merge in a short-lived cell
   * that mounts it, torn down after (execution-service): the task's verify checks,
   * or for a substrate-checked task the environment's test from the image the gate
   * built. The cell has no network (execution-infra's podman run passes
   * --network=none). Required, no fallback: there is no host runner.
   */
  readonly postMergeVerify: (targetProjectPath: string) => Promise<PostMergeVerdict>;
}

async function abortAndFail(
  taskId: string,
  targetProjectPath: string,
  failedLogMessage: string,
  gateFailureContext: string,
  // open-by-design: gateContext carries caller-supplied diagnostic context per gate type
  errorLayerInfo: { operation: string; gateOutput: string; gateContext?: Record<string, unknown> },
  environmentFailure: EnvironmentError | null = null,
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

  return { success: false, gateFailureContext, errorLayer, environmentFailure };
}

export async function finalizeSuccess(
  deps: FinalizeDeps,
  worktree: HostRepo,
  task: TaskDescriptor,
  targetProjectPath: string,
  attempt: number,
  contractInfo: FinalizeContractInfo = { entryPointPath: null },
): Promise<FinalizeResult> {
  try {
    await commitAllChanges(worktree, `ashara: agent output for task ${task.id}`);
  } catch (e: unknown) {
    console.warn(`[finalize] commitAllChanges failed for task ${task.id}: ${e instanceof Error ? e.message : String(e)}`);
  }

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
      environmentFailure: null,
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
      environmentFailure: null,
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
      environmentFailure: null,
    };
  }

  let postMergeVerify: PostMergeVerdict;
  try {
    postMergeVerify = await deps.postMergeVerify(targetProjectPath);
  } catch (e) {
    // The verifier cell could not be created or the checks could not run: the
    // merge is unverified, so it is aborted (Discipline A). A substrate failure
    // says nothing about the merged tree, so it is carried out typed for the
    // caller to block on, never reported as a failed post-merge verify.
    const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    const environmentFailure = environmentErrorOf(e);
    return abortAndFail(
      task.id,
      targetProjectPath,
      environmentFailure !== null
        ? `post-merge verification could not run, the verifier cell's environment failed (${environmentFailure.name}) — aborting tentative merge`
        : "post-merge verification could not run — aborting tentative merge",
      `Post-merge verify could not run: ${detail}`,
      {
        operation: "postMergeVerify",
        gateOutput: detail,
        gateContext: { taskId: task.id, attempt, ...(environmentFailure !== null ? { errorClass: environmentFailure.name } : {}) },
      },
      environmentFailure,
    );
  }

  if (!postMergeVerify.passed) {
    return abortAndFail(
      task.id,
      targetProjectPath,
      "post-merge verification FAILED — aborting tentative merge",
      `Post-merge verify failed (same checks, target environment):\n${postMergeVerify.details}`,
      {
        operation: "postMergeVerify",
        gateOutput: postMergeVerify.details,
        gateContext: { taskId: task.id, attempt },
      },
    );
  }

  // Dirty-tree check: detect tracked-file contamination from check commands.
  // commitMerge commits only staged changes (the merge diff), so check-written
  // modifications would persist in the working tree without being committed.
  // But contamination of tracked files signals a check command that modifies
  // source — that is unexpected and should abort rather than proceed.
  let dirtyFiles: string[];
  try {
    dirtyFiles = await detectDirtyTrackedFiles(targetProjectPath);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return abortAndFail(
      task.id,
      targetProjectPath,
      "post-merge dirty-tree check FAILED — git diff unavailable",
      `Could not run git diff to verify clean working tree: ${detail}`,
      {
        operation: "postMergeDirtyTree",
        gateOutput: `git diff failed: ${detail}`,
        gateContext: { taskId: task.id, attempt },
      },
    );
  }
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
  console.log(`[${task.id}] merge committed to main`);

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
 *
 * Rejects when git is unavailable or exits non-zero (fail-closed): a
 * dirty-tree check that cannot run is a failed check, not a passed one.
 */
async function detectDirtyTrackedFiles(targetProjectPath: string): Promise<string[]> {
  const { stdout } = await runHostGit(targetRepo(targetProjectPath), ["diff", "--name-only"]);
  return stdout
    .trim()
    .split("\n")
    .filter((line) => line.length > 0);
}
