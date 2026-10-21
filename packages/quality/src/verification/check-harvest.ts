import { buildContextPaths } from "@ashara/execution-infra";
import type { Logger } from "@ashara/shared";
import { wrapError } from "@ashara/shared";
import { outcomeRecord } from "@ashara/workplace";
import type { Outcome } from "@ashara/workplace";
import { describeProductChange, formatCheckRuns } from "../check-verdict.js";
import type { CheckRunReport } from "../check-verdict.js";
import { mainRunBlocked } from "../dispatch-result.js";
import type { CheckAuthoring, ExecutionEventSink, ExecutionResult, VerifiedDispatch } from "../dispatch-result.js";
import { checkAreaOf, discardCheckWorkdir, harvestCheckFiles, redRunProblem, redRunSetProblem, redRunVerdict, runChecksOnCheckout } from "../task-checks.js";
import type { TaskCheckStore } from "../task-checks.js";
import { WORK_FAILED } from "../task-verdict.js";
import { RED_RUN_ROLE } from "./dispatch-cells.js";
import type { DispatchCells } from "./dispatch-cells.js";

export interface CheckHarvestDeps {
  readonly dispatchCells: Pick<DispatchCells, "checkCells" | "checkoutDir">;
  readonly checks: Pick<TaskCheckStore, "append">;
  readonly eventSink?: ExecutionEventSink;
  readonly logger: Logger;
}

/** A finished check attempt's harvest: its checks kept as a stored revision only once their red run on the foundation holds. */
export class CheckHarvest {
  private readonly deps: CheckHarvestDeps;

  constructor(deps: CheckHarvestDeps) {
    this.deps = deps;
  }

  /** A check task's work that cannot be kept: failed with the reason, nothing stored, nothing merged. */
  private checksRejected(
    d: VerifiedDispatch,
    outcome: Outcome,
    reason: string,
    // open-by-design: what the operator needs beyond the author's reason, per rejection
    operator: Record<string, unknown>,
  ): ExecutionResult {
    const { task, sessionId } = d;
    // The summary and the chain, its context included, become the next check attempt's brief
    // (formatPriorAttemptFailure renders the chain verbatim), so neither names a commit the cell
    // cannot reach; `operator`, the foundation's commit among it, goes only to the event.
    const summary = `the checks of check task ${task.id} were rejected: ${reason}`;
    this.deps.eventSink?.emit({ event: "task_failed", taskId: task.id, attempt: task.attempt, reason: summary, ...operator });
    const chain = wrapError("development", "keepChecks", reason, { taskId: task.id });
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

  /**
   * Harvests a finished check attempt: its defined checks and the files it added or changed, then
   * the red run on a fresh checkout of the plan's foundation in a CI cell from the environment
   * image, whatever authoring this is: the first, or one after a dispute,
   * a review or staleness. A check that times out or whose command cannot run rejects the whole
   * set; a check that passes there is kept as a guard of behaviour that already holds; the set is
   * kept only when at least one of its checks fails there decisively, and only when every vision item
   * the check task cites is decided by at least one of its checks. The kept revision is appended
   * to Quality's task_checks for the implementation task with the foundation as its baseline; the
   * throwaway branch is discarded either way.
   */
  async keepChecks(d: VerifiedDispatch, work: CheckAuthoring, outcome: Outcome): Promise<ExecutionResult> {
    const { eventSink, dispatchCells } = this.deps;
    const { task, sessionId, targetProjectPath } = d;
    const { foundation } = work;
    try {
      const defined = work.recorder.checks();
      if (defined.length === 0) return this.checksRejected(d, outcome, "no check was defined with define_check", {});
      // Which items are checked is what the stored checks decide, never what a line cites.
      const undecided = work.recorder.undecided();
      if (undecided.length > 0) {
        return this.checksRejected(
          d,
          outcome,
          `the task cites ${undecided.join(", ")}, which no check decides: every item the task cites needs a check ` +
            `that decides it, named in that check's "decides"`,
          { undecided },
        );
      }
      const harvest = await harvestCheckFiles(
        d.repo,
        task.id,
        work.startCommit,
        buildContextPaths(work.environment.definition),
        work.recorder.writtenFiles(),
        checkAreaOf(work.checkedTaskId),
        this.deps.logger,
      );
      if (harvest.kind === "rejected") return this.checksRejected(d, outcome, harvest.reason, {});
      if (harvest.discarded.length > 0) {
        eventSink?.emit({ event: "check_files_discarded", taskId: task.id, attempt: task.attempt, area: checkAreaOf(work.checkedTaskId), paths: harvest.discarded });
      }

      let redRun: CheckRunReport;
      try {
        redRun = await runChecksOnCheckout(
          dispatchCells.checkCells(d),
          RED_RUN_ROLE,
          work.environment.imageId,
          foundation.commit,
          dispatchCells.checkoutDir(d, "red-run"),
          defined,
          harvest.files,
        );
      } catch (e) {
        return mainRunBlocked(task, sessionId, e, { outcome, agentWork: "discarded" }, eventSink, this.deps.logger, "checkRedRun", "red run on the foundation");
      }
      const atFoundation = { baselineCommit: foundation.commit, foundationTaskId: foundation.taskId };
      if (redRun.kind === "files_refused") {
        return this.checksRejected(
          d,
          outcome,
          `the check files cannot be placed on the foundation (the merge of task ${foundation.taskId}): ${redRun.detail}`,
          atFoundation,
        );
      }
      if (redRun.kind === "product_changed") {
        return this.checksRejected(
          d,
          outcome,
          `red run on the foundation (the merge of task ${foundation.taskId}): ${describeProductChange(redRun)}`,
          atFoundation,
        );
      }
      const runsReport = formatCheckRuns(redRun.runs, redRunVerdict);
      const problems = redRun.runs.filter((run) => redRunProblem(run) !== null);
      const setProblem = redRunSetProblem(redRun.runs);
      const report = setProblem === null ? runsReport : `${runsReport}\nREJECTED, the set: ${setProblem}`;
      eventSink?.emit({
        event: "check_red_run",
        taskId: task.id,
        attempt: task.attempt,
        baselineCommit: foundation.commit,
        foundationTaskId: foundation.taskId,
        rejected: problems.map((run) => run.name),
        holdsAlready: redRun.runs.filter((run) => run.exitCode === 0 && redRunProblem(run) === null).map((run) => run.name),
        setRejected: setProblem !== null,
        report,
      });
      if (problems.length > 0 || setProblem !== null) {
        return this.checksRejected(d, outcome, `red run on the foundation (the merge of task ${foundation.taskId}):\n${report}`, atFoundation);
      }

      const revision = await this.deps.checks.append({
        projectId: task.projectId,
        taskId: work.checkedTaskId,
        checkTaskId: task.id,
        environmentVersion: work.environment.version,
        baselineCommit: foundation.commit,
        checks: defined,
        files: harvest.files,
      });
      eventSink?.emit({
        event: "task_checks_recorded",
        taskId: task.id,
        attempt: task.attempt,
        checkedTaskId: work.checkedTaskId,
        revision,
        baselineCommit: foundation.commit,
        checks: defined.map((check) => check.name),
        files: harvest.files.map((file) => file.path),
      });
      eventSink?.emit({ event: "task_completed", taskId: task.id, attempt: task.attempt, result: "completed" });
      return {
        status: "completed",
        delivered: { kind: "checks-recorded", revision },
        detail:
          `${defined.length} check(s) recorded as revision ${revision} for task ${work.checkedTaskId}, red-run on the ` +
          `foundation ${foundation.commit}`,
        outcome,
        sessionId,
        attempt: task.attempt,
      };
    } finally {
      await discardCheckWorkdir(d.workDir, targetProjectPath, work.branch, this.deps.logger);
    }
  }
}
