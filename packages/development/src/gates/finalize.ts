import { runHostGit } from "@ashara/execution-infra";
import type { ErrorLayer } from "@ashara/shared";
import { describeErrorChain, wrapError } from "@ashara/shared";
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
import { ensureTargetGitInit } from "../workspace.js";
import { checkEntryPointRewrite } from "./entry-point.js";

/**
 * Z0's own machinery around a run of checks failed (a git worktree, a commit, a check file written
 * into the checkout), after the merge, in a red run on main or in an implementer's run_checks; not
 * the substrate and not a check:
 * no verdict exists, so the failure belongs to no party the task could answer for.
 */
export class VerificationInfrastructureFault extends Error {
  constructor(
    readonly taskId: string,
    /** What Z0 was doing when it failed, e.g. "stored-check run". */
    readonly step: string,
    options: { readonly cause: unknown },
  ) {
    super(`verification of task ${taskId} could not run: ${step} failed: ${describeErrorChain(options.cause)}`, { cause: options.cause });
    this.name = "VerificationInfrastructureFault";
  }
}

/** The operation an infrastructure fault of the post-merge check is recorded under. */
const POST_MERGE_CHECK_RUN = "postMergeCheckRun";

export type FinalizeResult =
  /** `mergeCommit`: the commit the merge made on main, read back from git; the task's merge record. */
  | { readonly success: true; readonly mergeCommit: string }
  | {
      readonly success: false;
      readonly gateFailureContext: string;
      readonly errorLayer: ErrorLayer;
      /**
       * Set when the verifier cell's substrate failed, not a check: the caller blocks the task on
       * the environment instead of routing a failure against a tree no check ever ran on.
       */
      readonly environmentFailure: EnvironmentError | null;
      /**
       * Set when Z0's own verification machinery failed (recorded under postMergeCheckRun): the
       * caller blocks the task for the operator, never routes a failure against the task.
       */
      readonly infrastructureFault: VerificationInfrastructureFault | null;
    };

export interface FinalizeContractInfo {
  readonly entryPointPath: string | null;
}

/** The post-merge check's verdict on the target checkout holding the tentative merge. */
export interface PostMergeVerdict {
  readonly passed: boolean;
  readonly details: string;
}

/**
 * The operation a post-merge failure is recorded under, which is what planning routes it by.
 * - "postMergeVerify": the task's own tree already passed this check before the merge (the
 *   substrate gate), so a failure belongs to the merged tree, not the task (a tree regression).
 * - "postMergeTaskChecks": the stored checks are the task's first and only verdict; nothing ran
 *   them on the task's own work before, so a failure is the task's work failing its checks.
 */
type PostMergeOperation = "postMergeVerify" | "postMergeTaskChecks";

export interface FinalizeDeps {
  readonly eventSink?: ExecutionEventSink;
  /** Required: what a post-merge failure means differs by check, and routing reads it from here. */
  readonly postMergeOperation: PostMergeOperation;
  /**
   * Checks the tentative merge in a short-lived cell, torn down after (execution-service):
   * the checks the check author stored for the task, on a throwaway checkout of the merge
   * with the stored check files written over it, or for a substrate-checked task the
   * gate's own run (the environment's build then test, from the image the gate built) on a
   * throwaway checkout of the merge, which must stay clean. The cell has
   * no network (execution-infra's podman run passes --network=none). Required, no
   * fallback: there is no host runner.
   */
  readonly postMergeVerify: (targetProjectPath: string) => Promise<PostMergeVerdict>;
}

async function abortAndFail(
  taskId: string,
  targetProjectPath: string,
  failedLogMessage: string,
  gateFailureContext: string,
  // open-by-design: gateContext carries caller-supplied diagnostic context per gate type
  errorLayerInfo: { operation: string; gateOutput: string | Error; gateContext?: Record<string, unknown> },
  environmentFailure: EnvironmentError | null = null,
  infrastructureFault: VerificationInfrastructureFault | null = null,
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

  return { success: false, gateFailureContext, errorLayer, environmentFailure, infrastructureFault };
}

/**
 * Merges the task branch, which the caller has already committed the agent's work to (a commit
 * that failed ended the dispatch before this point), and checks the merge.
 */
export async function finalizeSuccess(
  deps: FinalizeDeps,
  task: TaskDescriptor,
  targetProjectPath: string,
  attempt: number,
  contractInfo: FinalizeContractInfo = { entryPointPath: null },
): Promise<FinalizeResult> {
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
      infrastructureFault: null,
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
      infrastructureFault: null,
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
      infrastructureFault: null,
    };
  }

  let postMergeVerify: PostMergeVerdict;
  try {
    postMergeVerify = await deps.postMergeVerify(targetProjectPath);
  } catch (e) {
    // The verifier cell could not be created or the checks could not run: the
    // merge is unverified, so it is aborted (Discipline A). No check ran, so a
    // throw says nothing about the task or the merged tree: a substrate failure
    // and a fault of Z0's own machinery are each carried out typed for the
    // caller to block on, never reported as a failed post-merge verify.
    const detail = describeErrorChain(e);
    const environmentFailure = environmentErrorOf(e);
    if (environmentFailure !== null) {
      return abortAndFail(
        task.id,
        targetProjectPath,
        `post-merge verification could not run, the verifier cell's environment failed (${environmentFailure.name}) — aborting tentative merge`,
        `Post-merge verify could not run: ${detail}`,
        // The typed error itself is the cause, its class and fields intact, never a flattened string.
        { operation: "postMergeVerify", gateOutput: environmentFailure, gateContext: { taskId: task.id, attempt, errorClass: environmentFailure.name } },
        environmentFailure,
      );
    }
    const fault = e instanceof VerificationInfrastructureFault ? e : new VerificationInfrastructureFault(task.id, "post-merge verification", { cause: e });
    return abortAndFail(
      task.id,
      targetProjectPath,
      `post-merge verification could not run, Z0's verification machinery failed (${fault.step}) — aborting tentative merge`,
      `Post-merge verify could not run: ${fault.message}`,
      { operation: POST_MERGE_CHECK_RUN, gateOutput: fault, gateContext: { taskId: task.id, attempt, errorClass: fault.name, step: fault.step } },
      null,
      fault,
    );
  }

  if (!postMergeVerify.passed) {
    return abortAndFail(
      task.id,
      targetProjectPath,
      "post-merge verification FAILED — aborting tentative merge",
      `Post-merge verify failed:\n${postMergeVerify.details}`,
      {
        operation: deps.postMergeOperation,
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
    const detail = describeErrorChain(e);
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

  const mergeCommit = await commitMerge(targetProjectPath, task.id);
  console.log(`[${task.id}] merge committed to main as ${mergeCommit}`);

  // The dev_sessions terminal write lives in DevelopmentService.withSessionLifecycle,
  // the one seam every outcome passes through. It used to happen here, on the success
  // path only, which is precisely how six failure returns came to have none.
  return { success: true, mergeCommit };
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
