import { CheckoutHolderOverran, ensureTargetGitInit, mergeInProgress, runHostGit, targetRepo, withTargetCheckout } from "@ashara/execution-infra";
import type { CheckoutLease } from "@ashara/execution-infra";
import type { ErrorLayer, Logger } from "@ashara/shared";
import { describeErrorChain, wrapError } from "@ashara/shared";
import { environmentErrorOf } from "../fault-class.js";
import type { EnvironmentError } from "../fault-class.js";
import type { DispatchRef } from "../dispatch-result.js";
import {
  commitMerge,
  type HeadReading,
  headOnMainReason,
  recoverOrphanedMerge,
  resetCheckoutToHead,
  taskBranchName,
  tentativeMerge,
  type MainConflict,
} from "../merge.js";
import { MERGE_CONFLICTED, TREE_REGRESSED, WORK_FAILED } from "../task-verdict.js";
import type { FailureVerdict } from "../task-verdict.js";

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

/**
 * Whose a failed finalize is (fault-class.ts FaultClass): the task's work (a conflict, a failed
 * check on the merge), routed against the task with Quality's verdict on whether another attempt
 * can succeed; or the verifier cell's substrate, or Z0's own merge
 * and verification machinery (recorded under postMergeCheckRun), each blocked under its class and
 * never routed against a tree no verdict was reached on.
 */
type FinalizeFault =
  | { readonly class: "agent_work"; readonly verdict: FailureVerdict }
  | { readonly class: "substrate"; readonly error: EnvironmentError }
  | { readonly class: "ashara"; readonly error: VerificationInfrastructureFault };

/**
 * The verdict on a merge that failed its post-merge check: a tree regression where the task's own
 * tree already passed that check (postMergeVerify), the task's own work failing otherwise.
 */
function postMergeVerdict(operation: PostMergeOperation): FailureVerdict {
  return operation === "postMergeVerify" ? TREE_REGRESSED : WORK_FAILED;
}

type FinalizeResult =
  /** `mergeCommit`: the commit the merge made on main, read back from git; the task's merge record. */
  | { readonly success: true; readonly mergeCommit: string }
  | {
      readonly success: false;
      /** Where it failed: merging the branch into main, or checking the merge (no verify runs on a merge that failed). */
      readonly failedStep: "merge" | "verification";
      readonly gateFailureContext: string;
      readonly errorLayer: ErrorLayer;
      readonly fault: FinalizeFault;
    };

/** The post-merge check's verdict on the target checkout holding the tentative merge. */
export interface PostMergeVerdict {
  readonly passed: boolean;
  readonly details: string;
}

/**
 * The operation a post-merge failure is recorded under, and what Quality's verdict on it is.
 * - "postMergeVerify": the task's own tree already passed this check before the merge (the
 *   substrate gate), so a failure belongs to the merged tree, not the task (a tree regression).
 * - "postMergeTaskChecks": the stored checks are the task's first and only verdict; nothing ran
 *   them on the task's own work before, so a failure is the task's work failing its checks.
 * - "postMergeScaffold": the product scaffold's build and test on its merge are its first and only
 *   verdict (no gate ran them before the merge): a failure is the
 *   scaffold's own attempt failing, retried like any other, never a regression of the tree.
 */
type PostMergeOperation = "postMergeVerify" | "postMergeTaskChecks" | "postMergeScaffold";

export interface FinalizeDeps {
  /** Required: what a post-merge failure means differs by check, and routing reads it from here. */
  readonly postMergeOperation: PostMergeOperation;
  /**
   * Checks the tentative merge in a short-lived cell, torn down after (TaskVerification):
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
  /**
   * The conflict with main this attempt started with in its worktree (startMainMerge), or null.
   * A branch that was handed a conflict and conflicts again is recorded under
   * tentativeMergeAfterConflict: it holds the presented main, so main moved again under the
   * resolution, and planning hands the newer conflict to the next attempt under the replan bound.
   */
  readonly presentedConflict: MainConflict | null;
  /** The workdir base: the target checkout is never initialised outside it (assertValidTargetProjectPath). */
  readonly workdirBase: string;
  readonly logger: Logger;
}

/**
 * The tentative merge could not be undone: the reset to HEAD failed, or left a merge staged. The
 * target checkout holds residue no later merge may be built on. The next finalize on the checkout
 * restores it first and refuses to merge while it cannot (finalizeHeld).
 */
class TargetCheckoutUnrestored extends Error {
  constructor(
    readonly taskId: string,
    readonly targetPath: string,
    /** What the merge was being undone after. */
    readonly after: string,
    /** Why the checkout is not back at HEAD with nothing staged. */
    readonly restoreDetail: string,
  ) {
    super(`task ${taskId}: the tentative merge in ${targetPath} could not be undone after ${after}: ${restoreDetail}; no merge runs on this checkout until it is restored`);
    this.name = "TargetCheckoutUnrestored";
  }
}

/** Tracked files of the target checkout changed outside the staged merge, before its commit. */
class TargetCheckoutDirty extends Error {
  constructor(
    readonly taskId: string,
    readonly targetPath: string,
    readonly files: readonly string[],
  ) {
    super(`task ${taskId}: ${files.length} tracked file(s) of ${targetPath} changed outside the merge: ${files.slice(0, 20).join(", ")}`);
    this.name = "TargetCheckoutDirty";
  }
}

/**
 * Why the checkout is not back at HEAD on main with no merge staged, or null when it is. HEAD is
 * put back on main only when `head` did not already read it there: a tentative merge never moves
 * HEAD off the branch it was made on, so its undo passes "on-main".
 */
async function unrestoredReason(targetProjectPath: string, head: HeadReading): Promise<string | null> {
  const reset = await resetCheckoutToHead(targetProjectPath);
  if (reset.status === "error") return reset.message;
  try {
    if (await mergeInProgress(targetRepo(targetProjectPath))) return "a merge is still staged (MERGE_HEAD) after the reset to HEAD";
  } catch (e) {
    return `whether a merge is still staged could not be read: ${describeErrorChain(e)}`;
  }
  return head === "on-main" ? null : headOnMainReason(targetProjectPath);
}

/**
 * Undoes the tentative merge. The checkout was at HEAD with nothing staged when the merge began
 * (finalizeHeld restores it first), so the undo is the same restore: a reset to HEAD, which drops
 * the staged merge, its unmerged paths and MERGE_HEAD, and whatever the post-merge check left in the
 * tracked files, then a clean. When the checkout is still not at HEAD with nothing staged, the
 * failure is logged at warn with its cause and returned typed for the caller to block on, never
 * swallowed: a merge verdict built on top of the residue would be untrustworthy (Discipline A).
 */
async function undoTentativeMerge(
  logger: Logger,
  taskId: string,
  targetProjectPath: string,
  after: string,
): Promise<VerificationInfrastructureFault | null> {
  const reason = await unrestoredReason(targetProjectPath, "on-main");
  if (reason === null) return null;
  const unrestored = new TargetCheckoutUnrestored(taskId, targetProjectPath, after, reason);
  logger.error("quality.checkout-unrestored", unrestored.message, { taskId, targetPath: targetProjectPath, after }, unrestored);
  return new VerificationInfrastructureFault(taskId, `restoring the target checkout after ${after}`, { cause: unrestored });
}

/** The merge's own failure, unless undoing it failed: then the checkout is the operator's first, whatever the gate said. */
function unrestoredFailure(
  fault: VerificationInfrastructureFault,
  failedStep: "merge" | "verification",
  gateFailureContext: string,
  // open-by-design: gateContext carries caller-supplied diagnostic context per gate type
  gate: { operation: string; gateOutput: unknown; gateContext?: Record<string, unknown> },
): FinalizeResult {
  return {
    success: false,
    failedStep,
    gateFailureContext: `${gateFailureContext}\n${fault.message}`,
    errorLayer: wrapError("development", POST_MERGE_CHECK_RUN, fault, {
      ...gate.gateContext,
      gateOperation: gate.operation,
      gateOutput: wrapError("development", gate.operation, gate.gateOutput),
    }),
    fault: { class: "ashara", error: fault },
  };
}

async function abortAndFail(
  logger: Logger,
  taskId: string,
  targetProjectPath: string,
  failedLogMessage: string,
  gateFailureContext: string,
  // open-by-design: gateContext carries caller-supplied diagnostic context per gate type
  errorLayerInfo: { operation: string; gateOutput: string | Error; gateContext?: Record<string, unknown> },
  fault: FinalizeFault,
): Promise<FinalizeResult> {
  logger.info("quality.merge-aborted", failedLogMessage, { taskId, operation: errorLayerInfo.operation });

  const unrestored = await undoTentativeMerge(logger, taskId, targetProjectPath, errorLayerInfo.operation);
  if (unrestored !== null) return unrestoredFailure(unrestored, "verification", gateFailureContext, errorLayerInfo);
  logger.info("quality.merge-undone", "tentative merge undone by a reset to HEAD — main restored, task branch preserved for retry", { taskId });

  const errorLayer = wrapError("development", errorLayerInfo.operation, errorLayerInfo.gateOutput, errorLayerInfo.gateContext);

  return { success: false, failedStep: "verification", gateFailureContext, errorLayer, fault };
}

/**
 * Merges the task branch, which the caller has already committed the agent's work to (a commit
 * that failed ended the dispatch before this point), and checks the merge. One finalize at a time
 * per target: from the orphan recovery through the commit or the abort, the
 * checkout's lock is held, so a batch's other task neither aborts this one's tentative merge nor
 * merges against a main this one is about to move; it waits and merges against the main it lands on.
 */
export async function finalizeSuccess(
  deps: FinalizeDeps,
  task: DispatchRef,
  targetProjectPath: string,
  attempt: number,
): Promise<FinalizeResult> {
  const holder = `finalize of task ${task.id} attempt ${attempt}`;
  try {
    return await withTargetCheckout(targetProjectPath, holder, (lease) => finalizeHeld(deps, task, targetProjectPath, attempt, lease));
  } catch (e) {
    if (!(e instanceof CheckoutHolderOverran) || e.waiter !== holder) throw e;
    // Nothing was merged and no check ran: the stuck holder is the operator's, never the task's failure.
    deps.logger.error("quality.checkout-holder-overran", e.message, { taskId: task.id, attempt, holder: e.holder }, e);
    const fault = new VerificationInfrastructureFault(task.id, "waiting for the target checkout", { cause: e });
    return {
      success: false,
      failedStep: "merge",
      gateFailureContext: fault.message,
      errorLayer: wrapError("development", POST_MERGE_CHECK_RUN, fault, { taskId: task.id, attempt, holder: e.holder, boundMs: e.boundMs, heldMs: e.heldMs }),
      fault: { class: "ashara", error: fault },
    };
  }
}

/** What a conflicted merge tells the task's next attempt: facts only; its brief carries the conflict it is handed. */
function conflictContext(taskId: string, files: readonly string[], presented: MainConflict | null): string {
  const listed = files.map((file) => `- ${file}`).join("\n");
  const head =
    presented === null
      ? `The merge of task ${taskId}'s branch into main conflicted; main was not changed. Conflicting files:`
      : `The merge of task ${taskId}'s branch into main conflicted again after main was merged into it and its conflicts ` +
        `resolved: main moved on since. Main was not changed. Conflicting files:`;
  return `${head}\n${listed}`;
}

async function finalizeHeld(
  deps: FinalizeDeps,
  task: DispatchRef,
  targetProjectPath: string,
  attempt: number,
  lease: CheckoutLease,
): Promise<FinalizeResult> {
  const head = await recoverOrphanedMerge(targetProjectPath, deps.logger);
  await ensureTargetGitInit(targetProjectPath, deps.workdirBase);

  // Ordered after ensureTargetGitInit so HEAD is guaranteed to exist, and before the tentative merge.
  // This is also where a checkout an earlier finalize could not restore (TargetCheckoutUnrestored)
  // stays blocked: every finalize restores it first, and none merges until that succeeds.
  const unrestored = await unrestoredReason(targetProjectPath, head);
  if (unrestored !== null) {
    // Fail closed: an unrestorable checkout makes every merge verdict below
    // untrustworthy, so refuse rather than merge onto unknown residue. Nothing is known of the
    // task's work, so it is blocked for the operator, never failed against the task.
    const fault = new VerificationInfrastructureFault(task.id, "restoring the target checkout to HEAD before the merge", { cause: unrestored });
    deps.logger.error("quality.checkout-unrestored", `target checkout could not be restored — refusing to merge: ${unrestored}`, {
      taskId: task.id,
      attempt,
      targetPath: targetProjectPath,
    });
    return {
      success: false,
      failedStep: "merge",
      gateFailureContext: `Target checkout could not be restored to HEAD before merge: ${unrestored}`,
      errorLayer: wrapError("development", POST_MERGE_CHECK_RUN, fault, {
        taskId: task.id,
        attempt,
        step: "resetCheckoutToHead",
      }),
      fault: { class: "ashara", error: fault },
    };
  }

  const mergeResult = await tentativeMerge(targetProjectPath, taskBranchName(task.id), deps.logger);

  if (mergeResult.status === "conflict") {
    // Handed a conflict with main and still conflicting: main moved again under the resolution.
    const operation = deps.presentedConflict === null ? "tentativeMerge" : "tentativeMergeAfterConflict";
    const mergeContext = conflictContext(task.id, mergeResult.files, deps.presentedConflict);
    const gateContext = { taskId: task.id, attempt, conflictFiles: mergeResult.files };
    const unrestored = await undoTentativeMerge(deps.logger, task.id, targetProjectPath, "a merge conflict");
    if (unrestored !== null) {
      return unrestoredFailure(unrestored, "merge", mergeContext, { operation, gateOutput: "merge conflict", gateContext });
    }
    deps.logger.info("quality.merge-conflict", "tentative merge CONFLICT — undone by a reset to HEAD, branch preserved for retry", {
      taskId: task.id,
      attempt,
      conflictFiles: mergeResult.files,
    });
    return {
      success: false,
      failedStep: "merge",
      gateFailureContext: mergeContext,
      errorLayer: wrapError("development", operation, "merge conflict", gateContext),
      fault: { class: "agent_work", verdict: MERGE_CONFLICTED },
    };
  }

  if (mergeResult.status === "error") {
    // Not a conflict: git on the host refused the merge (an index lock, residue, Z0's own git). The
    // branch was never weighed against main, so this is Ashara's fault, never the task's.
    const fault = new VerificationInfrastructureFault(task.id, "tentative merge of the task branch into main", { cause: mergeResult.cause });
    const gateContext = { taskId: task.id, attempt, errorClass: fault.name, step: fault.step };
    const unrestored = await undoTentativeMerge(deps.logger, task.id, targetProjectPath, "a failed tentative merge");
    if (unrestored !== null) {
      return unrestoredFailure(unrestored, "merge", `Tentative merge failed: ${mergeResult.message}`, {
        operation: POST_MERGE_CHECK_RUN,
        gateOutput: fault,
        gateContext,
      });
    }
    deps.logger.error("quality.tentative-merge-failed", "tentative merge FAILED without a conflict — undone by a reset to HEAD", { taskId: task.id, attempt }, fault);
    return {
      success: false,
      failedStep: "merge",
      gateFailureContext: `Tentative merge failed: ${mergeResult.message}`,
      errorLayer: wrapError("development", POST_MERGE_CHECK_RUN, fault, gateContext),
      fault: { class: "ashara", error: fault },
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
        deps.logger,
        task.id,
        targetProjectPath,
        `post-merge verification could not run, the verifier cell's environment failed (${environmentFailure.name}) — aborting tentative merge`,
        `Post-merge verify could not run: ${detail}`,
        // The typed error itself is the cause, its class and fields intact, never a flattened string.
        { operation: "postMergeVerify", gateOutput: environmentFailure, gateContext: { taskId: task.id, attempt, errorClass: environmentFailure.name } },
        { class: "substrate", error: environmentFailure },
      );
    }
    const fault = e instanceof VerificationInfrastructureFault ? e : new VerificationInfrastructureFault(task.id, "post-merge verification", { cause: e });
    return abortAndFail(
      deps.logger,
      task.id,
      targetProjectPath,
      `post-merge verification could not run, Z0's verification machinery failed (${fault.step}) — aborting tentative merge`,
      `Post-merge verify could not run: ${fault.message}`,
      { operation: POST_MERGE_CHECK_RUN, gateOutput: fault, gateContext: { taskId: task.id, attempt, errorClass: fault.name, step: fault.step } },
      { class: "ashara", error: fault },
    );
  }

  if (!postMergeVerify.passed) {
    return abortAndFail(
      deps.logger,
      task.id,
      targetProjectPath,
      "post-merge verification FAILED — aborting tentative merge",
      `Post-merge verify failed:\n${postMergeVerify.details}`,
      {
        operation: deps.postMergeOperation,
        gateOutput: postMergeVerify.details,
        gateContext: { taskId: task.id, attempt },
      },
      { class: "agent_work", verdict: postMergeVerdict(deps.postMergeOperation) },
    );
  }

  // Dirty-tree check: the merge must be the only change in the target checkout before it is
  // committed. Every check runs on a throwaway checkout of the merge (task-checks.ts,
  // environment-check.ts), so a tracked file changed here is residue of Z0's own machinery, and a
  // git diff that cannot run is Z0's git: either way Ashara's fault, never the implementer's.
  let dirtyFiles: string[];
  try {
    dirtyFiles = await detectDirtyTrackedFiles(targetProjectPath);
  } catch (e) {
    const fault = new VerificationInfrastructureFault(task.id, "dirty-tree check of the target checkout (git diff)", { cause: e });
    return abortAndFail(
      deps.logger,
      task.id,
      targetProjectPath,
      "post-merge dirty-tree check could not run, git diff failed — aborting tentative merge",
      `Could not run git diff to verify clean working tree: ${fault.message}`,
      { operation: POST_MERGE_CHECK_RUN, gateOutput: fault, gateContext: { taskId: task.id, attempt, errorClass: fault.name, step: fault.step } },
      { class: "ashara", error: fault },
    );
  }
  if (dirtyFiles.length > 0) {
    const fileList = dirtyFiles.slice(0, 20).join(", ");
    const fault = new VerificationInfrastructureFault(task.id, "dirty-tree check of the target checkout", {
      cause: new TargetCheckoutDirty(task.id, targetProjectPath, dirtyFiles),
    });
    return abortAndFail(
      deps.logger,
      task.id,
      targetProjectPath,
      "post-merge dirty-tree check FAILED — tracked files changed outside the merge — aborting tentative merge",
      `${dirtyFiles.length} tracked file(s) of the target checkout changed outside the merge: ${fileList}`,
      { operation: POST_MERGE_CHECK_RUN, gateOutput: fault, gateContext: { taskId: task.id, attempt, errorClass: fault.name, step: fault.step, dirtyFiles } },
      { class: "ashara", error: fault },
    );
  }

  const mergeCommit = await commitMerge(targetProjectPath, task.id);
  deps.logger.info("quality.merge-committed", `merge committed to main as ${mergeCommit}`, { taskId: task.id, attempt, mergeCommit });

  // The dev_sessions terminal write is not made here: it lives in the dispatch's
  // withSessionLifecycle, the one seam every outcome passes through, so no return path
  // can leave a session without one.
  return { success: true, mergeCommit };
}

/**
 * `git diff --name-only` against the index: tracked files changed outside the staged merge. Ignored
 * paths are invisible to it. Rejects when git cannot answer (fail-closed): a dirty-tree check that
 * cannot run never passes.
 */
async function detectDirtyTrackedFiles(targetProjectPath: string): Promise<string[]> {
  const { stdout } = await runHostGit(targetRepo(targetProjectPath), ["diff", "--name-only"]);
  return stdout
    .trim()
    .split("\n")
    .filter((line) => line.length > 0);
}
