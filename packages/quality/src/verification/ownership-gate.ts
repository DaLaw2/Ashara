import { cleanupWorkdir, recipePaths } from "@ashara/execution-infra";
import type { Logger } from "@ashara/shared";
import { wrapError } from "@ashara/shared";
import { attemptSummary, outcomeRecord } from "@ashara/workplace";
import type { Outcome } from "@ashara/workplace";
import { PostMergeEnvironmentMissing, asharaBlocked, substrateBlocked } from "../dispatch-result.js";
import type { ExecutionEventSink, ExecutionResult, VerifiedDispatch } from "../dispatch-result.js";
import { environmentErrorOf, VerificationInfrastructureFault } from "../fault-class.js";
import { checkBranchOwnership } from "../gates/ownership.js";
import { discardTaskBranch, taskBranchName } from "../merge.js";
import type { TaskCheckStore } from "../task-checks.js";
import { WORK_FAILED } from "../task-verdict.js";

export interface OwnershipGateDeps {
  readonly checks: Pick<TaskCheckStore, "checkFilesOf">;
  readonly eventSink?: ExecutionEventSink;
  readonly logger: Logger;
}

/** The merge gate of separation of duties: an implementer's branch touches neither the environment's recipe nor a stored check. */
export class OwnershipGate {
  private readonly deps: OwnershipGateDeps;

  constructor(deps: OwnershipGateDeps) {
    this.deps = deps;
  }

  /**
   * Separation of duties, before
   * the tentative merge: the task branch's changes since it left main may not touch the recipe of
   * main's environment (the platform role's) nor any stored check file of the project (the check
   * author's). Every other file is the product's, inputs the image build reads included: the
   * post-merge verification rebuilds the image when one changes. Only recipe files:
   * environment_change_requested with the implementer's need and the diff of those files; the task branch is deleted so the next dispatch starts fresh from main. Any check
   * file: failed with the paths and the rule, the branch kept. Nothing is merged either way. Z0's
   * own git failing blocks for the operator. Null when clean.
   */
  async ownershipGate(d: VerifiedDispatch, outcome: Outcome): Promise<ExecutionResult | null> {
    const { eventSink } = this.deps;
    const { task, workDir, targetProjectPath, sessionId } = d;
    const blockOn = (e: unknown, step: string): ExecutionResult => {
      const environmentFailure = environmentErrorOf(e);
      if (environmentFailure !== null) {
        return substrateBlocked(task, sessionId, "ownershipGate", environmentFailure, "host git", { outcome, agentWork: "kept" }, eventSink, this.deps.logger);
      }
      const fault = new VerificationInfrastructureFault(task.id, step, { cause: e });
      const chain = wrapError("development", "ownershipGate", fault, { taskId: task.id, errorClass: fault.name });
      return asharaBlocked(task, sessionId, "ownershipGate", fault, { outcome, agentWork: "kept" }, eventSink, this.deps.logger, chain);
    };
    let verdict: Awaited<ReturnType<typeof checkBranchOwnership>>;
    try {
      // Fail closed: a task dispatched without an environment has no recipe to fence and no
      // rebuild to accept an input change against.
      if (d.environment.kind !== "environment") throw new PostMergeEnvironmentMissing(task.id);
      const checkFiles = await this.deps.checks.checkFilesOf(task.projectId);
      verdict = await checkBranchOwnership(targetProjectPath, task.id, taskBranchName(task.id), recipePaths(d.environment.definition), checkFiles);
    } catch (e) {
      await cleanupWorkdir(workDir, targetProjectPath);
      return blockOn(e, "ownership gate");
    }
    eventSink?.emit({ event: "ownership_gate", taskId: task.id, attempt: task.attempt, verdict: verdict.kind });
    if (verdict.kind === "clean") return null;

    await cleanupWorkdir(workDir, targetProjectPath);
    const summary = `ownership gate refused the work of ${task.id}: ${verdict.reason}`;
    if (verdict.kind === "environment_change") {
      // The branch holds work made on the environment that is about to change: the next dispatch
      // starts again from main, which then carries the environment task's change.
      try {
        await discardTaskBranch(targetProjectPath, task.id);
      } catch (e) {
        return blockOn(e, "discard the task branch for an environment change");
      }
      const need = attemptSummary(outcome).trim() === "" ? "(the implementer's finish summary is empty: it stated no need)" : attemptSummary(outcome);
      const chain = wrapError("development", "ownershipGate", verdict.reason, { taskId: task.id, environmentPaths: verdict.paths });
      this.deps.logger.info("quality.environment-change-requested", summary, { taskId: task.id, attempt: task.attempt, paths: verdict.paths });
      eventSink?.emit({ event: "environment_change_requested", taskId: task.id, attempt: task.attempt, paths: verdict.paths, reason: summary });
      return {
        status: "environment_change_requested",
        paths: verdict.paths,
        need,
        diff: verdict.diff,
        detail: summary,
        outcome,
        sessionId,
        attempt: task.attempt,
        errorEnvelope: { outcome: "blocked", summary, chain, agentOutput: outcomeRecord(outcome) },
      };
    }
    const chain = wrapError("development", "ownershipGate", verdict.reason, {
      taskId: task.id,
      checkPaths: verdict.checkPaths,
      recipePaths: verdict.recipePaths,
    });
    eventSink?.emit({ event: "gate_failed", taskId: task.id, attempt: task.attempt, reason: summary });
    return {
      status: "failed",
      verdict: WORK_FAILED,
      detail: summary,
      outcome,
      sessionId,
      attempt: task.attempt,
      errorEnvelope: { outcome: "failed", summary, chain, agentOutput: outcomeRecord(outcome) },
    };
  }
}
