import type { EnvironmentTestRun } from "@ashara/execution-infra";
import type { Logger } from "@ashara/shared";
import { wrapError } from "@ashara/shared";
import { NO_AGENT, mainRunBlocked } from "../dispatch-result.js";
import type { CheckAuthoring, ExecutionEventSink, ExecutionResult, VerifiedDispatch } from "../dispatch-result.js";
import { runFoundationBuild } from "../environment-check.js";
import { environmentBuildPassed } from "../environment-verdict.js";
import { FoundationUnbuildable, describeFoundationBuild, discardCheckWorkdir } from "../task-checks.js";
import { RED_RUN_ROLE } from "./dispatch-cells.js";
import type { DispatchCells } from "./dispatch-cells.js";

export interface FoundationGateDeps {
  readonly dispatchCells: Pick<DispatchCells, "environmentScope">;
  readonly attemptPolicy: { readonly perCommandTimeoutSeconds: number };
  readonly eventSink?: ExecutionEventSink;
  readonly logger: Logger;
}

/** The gate before a check author's model is called: the plan's foundation builds in the dispatch's environment. */
export class FoundationGate {
  private readonly deps: FoundationGateDeps;

  constructor(deps: FoundationGateDeps) {
    this.deps = deps;
  }

  /**
   * Before a check author's model is called: the environment's `build` from this dispatch's
   * image on a fresh checkout of the plan's foundation, as the merge gate builds before it runs
   * anything. Passing: null, and every red run of the attempt (define_check's and the one at
   * finish) is on a foundation that builds, so a check failing there fails for its own reason. Failing:
   * the red run is unrunnable, never accepted. A re-dispatch would meet the same foundation in the
   * same environment, so the task is not failed: it ends `environment_undefined`, which gives it up
   * for a plan repair with the build as evidence. A build that could not run at all is environment-blocked.
   */
  async foundationBuildGate(d: VerifiedDispatch, work: CheckAuthoring): Promise<ExecutionResult | null> {
    const { eventSink } = this.deps;
    const { task, sessionId, targetProjectPath } = d;
    let build: EnvironmentTestRun;
    try {
      build = await runFoundationBuild(this.deps.dispatchCells.environmentScope(d), {
        role: RED_RUN_ROLE,
        imageRef: work.environment.imageId,
        commit: work.foundation.commit,
        definition: work.environment.definition,
        timeoutSeconds: this.deps.attemptPolicy.perCommandTimeoutSeconds,
      });
    } catch (e) {
      await discardCheckWorkdir(d.workDir, targetProjectPath, work.branch, this.deps.logger);
      return mainRunBlocked({ task, sessionId, error: e, agent: NO_AGENT, eventSink, logger: this.deps.logger, stage: "checkRedRun", step: "build on the foundation" });
    }
    const passed = environmentBuildPassed(build);
    eventSink?.emit({
      event: "foundation_build",
      taskId: task.id,
      attempt: task.attempt,
      foundationTaskId: work.foundation.taskId,
      baselineCommit: work.foundation.commit,
      environmentVersion: work.environment.version,
      exitCode: build.exitCode,
      timedOut: build.timedOut,
      passed,
      ...(passed ? {} : { build: describeFoundationBuild(build) }),
    });
    if (passed) return null;

    await discardCheckWorkdir(d.workDir, targetProjectPath, work.branch, this.deps.logger);
    const unbuildable = new FoundationUnbuildable(task.id, work.foundation.taskId, work.environment.version, build);
    const summary = `no check of task ${task.id} can be red-run: ${unbuildable.message}; no agent ran`;
    this.deps.logger.info("quality.foundation-unbuildable", summary, { taskId: task.id, attempt: task.attempt, foundationTaskId: work.foundation.taskId });
    eventSink?.emit({ event: "task_blocked", taskId: task.id, attempt: task.attempt, stage: "foundationBuild", errorClass: unbuildable.name, reason: summary });
    return {
      status: "environment_undefined",
      reason: unbuildable.message,
      detail: summary,
      outcome: null,
      sessionId,
      attempt: task.attempt,
      errorEnvelope: {
        outcome: "blocked",
        summary,
        chain: wrapError("development", "foundationBuild", unbuildable, {
          taskId: task.id,
          foundationTaskId: work.foundation.taskId,
          environmentVersion: work.environment.version,
          exitCode: build.exitCode,
          timedOut: build.timedOut,
        }),
      },
    };
  }
}
