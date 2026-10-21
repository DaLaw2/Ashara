import type { EnvironmentTestRun } from "@ashara/execution-infra";
import { cleanupWorkdir } from "@ashara/execution-infra";
import type { Logger } from "@ashara/shared";
import { wrapError } from "@ashara/shared";
import { describeProductChange, formatCheckRuns } from "../check-verdict.js";
import type { CheckRunReport } from "../check-verdict.js";
import { NO_AGENT, cellImageOf, mainRunBlocked, sessionEnvironmentVersion } from "../dispatch-result.js";
import type { ExecutionEventSink, ExecutionResult, VerifiedDispatch } from "../dispatch-result.js";
import { runFoundationBuild } from "../environment-check.js";
import { environmentBuildPassed } from "../environment-verdict.js";
import { StoredChecksStale, describeFoundationBuild, redRunProblem, redRunSetProblem, redRunVerdict, runChecksOnCheckout } from "../task-checks.js";
import type { TaskChecks } from "../task-checks.js";
import { RED_RUN_ROLE } from "./dispatch-cells.js";
import type { DispatchCells } from "./dispatch-cells.js";

export interface BaselineRevalidationDeps {
  readonly dispatchCells: Pick<DispatchCells, "environmentScope" | "checkCells" | "checkoutDir">;
  readonly attemptPolicy: { readonly perCommandTimeoutSeconds: number };
  readonly eventSink?: ExecutionEventSink;
  readonly logger: Logger;
}

/** Whether a task's stored checks, red-run in another environment version, still tell its work from its absence in this one. */
export class BaselineRevalidation {
  private readonly deps: BaselineRevalidationDeps;

  constructor(deps: BaselineRevalidationDeps) {
    this.deps = deps;
  }

  /**
   * Stored checks were red-run on their baseline in their check task's environment version. On a
   * dispatch from another version they are red-run again on that baseline in a CI cell from this
   * dispatch's image, by the same set rule: every check runs to a verdict
   * and at least one fails decisively. Holding: trusted, null. Not holding, or no baseline on record
   * (a revision stored before baselines were recorded): checks_stale before the model is called, naming both
   * versions and the check task, since such a set cannot tell the task's work from its absence and
   * the implementer could not answer for it. A red run that could not run at all is environment-blocked.
   */
  async revalidateOnBaseline(d: VerifiedDispatch, stored: TaskChecks): Promise<ExecutionResult | null> {
    const { eventSink, dispatchCells } = this.deps;
    const { task, sessionId, workDir, targetProjectPath } = d;
    const current = sessionEnvironmentVersion(d.environment);
    if (current === stored.environmentVersion) return null;

    let problem: string | null;
    if (stored.baselineCommit === null) {
      problem = `revision ${stored.revision} records no baseline commit (it was stored before baselines were recorded), so it cannot be red-run again`;
    } else {
      // As at authoring: on a baseline the environment no longer builds, every check fails
      // for that reason alone, which is no evidence the set still tells the task's work from its absence.
      // The BaseCell (Sprint 0's cells only) defines no build: its run is the red run alone, as before.
      let build: EnvironmentTestRun | null = null;
      if (d.environment.kind === "environment") {
        try {
          build = await runFoundationBuild(
            dispatchCells.environmentScope(d),
            RED_RUN_ROLE,
            d.environment.imageId,
            stored.baselineCommit,
            d.environment.definition,
            this.deps.attemptPolicy.perCommandTimeoutSeconds,
          );
        } catch (e) {
          await cleanupWorkdir(workDir, targetProjectPath);
          return mainRunBlocked(task, sessionId, e, NO_AGENT, eventSink, this.deps.logger, "checkRedRun", "build on the baseline");
        }
      }
      let redRun: CheckRunReport | { readonly kind: "unbuilt"; readonly build: EnvironmentTestRun };
      if (build !== null && !environmentBuildPassed(build)) {
        redRun = { kind: "unbuilt", build };
      } else {
        try {
          redRun = await runChecksOnCheckout(
            dispatchCells.checkCells(d),
            RED_RUN_ROLE,
            cellImageOf(d.environment),
            stored.baselineCommit,
            dispatchCells.checkoutDir(d, "red-run"),
            stored.checks,
            stored.files,
          );
        } catch (e) {
          await cleanupWorkdir(workDir, targetProjectPath);
          return mainRunBlocked(task, sessionId, e, NO_AGENT, eventSink, this.deps.logger, "checkRedRun", "red run on the baseline");
        }
      }
      if (redRun.kind === "unbuilt") {
        problem = `the environment's build fails on the baseline, so no check there can be red-run: ${describeFoundationBuild(redRun.build)}`;
      } else if (redRun.kind === "files_refused") {
        problem = `the check files cannot be placed on the baseline: ${redRun.detail}`;
      } else if (redRun.kind === "product_changed") {
        problem = `on the baseline, ${describeProductChange(redRun)}`;
      } else {
        const setProblem = redRunSetProblem(redRun.runs);
        problem =
          redRun.runs.some((run) => redRunProblem(run) !== null) || setProblem !== null
            ? `${formatCheckRuns(redRun.runs, redRunVerdict)}${setProblem === null ? "" : `\nREJECTED, the set: ${setProblem}`}`
            : null;
      }
    }
    eventSink?.emit({
      event: "checks_revalidated",
      taskId: task.id,
      attempt: task.attempt,
      revision: stored.revision,
      storedVersion: stored.environmentVersion,
      currentVersion: current,
      baselineCommit: stored.baselineCommit,
      trusted: problem === null,
    });
    if (problem === null) return null;

    await cleanupWorkdir(workDir, targetProjectPath);
    const stale = new StoredChecksStale(task.id, stored, current, problem);
    this.deps.logger.info("quality.checks-stale", stale.message, { taskId: task.id, attempt: task.attempt });
    eventSink?.emit({ event: "task_blocked", taskId: task.id, attempt: task.attempt, stage: "revalidateTaskChecks", errorClass: stale.name, reason: stale.message });
    return {
      status: "checks_stale",
      checkTaskId: stored.checkTaskId,
      revision: stored.revision,
      detail: stale.message,
      outcome: null,
      sessionId,
      attempt: task.attempt,
      errorEnvelope: {
        outcome: "blocked",
        summary: stale.message,
        chain: wrapError("development", "revalidateTaskChecks", stale, {
          taskId: task.id,
          checkTaskId: stored.checkTaskId,
          revision: stored.revision,
          storedVersion: stored.environmentVersion,
          currentVersion: current,
          baselineCommit: stored.baselineCommit,
        }),
      },
    };
  }
}
