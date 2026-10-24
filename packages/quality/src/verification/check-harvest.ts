import { buildContextPaths } from "@ashara/execution-infra";
import type { Logger, WorkItemId } from "@ashara/shared";
import { parseWorkItemId, wrapError } from "@ashara/shared";
import { HELD_SET_RULE, outcomeRecord, unheldItems, unheldReason } from "@ashara/workplace";
import type { Outcome, UnheldEvidence } from "@ashara/workplace";
import { describeProductChange, formatCheckRuns } from "../check-verdict.js";
import type { CheckRunReport } from "../check-verdict.js";
import { mainRunBlocked } from "../dispatch-result.js";
import type { CheckAuthoring, ExecutionEventSink, ExecutionResult, VerifiedDispatch } from "../dispatch-result.js";
import { checkAreaOf, discardCheckWorkdir, harvestCheckFiles, redRunProblem, redRunSetLine, redRunSetVerdict, redRunVerdict, runChecksOnCheckout, setRejected } from "../task-checks.js";
import type { TaskCheckStore } from "../task-checks.js";
import { HELD_SET_GIVEN_UP, WORK_FAILED } from "../task-verdict.js";
import type { FailureVerdict } from "../task-verdict.js";
import { RED_RUN_ROLE } from "./dispatch-cells.js";
import type { DispatchCells } from "./dispatch-cells.js";

export interface CheckHarvestDeps {
  readonly dispatchCells: Pick<DispatchCells, "checkCells" | "checkoutDir">;
  readonly checks: Pick<TaskCheckStore, "append" | "holdEvidenceOf" | "recordSetRejection">;
  readonly eventSink?: ExecutionEventSink;
  readonly logger: Logger;
}

/** A set rejected while holding whole on its foundation: the checked task, why the set is unheld, and the rejection to report. */
interface UnheldRejection {
  readonly checkedTaskId: WorkItemId;
  readonly evidence: UnheldEvidence;
  readonly rejection: string;
  // open-by-design: what the operator needs beyond the author's reason, per rejection
  readonly operator: Record<string, unknown>;
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
    verdict: FailureVerdict = WORK_FAILED,
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
      verdict,
      detail: summary,
      outcome,
      sessionId,
      attempt: task.attempt,
      errorEnvelope: { outcome: "failed", summary, chain, agentOutput: outcomeRecord(outcome) },
    };
  }

  /**
   * A set holding whole on its foundation, rejected for `evidence`: recorded, and failed for another
   * attempt until the records hold as many identical rejections (same reason, same items) for the
   * checked task, or for a task an earlier plan wrote, as the held-set rule bounds; then the task
   * is given up (HELD_SET_GIVEN_UP): the rule's retry budget for that reason and those items is spent.
   */
  private async unheldRejected(d: VerifiedDispatch, outcome: Outcome, unheld: UnheldRejection): Promise<ExecutionResult> {
    const { checkedTaskId, evidence, rejection, operator } = unheld;
    const { task } = d;
    const identical = await this.deps.checks.recordSetRejection({
      projectId: task.projectId,
      checkedTaskId,
      checkTaskId: parseWorkItemId(task.id, "VerifiedDispatch.task.id"),
      attempt: task.attempt,
      evidence,
    });
    const context = { ...operator, unheld: evidence.kind, items: unheldItems(evidence), identical };
    if (identical < HELD_SET_RULE.giveUpAfter) return this.checksRejected(d, outcome, rejection, context);
    this.deps.logger.warn(
      "quality.held-set-given-up",
      `check task ${task.id}: the checks of task ${checkedTaskId} hold whole on the foundation and were rejected ${identical} ` +
        `time(s) for the same reason (${unheldReason(evidence)}); the check task is given up`,
      { taskId: task.id, attempt: task.attempt, checkedTaskId, unheld: evidence.kind, items: unheldItems(evidence), identical },
    );
    return this.checksRejected(
      d,
      outcome,
      `${rejection}\nThis is rejection ${identical} of a set for the same reason and items, the held-set rule's bound of ` +
        `${HELD_SET_RULE.giveUpAfter}: the task is given up, since every attempt the rule allows was handed this reason and none changed it.`,
      context,
      HELD_SET_GIVEN_UP,
    );
  }

  /**
   * Harvests a finished check attempt: its defined checks and the files it added or changed, then
   * the red run on a fresh checkout of the plan's foundation in a CI cell from the environment
   * image, whatever authoring this is: the first, or one after a dispute,
   * a review or staleness. A check that times out or whose command cannot run rejects the whole
   * set; a check that passes there is kept as a guard of behaviour that already holds; the set is
   * kept only when every vision item the check task cites is decided by at least one of its checks,
   * and when at least one of its checks fails there decisively or, every one passing there, the
   * records show what it decides held before the correction that put it in scope (redRunSetVerdict's
   * held arm): the checks then join that task's check set, and its delivered sweep closes it on main
   * before any implementer is dispatched. A set every check of which passes there without that
   * evidence is rejected for its typed reason (unheldRejected), and given up at the held-set rule's
   * bound of identical rejections. The kept revision is appended to Quality's task_checks for the
   * implementation task with the foundation as its baseline; the throwaway branch is discarded
   * either way.
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
      const harvest = await harvestCheckFiles({
        repo: d.repo,
        taskId: task.id,
        startCommit: work.startCommit,
        buildContext: buildContextPaths(work.environment.definition),
        written: work.recorder.writtenFiles(),
        area: checkAreaOf(work.checkedTaskId),
        logger: this.deps.logger,
      });
      if (harvest.kind === "rejected") return this.checksRejected(d, outcome, harvest.reason, {});
      if (harvest.discarded.length > 0) {
        eventSink?.emit({ event: "check_files_discarded", taskId: task.id, attempt: task.attempt, area: checkAreaOf(work.checkedTaskId), paths: harvest.discarded });
      }

      let redRun: CheckRunReport;
      try {
        redRun = await runChecksOnCheckout(
          dispatchCells.checkCells(d),
          { role: RED_RUN_ROLE, image: work.environment.imageId, commit: foundation.commit, dir: dispatchCells.checkoutDir(d, "red-run") },
          defined,
          harvest.files,
        );
      } catch (e) {
        return mainRunBlocked({ task, sessionId, error: e, agent: { outcome, agentWork: "discarded" }, eventSink, logger: this.deps.logger, stage: "checkRedRun", step: "red run on the foundation" });
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
      const checkedTaskId = parseWorkItemId(work.checkedTaskId, "CheckAuthoring.checkedTaskId");
      const set = await redRunSetVerdict(redRun.runs, () => this.deps.checks.holdEvidenceOf(checkedTaskId));
      const setLine = redRunSetLine(set);
      const report = setLine === null ? runsReport : `${runsReport}\n${setLine}`;
      eventSink?.emit({
        event: "check_red_run",
        taskId: task.id,
        attempt: task.attempt,
        baselineCommit: foundation.commit,
        foundationTaskId: foundation.taskId,
        rejected: problems.map((run) => run.name),
        holdsAlready: redRun.runs.filter((run) => run.exitCode === 0 && redRunProblem(run) === null).map((run) => run.name),
        setRejected: setRejected(set),
        setHeld: set.kind === "held",
        report,
      });
      const rejection = `red run on the foundation (the merge of task ${foundation.taskId}):\n${report}`;
      if (set.kind === "unheld") return this.unheldRejected(d, outcome, { checkedTaskId, evidence: set.evidence, rejection, operator: atFoundation });
      if (problems.length > 0 || setRejected(set)) return this.checksRejected(d, outcome, rejection, atFoundation);

      return await this.recordKept(d, work, { outcome, defined, files: harvest.files, set });
    } finally {
      await discardCheckWorkdir(d.workDir, targetProjectPath, work.branch, this.deps.logger);
    }
  }

  /** A kept set appended to the implementation task's checks, with the foundation as its baseline: the check task is completed. */
  private async recordKept(
    d: VerifiedDispatch,
    work: CheckAuthoring,
    kept: {
      readonly outcome: Outcome;
      readonly defined: ReturnType<CheckAuthoring["recorder"]["checks"]>;
      readonly files: Parameters<TaskCheckStore["append"]>[0]["files"];
      readonly set: Awaited<ReturnType<typeof redRunSetVerdict>>;
    },
  ): Promise<ExecutionResult> {
    const { eventSink } = this.deps;
    const { task, sessionId } = d;
    const { foundation } = work;
    const { outcome, defined, files, set } = kept;
    const revision = await this.deps.checks.append({
      projectId: task.projectId,
      taskId: work.checkedTaskId,
      checkTaskId: task.id,
      environmentVersion: work.environment.version,
      baselineCommit: foundation.commit,
      checks: defined,
      files,
    });
    eventSink?.emit({
      event: "task_checks_recorded",
      taskId: task.id,
      attempt: task.attempt,
      checkedTaskId: work.checkedTaskId,
      revision,
      baselineCommit: foundation.commit,
      checks: defined.map((check) => check.name),
      files: files.map((file) => file.path),
      held: set.kind === "held" ? set.items : [],
    });
    if (set.kind === "held") {
      this.deps.logger.info(
        "quality.checks-held",
        `every check of revision ${revision} for task ${work.checkedTaskId} passes on the foundation, and ` +
          `${set.items.join(", ")} held before the correction that put them in scope: its delivered sweep closes it on main`,
        { taskId: task.id, attempt: task.attempt, checkedTaskId: work.checkedTaskId, revision, items: set.items },
      );
    }
    eventSink?.emit({ event: "task_completed", taskId: task.id, attempt: task.attempt, result: "completed" });
    return {
      status: "completed",
      delivered: { kind: "checks-recorded", revision },
      detail:
        `${defined.length} check(s) recorded as revision ${revision} for task ${work.checkedTaskId}, red-run on the ` +
        `foundation ${foundation.commit}${set.kind === "held" ? `, where every one passes: ${set.items.join(", ")} still hold` : ""}`,
      outcome,
      sessionId,
      attempt: task.attempt,
    };
  }
}
