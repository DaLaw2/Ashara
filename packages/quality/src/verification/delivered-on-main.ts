import { cleanupWorkdir } from "@ashara/execution-infra";
import type { Logger, WorkItemId } from "@ashara/shared";
import { parseWorkItemId, wrapError } from "@ashara/shared";
import { attemptSummary, outcomeRecord } from "@ashara/workplace";
import type { Outcome } from "@ashara/workplace";
import { checkPassed, describeProductChange } from "../check-verdict.js";
import type { CheckRunReport } from "../check-verdict.js";
import { NO_AGENT, NO_CHANGE_REASON, PostMergeEnvironmentMissing, cellImageOf, mainRunBlocked } from "../dispatch-result.js";
import type { AgentPart, CheckAuthoring, ExecutionEventSink, ExecutionResult, VerifiedDispatch } from "../dispatch-result.js";
import type { PostMergeVerdict } from "../gates/finalize.js";
import { deleteSettledTaskBranch } from "../merge.js";
import { mainCommit, productChangeOf, runChecksOnCheckout, runSuitesOnCheckout } from "../task-checks.js";
import type { CheckSuite, CompletedTaskChecks, SuiteRun, TaskCheckStore, TaskChecks } from "../task-checks.js";
import { WORK_FAILED } from "../task-verdict.js";
import { RED_RUN_ROLE } from "./dispatch-cells.js";
import type { DispatchCells } from "./dispatch-cells.js";
import { suitesVerdict } from "./suites-verdict.js";

export interface DeliveredOnMainDeps {
  readonly dispatchCells: Pick<DispatchCells, "checkCells" | "checkoutDir">;
  readonly checks: Pick<TaskCheckStore, "completedOf">;
  readonly eventSink?: ExecutionEventSink;
  readonly logger: Logger;
}

/** Whether a task's work is on main already, decided by its checks run there, never by an agent's word. */
export class DeliveredOnMain {
  private readonly deps: DeliveredOnMainDeps;

  constructor(deps: DeliveredOnMainDeps) {
    this.deps = deps;
  }

  /**
   * An implementer that finished done with no change against main: an
   * earlier task may have delivered this one's work already. Z0 decides that by the checks, never by
   * the implementer's word: it runs them on main (mainSuitesRun). All pass: completed as already
   * delivered, with main's commit at that time as the delivering commit, the task branch deleted and
   * nothing merged. Any fails: failed as "no changes" with the run's output, the branch kept as
   * today. A run that could not run at all blocks for the operator.
   */
  async deliveredOnMain(d: VerifiedDispatch, stored: TaskChecks, agent: AgentPart, turnCount: number): Promise<ExecutionResult> {
    const { eventSink } = this.deps;
    const { task, workDir, targetProjectPath, sessionId } = d;
    const onMain = await this.mainSuitesRun(d, stored, agent);
    if (onMain.kind === "blocked") return onMain.result;
    if (onMain.verdict.passed) return this.alreadyDelivered(d, onMain.main, stored, agent);

    const reason = `${NO_CHANGE_REASON}, and its checks do not all pass on main, so its work is not already delivered:\n${onMain.verdict.details}`;
    eventSink?.emit({ event: "task_failed", taskId: task.id, attempt: task.attempt, reason });
    await cleanupWorkdir(workDir, targetProjectPath);
    const { outcome } = agent;
    return {
      status: "failed",
      verdict: WORK_FAILED,
      detail: reason,
      outcome,
      sessionId,
      attempt: task.attempt,
      errorEnvelope: {
        outcome: "failed",
        summary: reason,
        chain: wrapError("development", "agentExecution", reason, { taskId: task.id, turnCount }),
        ...(outcome === null ? {} : { agentOutput: outcomeRecord(outcome) }),
      },
    };
  }

  /**
   * Before any model is called, sweepDelivered found every stored check passing on main: an
   * earlier task may have delivered this one's work. All suites pass on main: completed as already
   * delivered. The task's own checks pass but main's environment test or an earlier task's check
   * fails there: nothing was delivered and no model ran, so this is not
   * the task's failure: null, and the task goes to its implementer as usual, the post-merge
   * regression suite judging the result. Its own checks failing in this run, after passing in the
   * red run just before, fails the task as before: they do not decide its work either way.
   */
  private async deliveredBeforeModel(d: VerifiedDispatch, stored: TaskChecks): Promise<ExecutionResult | null> {
    const { eventSink } = this.deps;
    const { task, workDir, targetProjectPath, sessionId } = d;
    const onMain = await this.mainSuitesRun(d, stored, NO_AGENT);
    if (onMain.kind === "blocked") return onMain.result;
    if (onMain.verdict.passed) return this.alreadyDelivered(d, onMain.main, stored, NO_AGENT);
    if (onMain.ownPassed) {
      this.deps.logger.info(
        "quality.not-already-delivered",
        `its stored checks pass on main ${onMain.main}, but main's environment test or an earlier task's ` +
          `check fails there, so nothing is already delivered: dispatched to its implementer as usual\n${onMain.verdict.details}`,
        { taskId: task.id, attempt: task.attempt, mainCommit: onMain.main },
      );
      return null;
    }

    const reason =
      `its stored checks pass on main before any implementer ran, but not on the run of every suite there, ` +
      `so its work is not already delivered:\n${onMain.verdict.details}`;
    eventSink?.emit({ event: "task_failed", taskId: task.id, attempt: task.attempt, reason });
    await cleanupWorkdir(workDir, targetProjectPath);
    return {
      status: "failed",
      verdict: WORK_FAILED,
      detail: reason,
      outcome: null,
      sessionId,
      attempt: task.attempt,
      errorEnvelope: {
        outcome: "failed",
        summary: reason,
        chain: wrapError("development", "revalidateTaskChecks", reason, { taskId: task.id }),
      },
    };
  }

  /**
   * On a throwaway checkout of main itself, in a CI cell from the dispatch's environment image: the
   * environment's test, the latest checks of every Completed implementation task of the project (the
   * regression suite) and this task's own checks, each with its files written over the checkout.
   * `ownPassed` when every one of this task's own checks ran and passed, whatever the other suites
   * did. A run that could not run at all is environment-blocked, the workdir cleaned. `subject` is
   * the task whose checks `stored` are: the dispatch's own task, or the task a check task decides
   * (whose worktree the caller has already discarded, so it is not cleaned here).
   */
  private async mainSuitesRun(
    d: VerifiedDispatch,
    stored: TaskChecks,
    agent: AgentPart,
    subject: { readonly taskId: WorkItemId; readonly cleanWorkdir: boolean } = { taskId: d.task.id, cleanWorkdir: true },
  ): Promise<
    | { readonly kind: "blocked"; readonly result: ExecutionResult }
    | { readonly kind: "ran"; readonly main: string; readonly verdict: PostMergeVerdict; readonly ownPassed: boolean }
  > {
    const { eventSink, dispatchCells } = this.deps;
    const { task, workDir, targetProjectPath, sessionId } = d;
    const subjectLabel = subject.taskId === task.id ? "this task's" : `task ${subject.taskId}'s`;
    let main: string;
    let suites: readonly CheckSuite[];
    let own: CheckSuite;
    let runs: readonly SuiteRun[];
    let earlier: readonly CompletedTaskChecks[];
    let unchecked: readonly string[];
    try {
      if (d.environment.kind !== "environment") throw new PostMergeEnvironmentMissing(task.id);
      const environment = d.environment;
      main = await mainCommit(targetProjectPath, task.id);
      const completed = await this.deps.checks.completedOf(task.projectId, subject.taskId);
      earlier = completed.checked;
      unchecked = completed.unchecked;
      own = { label: `${subjectLabel} checks revision ${stored.revision} (check task ${stored.checkTaskId})`, checks: stored.checks, files: stored.files };
      suites = [
        { label: `the environment's test (version ${environment.version})`, checks: [{ name: "environment test", command: environment.definition.test }], files: [] },
        ...earlier.map((prior) => ({
          label: `earlier task ${prior.taskId}'s checks revision ${prior.revision} (check task ${prior.checkTaskId})`,
          checks: prior.checks,
          files: prior.files,
        })),
        own,
      ];
      runs = await runSuitesOnCheckout(dispatchCells.checkCells(d), RED_RUN_ROLE, environment.imageId, main, dispatchCells.checkoutDir(d, "delivered-on-main"), suites);
      // A run that changed main's tracked files decided nothing about main: unrunnable, never a verdict.
      const changed = productChangeOf(task.id, runs);
      if (changed !== null) {
        eventSink?.emit({ event: "check_run_product_changed", taskId: task.id, attempt: task.attempt, commit: main, suite: changed.suite, check: changed.check, paths: changed.paths });
        throw changed;
      }
    } catch (e) {
      if (subject.cleanWorkdir) await cleanupWorkdir(workDir, targetProjectPath);
      return { kind: "blocked", result: mainRunBlocked(task, sessionId, e, agent, eventSink, this.deps.logger, "deliveredCheckRun", "checks run on main") };
    }
    const ran = suitesVerdict(suites, runs, earlier.length, "main");
    const verdict: PostMergeVerdict =
      unchecked.length === 0
        ? ran
        : { passed: ran.passed, details: `${ran.details}\nNot re-run, no check is stored for them (completed before checks existed): ${unchecked.join(", ")}` };
    eventSink?.emit({
      event: "delivered_on_main_verify",
      taskId: task.id,
      attempt: task.attempt,
      verdict: verdict.passed ? "passed" : "failed",
      mainCommit: main,
      checkedTaskId: subject.taskId,
      revision: stored.revision,
      regressionTasks: earlier.map((prior) => prior.taskId),
      uncheckedTasks: unchecked,
      details: verdict.details,
    });
    const ownRun = runs.find((run) => run.suite === own);
    const ownPassed =
      ownRun !== undefined &&
      ownRun.report.kind === "ran" &&
      ownRun.report.runs.length === own.checks.length &&
      ownRun.report.runs.length > 0 &&
      ownRun.report.runs.every(checkPassed);
    return { kind: "ran", main, verdict, ownPassed };
  }

  /** Every suite passed on main: completed as already delivered at `main`, the task branch deleted, nothing merged. */
  private async alreadyDelivered(d: VerifiedDispatch, main: string, stored: TaskChecks, agent: AgentPart): Promise<ExecutionResult> {
    const { eventSink } = this.deps;
    const { task, workDir, targetProjectPath, sessionId } = d;
    await cleanupWorkdir(workDir, targetProjectPath);
    await deleteSettledTaskBranch(targetProjectPath, task.id, "completed as already delivered", this.deps.logger);
    this.deps.logger.info("quality.already-delivered", `already delivered: its checks, the environment's test and the regression suite pass on main ${main}; nothing merged`, {
      taskId: task.id,
      attempt: task.attempt,
      mainCommit: main,
    });
    eventSink?.emit({ event: "task_completed", taskId: task.id, attempt: task.attempt, result: "already_delivered" });
    return {
      status: "completed",
      delivered: { kind: "already-delivered", mainCommit: main },
      detail: `task already delivered on main at ${main}: its checks revision ${stored.revision} and every suite pass there; nothing merged`,
      outcome: agent.outcome,
      sessionId,
      attempt: task.attempt,
    };
  }

  /**
   * The delivered sweep, before every dispatch of an implementation task and before any model is
   * called, once revalidateOnBaseline has trusted them: the task's stored
   * checks run on main in a CI cell from this dispatch's image. Every one passing: the task's work may be on main already, whoever delivered
   * it, and deliveredBeforeModel decides it by the environment's test, the regression suite and those
   * checks on main. Any failing: null, and the dispatch goes on; partial progress is
   * not staleness. A run that could not run at all is environment-blocked.
   */
  async sweepDelivered(d: VerifiedDispatch, stored: TaskChecks): Promise<ExecutionResult | null> {
    const { eventSink, dispatchCells } = this.deps;
    const { task, sessionId, workDir, targetProjectPath } = d;
    let onMain: CheckRunReport;
    let main: string;
    try {
      main = await mainCommit(targetProjectPath, task.id);
      onMain = await runChecksOnCheckout(
        dispatchCells.checkCells(d),
        RED_RUN_ROLE,
        cellImageOf(d.environment),
        main,
        dispatchCells.checkoutDir(d, "delivered-sweep"),
        stored.checks,
        stored.files,
      );
    } catch (e) {
      await cleanupWorkdir(workDir, targetProjectPath);
      return mainRunBlocked(task, sessionId, e, NO_AGENT, eventSink, this.deps.logger, "deliveredCheckRun", "delivered sweep on main");
    }
    const passed = onMain.kind === "ran" ? onMain.runs.filter(checkPassed).map((run) => run.name) : [];
    const allPass = onMain.kind === "ran" && onMain.runs.length === stored.checks.length && passed.length === stored.checks.length;
    eventSink?.emit({
      event: "delivered_sweep",
      taskId: task.id,
      attempt: task.attempt,
      mainCommit: main,
      revision: stored.revision,
      passed,
      allPass,
      ...(onMain.kind === "files_refused" ? { filesRefused: onMain.detail } : {}),
      ...(onMain.kind === "product_changed" ? { productChanged: describeProductChange(onMain) } : {}),
    });
    if (onMain.kind === "product_changed") {
      this.deps.logger.warn("quality.delivered-sweep-undecided", `the delivered sweep on main ${main} reached no verdict: ${describeProductChange(onMain)}`, {
        taskId: task.id,
        attempt: task.attempt,
        mainCommit: main,
      });
    }
    return allPass ? this.deliveredBeforeModel(d, stored) : null;
  }

  /**
   * A check author that finished `blocked`: its reason may be that the
   * task its checks decide is already on main. Z0 does not take that word for it: when the checked
   * task has stored checks, they run on main with the environment's test and the regression suite
   * (mainSuitesRun), the evaluation that closes delivered work. Every suite passing: the check task is
   * completed with no new revision, and the checked task's delivered sweep closes it before any
   * implementer is dispatched. Otherwise null: the blocked result stands, with what the evaluation
   * found. The check task's worktree is already discarded.
   */
  async checkedTaskOnMain(d: VerifiedDispatch, work: CheckAuthoring, outcome: Outcome): Promise<ExecutionResult | { readonly kind: "not-delivered"; readonly why: string }> {
    const { task, sessionId } = d;
    if (work.prior === null) {
      return { kind: "not-delivered", why: `task ${work.checkedTaskId} has no stored checks to run on main, so nothing shows it is delivered` };
    }
    const checkedTaskId = parseWorkItemId(work.checkedTaskId, "CheckAuthoring.checkedTaskId");
    const onMain = await this.mainSuitesRun(d, work.prior, { outcome, agentWork: "discarded" }, { taskId: checkedTaskId, cleanWorkdir: false });
    if (onMain.kind === "blocked") return onMain.result;
    if (!onMain.verdict.passed) {
      return {
        kind: "not-delivered",
        why: `task ${work.checkedTaskId}'s checks revision ${work.prior.revision} and every suite do not all pass on main:\n${onMain.verdict.details}`,
      };
    }
    this.deps.logger.info(
      "quality.checked-task-delivered",
      `the check author finished blocked and task ${work.checkedTaskId} is delivered on main ${onMain.main}: its checks and every suite pass there`,
      { taskId: task.id, attempt: task.attempt, checkedTaskId: work.checkedTaskId, mainCommit: onMain.main },
    );
    this.deps.eventSink?.emit({ event: "task_completed", taskId: task.id, attempt: task.attempt, result: "checked_task_delivered" });
    return {
      status: "completed",
      delivered: { kind: "checked-task-delivered", checkedTaskId: work.checkedTaskId, mainCommit: onMain.main, revision: work.prior.revision },
      detail:
        `the check author finished blocked (${attemptSummary(outcome)}); task ${work.checkedTaskId}'s checks revision ` +
        `${work.prior.revision}, the environment's test and the regression suite all pass on main ${onMain.main}, so no ` +
        `new revision is written: its delivered sweep closes it`,
      outcome,
      sessionId,
      attempt: task.attempt,
    };
  }
}
