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
import { commitAllChanges, ensureTargetGitInit } from "../workspace.js";
import { checkEntryPointRewrite } from "./entry-point.js";

export interface FinalizeResult {
  readonly success: boolean;
  readonly gateFailureContext?: string;
  readonly errorLayer?: ErrorLayer;
}

export interface FinalizeContractInfo {
  readonly entryPointPath: string | null;
}

export interface FinalizeDeps {
  readonly eventSink?: ExecutionEventSink;
}

async function abortAndFail(
  taskId: string,
  targetProjectPath: string,
  failedLogMessage: string,
  gateFailureContext: string,
  extra: Partial<FinalizeResult> = {},
  // open-by-design: gateContext carries caller-supplied diagnostic context per gate type
  errorLayerInfo?: { operation: string; gateOutput: string; gateContext?: Record<string, unknown> },
): Promise<FinalizeResult> {
  console.log(`[${taskId}] ${failedLogMessage}`);

  let abortError: ErrorLayer | undefined;
  try {
    await abortMerge(targetProjectPath);
  } catch (e) {
    abortError = wrapError("development", "abortMerge", e, { taskId });
  }
  console.log(`[${taskId}] tentative merge aborted — main restored, task branch preserved for retry`);

  const errorLayer = errorLayerInfo
    ? wrapError("development", errorLayerInfo.operation, errorLayerInfo.gateOutput, {
        ...errorLayerInfo.gateContext,
        ...(abortError ? { abortError } : {}),
      })
    : undefined;

  return { success: false, gateFailureContext, errorLayer, ...extra };
}

export async function finalizeSuccess(
  deps: FinalizeDeps,
  workDir: string,
  task: TaskDescriptor,
  targetProjectPath: string | null,
  attempt: number,
  taskChecks: readonly string[],
  contractChecks: readonly string[],
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

    const postMergeVerify = await runVerifyCore(
      {
        workDir: targetProjectPath,
        gitRoot: targetProjectPath,
        checks: [...taskChecks],
        contractChecks,
      },
      {
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
        {},
        {
          operation: "postMergeVerify",
          gateOutput: postMergeVerify.tiers.deterministic.details,
          gateContext: { taskId: task.id, attempt, checks: [...taskChecks] },
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
        {},
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
