import { runHostGit } from "@ashara/execution-infra";
import type { ErrorLayer } from "@ashara/shared";
import { describeErrorChain, wrapError } from "@ashara/shared";
import { CheckoutHolderOverran, withTargetCheckout, type CheckoutLease } from "../checkout-lock.js";
import { environmentErrorOf } from "../environment-failure.js";
import type { EnvironmentError } from "../environment-failure.js";
import type { ExecutionEventSink, TaskDescriptor } from "../execution-service.js";
import { targetRepo } from "../host-git.js";
import {
  abortMerge,
  buildMergeAgentBrief,
  commitMerge,
  mergeInProgress,
  recoverOrphanedMerge,
  resetCheckoutToHead,
  taskBranchName,
  tentativeMerge,
} from "../merge.js";
import { ensureTargetGitInit } from "../workspace.js";

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
 * - "postMergeScaffold": the product scaffold's build and test on its merge are its first and only
 *   verdict (no gate ran them before the merge, ADR-074 addendum 2 d74 D): a failure is the
 *   scaffold's own attempt failing, retried like any other, never a regression of the tree.
 */
type PostMergeOperation = "postMergeVerify" | "postMergeTaskChecks" | "postMergeScaffold";

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
   * fallback: there is no host runner. It runs holding the target checkout, and extends `lease` by
   * the bound of each phase it runs in cells before running it, so a finalize waiting behind it
   * waits no longer than that (withTargetCheckout).
   */
  readonly postMergeVerify: (targetProjectPath: string, lease: CheckoutLease) => Promise<PostMergeVerdict>;
}

/**
 * The tentative merge could not be undone, neither by `git merge --abort` nor by a reset to HEAD:
 * the target checkout holds residue no later merge may be built on. The next finalize on the
 * checkout restores it first and refuses to merge while it cannot (finalizeHeld).
 */
class TargetCheckoutUnrestored extends Error {
  constructor(
    readonly taskId: string,
    readonly targetPath: string,
    /** What the merge was being undone after. */
    readonly after: string,
    /** Why the reset to HEAD did not restore it either. */
    readonly restoreDetail: string,
    options: { readonly cause: unknown },
  ) {
    super(
      `task ${taskId}: the tentative merge in ${targetPath} could not be aborted after ${after} ` +
        `(${describeErrorChain(options.cause)}), and ${restoreDetail}; no merge runs on this checkout until it is restored`,
      { cause: options.cause },
    );
    this.name = "TargetCheckoutUnrestored";
  }
}

/** Why the checkout is not back at HEAD with no merge staged, or null when it is. */
async function unrestoredReason(targetProjectPath: string): Promise<string | null> {
  const reset = await resetCheckoutToHead(targetProjectPath);
  if (reset.status === "error") return reset.message;
  try {
    return (await mergeInProgress(targetProjectPath)) ? "a merge is still staged (MERGE_HEAD) after the reset to HEAD" : null;
  } catch (e) {
    return `whether a merge is still staged could not be read: ${describeErrorChain(e)}`;
  }
}

/**
 * Undoes the tentative merge. `git merge --abort` failing (a merge that never staged has nothing
 * for it to undo) falls back to a reset to HEAD; when neither restores the checkout the failure is
 * returned typed for the caller to block on, never swallowed: a merge verdict built on top of the
 * residue would be untrustworthy (Discipline A).
 */
async function undoTentativeMerge(taskId: string, targetProjectPath: string, after: string): Promise<VerificationInfrastructureFault | null> {
  try {
    await abortMerge(targetProjectPath);
    return null;
  } catch (abortError) {
    const reason = await unrestoredReason(targetProjectPath);
    if (reason === null) {
      console.warn(`[${taskId}] git merge --abort failed after ${after} (${describeErrorChain(abortError)}); the checkout was reset to HEAD instead`);
      return null;
    }
    const unrestored = new TargetCheckoutUnrestored(taskId, targetProjectPath, after, `the reset to HEAD did not restore it: ${reason}`, { cause: abortError });
    console.warn(`[${taskId}] ${unrestored.message}`);
    return new VerificationInfrastructureFault(taskId, `restoring the target checkout after ${after}`, { cause: unrestored });
  }
}

/** The merge's own failure, unless undoing it failed: then the checkout is the operator's first, whatever the gate said. */
function unrestoredFailure(
  fault: VerificationInfrastructureFault,
  gateFailureContext: string,
  // open-by-design: gateContext carries caller-supplied diagnostic context per gate type
  gate: { operation: string; gateOutput: unknown; gateContext?: Record<string, unknown> },
): FinalizeResult {
  return {
    success: false,
    gateFailureContext: `${gateFailureContext}\n${fault.message}`,
    errorLayer: wrapError("development", POST_MERGE_CHECK_RUN, fault, {
      ...gate.gateContext,
      gateOperation: gate.operation,
      gateOutput: wrapError("development", gate.operation, gate.gateOutput),
    }),
    environmentFailure: null,
    infrastructureFault: fault,
  };
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

  const unrestored = await undoTentativeMerge(taskId, targetProjectPath, errorLayerInfo.operation);
  if (unrestored !== null) return unrestoredFailure(unrestored, gateFailureContext, errorLayerInfo);
  console.log(`[${taskId}] tentative merge aborted — main restored, task branch preserved for retry`);

  const errorLayer = wrapError("development", errorLayerInfo.operation, errorLayerInfo.gateOutput, errorLayerInfo.gateContext);

  return { success: false, gateFailureContext, errorLayer, environmentFailure, infrastructureFault };
}

/**
 * Merges the task branch, which the caller has already committed the agent's work to (a commit
 * that failed ended the dispatch before this point), and checks the merge. One finalize at a time
 * per target (ADR-074 d82 W3): from the orphan recovery through the commit or the abort, the
 * checkout's lock is held, so a batch's other task neither aborts this one's tentative merge nor
 * merges against a main this one is about to move; it waits and merges against the main it lands on.
 */
export async function finalizeSuccess(
  deps: FinalizeDeps,
  task: TaskDescriptor,
  targetProjectPath: string,
  attempt: number,
): Promise<FinalizeResult> {
  const holder = `finalize of task ${task.id} attempt ${attempt}`;
  try {
    return await withTargetCheckout(targetProjectPath, holder, (lease) => finalizeHeld(deps, task, targetProjectPath, attempt, lease));
  } catch (e) {
    if (!(e instanceof CheckoutHolderOverran) || e.waiter !== holder) throw e;
    // Nothing was merged and no check ran: the stuck holder is the operator's, never the task's failure.
    console.warn(`[${task.id}] ${e.message}`);
    const fault = new VerificationInfrastructureFault(task.id, "waiting for the target checkout", { cause: e });
    return {
      success: false,
      gateFailureContext: fault.message,
      errorLayer: wrapError("development", POST_MERGE_CHECK_RUN, fault, { taskId: task.id, attempt, holder: e.holder, boundMs: e.boundMs, heldMs: e.heldMs }),
      environmentFailure: null,
      infrastructureFault: fault,
    };
  }
}

async function finalizeHeld(
  deps: FinalizeDeps,
  task: TaskDescriptor,
  targetProjectPath: string,
  attempt: number,
  lease: CheckoutLease,
): Promise<FinalizeResult> {
  await recoverOrphanedMerge(targetProjectPath);
  await ensureTargetGitInit(targetProjectPath);

  // Ordered after ensureTargetGitInit so HEAD is guaranteed to exist, and before the tentative merge.
  // This is also where a checkout an earlier finalize could not restore (TargetCheckoutUnrestored)
  // stays blocked: every finalize restores it first, and none merges until that succeeds.
  const unrestored = await unrestoredReason(targetProjectPath);
  if (unrestored !== null) {
    // Fail closed: an unrestorable checkout makes every merge verdict below
    // untrustworthy, so refuse rather than merge onto unknown residue. Nothing is known of the
    // task's work, so it is blocked for the operator, never failed against the task.
    const fault = new VerificationInfrastructureFault(task.id, "restoring the target checkout to HEAD before the merge", { cause: unrestored });
    console.warn(`[${task.id}] target checkout could not be restored — refusing to merge: ${unrestored}`);
    return {
      success: false,
      gateFailureContext: `Target checkout could not be restored to HEAD before merge: ${unrestored}`,
      errorLayer: wrapError("development", POST_MERGE_CHECK_RUN, fault, {
        taskId: task.id,
        attempt,
        step: "resetCheckoutToHead",
      }),
      environmentFailure: null,
      infrastructureFault: fault,
    };
  }

  const mergeResult = await tentativeMerge(targetProjectPath, taskBranchName(task.id));

  if (mergeResult.status === "conflict") {
    const mergeContext = buildMergeAgentBrief(task, mergeResult.files);
    const unrestored = await undoTentativeMerge(task.id, targetProjectPath, "a merge conflict");
    if (unrestored !== null) {
      return unrestoredFailure(unrestored, mergeContext, {
        operation: "tentativeMerge",
        gateOutput: "merge conflict",
        gateContext: { taskId: task.id, attempt, conflictFiles: mergeResult.files },
      });
    }
    console.log(`[${task.id}] tentative merge CONFLICT — aborted, branch preserved for retry`);
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
    const unrestored = await undoTentativeMerge(task.id, targetProjectPath, "a failed tentative merge");
    if (unrestored !== null) {
      return unrestoredFailure(unrestored, `Tentative merge failed: ${mergeResult.message}`, {
        operation: "tentativeMerge",
        gateOutput: mergeResult.message,
        gateContext: { taskId: task.id, attempt },
      });
    }
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
    postMergeVerify = await deps.postMergeVerify(targetProjectPath, lease);
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
