import type { ErrorLayer } from "@ashara/shared";
import { wrapError } from "@ashara/shared";
import type { ExecutionEventSink, SessionStore, TaskDescriptor } from "../execution-service.js";
import {
  abortMerge,
  buildMergeAgentBrief,
  captureMainHead,
  commitMerge,
  recoverOrphanedMerge,
  taskBranchName,
  tentativeMerge,
} from "../merge.js";
import { runVerifyCore } from "../verify-core.js";
import { commitAllChanges, ensureTargetGitInit } from "../workspace.js";
import { checkEntryPointRewrite } from "./entry-point.js";
import { runIntegrationGate } from "./reachability.js";
import { detectHttpSurfaceChange, runSmokeTest } from "./smoke.js";
import type { GateResult } from "./types.js";

export interface FinalizeResult {
  readonly success: boolean;
  readonly integrationGate?: GateResult;
  readonly smokeTest?: GateResult;
  readonly gateFailureContext?: string;
  readonly errorLayer?: ErrorLayer;
}

export interface FinalizeContractInfo {
  readonly entryPointPath: string | null;
  readonly language: string | null;
  readonly excludePaths?: readonly string[];
}

export interface FinalizeDeps {
  readonly eventSink?: ExecutionEventSink;
  readonly sessionStore: SessionStore;
  readonly integrationGateRunner?: (targetPath: string) => Promise<GateResult>;
  readonly smokeTestRunner?: (targetPath: string) => Promise<GateResult>;
}

/**
 * Common failure path shared by every gate in `finalizeSuccess`: log why the
 * gate failed, abort the tentative merge (main is restored exactly — the
 * merge was never committed), and return the failure result. `extra` carries
 * whichever partial gate results (`integrationGate`/`smokeTest`) had already
 * run before this one failed.
 */
async function abortAndFail(
  taskId: string,
  targetProjectPath: string,
  failedLogMessage: string,
  gateFailureContext: string,
  extra: Partial<FinalizeResult> = {},
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
  sessionId: string,
  task: TaskDescriptor,
  targetProjectPath: string | null,
  attempt: number,
  taskChecks: readonly string[],
  contractInfo: FinalizeContractInfo = { entryPointPath: null, language: null },
): Promise<FinalizeResult> {
  try {
    await commitAllChanges(workDir, `ashara: agent output for task ${task.id}`);
  } catch {
    // nothing to commit
  }

  let integrationGate: GateResult | undefined;
  let smokeTest: GateResult | undefined;

  if (targetProjectPath) {
    await recoverOrphanedMerge(targetProjectPath);
    await ensureTargetGitInit(targetProjectPath);

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

    if (!postMergeVerify.passed) {
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

    if (deps.integrationGateRunner) {
      integrationGate = await deps.integrationGateRunner(targetProjectPath);
    } else {
      integrationGate = await runIntegrationGate(targetProjectPath, {
        contractEntryPoint: contractInfo.entryPointPath,
        contractLanguage: contractInfo.language,
        contractExcludePaths: contractInfo.excludePaths,
      });
    }
    deps.eventSink?.emit({
      event: "integration_gate",
      taskId: task.id,
      attempt,
      passed: integrationGate.passed,
      output: integrationGate.output.slice(0, 1000),
    });

    if (!integrationGate.passed) {
      return abortAndFail(
        task.id,
        targetProjectPath,
        "integration gate FAILED — aborting tentative merge",
        `Integration gate failed:\n${integrationGate.output}`,
        { integrationGate },
        {
          operation: "integrationGate",
          gateOutput: integrationGate.output,
          gateContext: { taskId: task.id, attempt, passed: integrationGate.passed },
        },
      );
    }

    const smokeTrigger = await detectHttpSurfaceChange(targetProjectPath, preMergeHead, contractInfo.entryPointPath);

    if (smokeTrigger !== null) {
      console.log(`[${task.id}] smoke test triggered: ${smokeTrigger}`);
      if (deps.smokeTestRunner) {
        smokeTest = await deps.smokeTestRunner(targetProjectPath);
      } else {
        smokeTest = await runSmokeTest(targetProjectPath, {}, contractInfo.entryPointPath);
      }
      deps.eventSink?.emit({
        event: "smoke_test",
        taskId: task.id,
        attempt,
        trigger: smokeTrigger,
        passed: smokeTest.passed,
        output: smokeTest.output.slice(0, 1000),
      });

      if (!smokeTest.passed) {
        return abortAndFail(
          task.id,
          targetProjectPath,
          "smoke test FAILED — aborting tentative merge",
          `Smoke test failed:\n${smokeTest.output}`,
          { integrationGate, smokeTest },
          {
            operation: "smokeTest",
            gateOutput: smokeTest.output,
            gateContext: { taskId: task.id, attempt, passed: smokeTest.passed },
          },
        );
      } else {
        console.log(`[${task.id}] smoke test passed`);
      }
    }

    await commitMerge(targetProjectPath, task.id);
    console.log(`[${task.id}] merge committed to main, task branch deleted`);
  }

  console.log(`[${task.id}] task completed — work dir preserved at: ${workDir}`);

  await deps.sessionStore.complete(sessionId);

  return { success: true, integrationGate, smokeTest };
}
