import { join } from "node:path";
import type {
  BuiltEnvironment,
  Cell,
  CheckoutLease,
  CurrentEnvironment,
  EnvironmentCheckScope,
  EnvironmentImages,
  EnvironmentTestRun,
} from "@ashara/execution-infra";
import {
  CellTeardownFailed,
  ENVIRONMENT_BUILD_TIMEOUT_MS,
  EnvironmentBuildFailed,
  EnvironmentDefinitionInvalid,
  EnvironmentVersionUnresolved,
  buildContextPaths,
  cellRunBoundMs,
  checkoutsRoot,
  cleanupWorkdir,
  environmentVersion,
  recipePaths,
  resolveCurrentEnvironment,
  targetRepo,
} from "@ashara/execution-infra";
import { PreCallRefusal, modelCallFailureOf } from "@ashara/finance";
import type { ProjectId, WorkItemId } from "@ashara/shared";
import { describeErrorChain, parseWorkItemId, renderElided, wrapError } from "@ashara/shared";
import { createSessionId } from "@ashara/workplace";
import { attemptSummary, outcomeRecord } from "@ashara/workplace";
import type { CheckDefinition, CheckDefinitionPort, CheckRedRunPreview, FoundationProbe, Outcome, TaskCheckRunPort } from "@ashara/workplace";
import { checkPassed, checkRunVerdict, checkVerdict, describeProductChange, formatCheckRuns } from "./check-verdict.js";
import type { CheckRunReport } from "./check-verdict.js";
import {
  NO_AGENT,
  NO_CHANGE_REASON,
  PostMergeEnvironmentMissing,
  asharaBlocked,
  environmentBlocked,
  cellImageOf,
  failedBeforeAgent,
  mainRunBlocked,
  sessionEnvironmentVersion,
  substrateBlocked,
  thrownBlocked,
} from "./dispatch-result.js";
import type {
  AgentPart,
  CheckAuthoring,
  EventSubject,
  ExecutionEventSink,
  ExecutionResult,
  VerificationCells,
  VerifiedDispatch,
  VerifiedTask,
} from "./dispatch-result.js";
import { runFoundationBuild, runPostMergeEnvironmentCommands, runPostMergeProbe, runSubstrateGate } from "./environment-check.js";
import type { EnvironmentStatementStore, SubstrateGateRun, TestedEnvironment } from "./environment-check.js";
import { readEnvironmentDefinition } from "./environment-definition.js";
import type { EnvironmentDefinition } from "./environment-definition.js";
import {
  environmentBuildPassed,
  environmentCheckPassed,
  environmentCommandsPassed,
  formatEnvironmentCheck,
  formatEnvironmentCommands,
  formatEnvironmentProbe,
  environmentProbePassed,
} from "./environment-verdict.js";
import { environmentErrorOf } from "./fault-class.js";
import type { EnvironmentError } from "./fault-class.js";
import { VerificationInfrastructureFault } from "./gates/finalize.js";
import type { PostMergeVerdict } from "./gates/finalize.js";
import { checkBranchOwnership } from "./gates/ownership.js";
import { deleteSettledTaskBranch, discardTaskBranch, taskBranchName } from "./merge.js";
import { interfaceDefectLine, interfaceStandingOnMain, PUBLIC_INTERFACE_FILE } from "./public-interface.js";
import type { InterfaceStanding, ScaffoldMerge } from "./public-interface.js";
import type { SuiteReviewing } from "./suite-review.js";
import {
  FoundationUnbuildable,
  StoredChecksStale,
  checkAreaOf,
  describeFoundationBuild,
  discardCheckWorkdir,
  foundationProbeOf,
  harvestCheckFiles,
  mainCommit,
  previewCheckFiles,
  productChangeOf,
  redRunPreview,
  redRunProblem,
  redRunSetProblem,
  redRunVerdict,
  runChecksOnCheckout,
  runSuitesOnCheckout,
  tentativeMergeCommit,
  worktreeSnapshotCommit,
} from "./task-checks.js";
import type { CheckCells, CheckSuite, CompletedTaskChecks, SuiteRun, TaskCheckStore, TaskChecks } from "./task-checks.js";
import { WORK_FAILED } from "./task-verdict.js";

// Quality's verification of a dispatch's work (ADR-075 §5): the checks a task is decided by, the
// gates before a merge, the post-merge run and the acceptance sweep. Delivery's dispatcher calls it
// at each stage; nothing here decides what happens to the task next.

/**
 * The environment a tentative merge is verified in: the dispatch's own version, unchanged; a new
 * version the merge produced by changing the build context (an input, ADR-074 addendum 2 d72 B3),
 * rebuilt and the product's build and test passed on it (`details` says so); or none the merge can
 * be verified in, which refuses it (`details` says why).
 */
type MergedEnvironment =
  | ({ readonly kind: "unchanged" } & MergedImage)
  | ({ readonly kind: "rebuilt"; readonly statement: string; readonly details: string } & MergedImage)
  | { readonly kind: "refused"; readonly details: string };

/** The image a merge is verified in, and the definition it was built from. */
interface MergedImage {
  readonly version: string;
  /** The image id: what the verifier cells start from. */
  readonly image: string;
  readonly imageRef: string;
  readonly definition: EnvironmentDefinition;
}

/**
 * The verdict on suites run in order (the environment's test, then `regressionCount` earlier
 * tasks' checks, then the task's own) on the task's tentative merge, or on main itself for a task
 * that changed nothing: passed only when every suite ran every one of its checks and each passed.
 * The details open with each failure, naming its suite and check. Only on a merge is an earlier
 * task's failing check this task's regression; on main the task changed nothing to cause it.
 *
 * @testseam verification.test.ts shows a check that never ran fails the verdict (c-independent-verify C2)
 */
export function suitesVerdict(
  suites: readonly CheckSuite[],
  runs: readonly SuiteRun[],
  regressionCount: number,
  on: "merge" | "main",
): PostMergeVerdict {
  const failures: string[] = [];
  const sections: string[] = [];
  let regressed = false;
  if (runs.length !== suites.length) failures.push(`${runs.length} of ${suites.length} suites reported a run`);
  suites.forEach((suite, index) => {
    const regression = on === "merge" && index >= 1 && index <= regressionCount;
    const prefix = regression ? "REGRESSION: " : "";
    const run = runs[index];
    if (run === undefined || run.suite !== suite) {
      failures.push(`${prefix}${suite.label}: did not run`);
      regressed ||= regression;
      return;
    }
    if (run.report.kind === "files_refused") {
      failures.push(`${prefix}${suite.label}: its check files could not be written over ${on === "merge" ? "the merged work" : "main"}: ${run.report.detail}`);
      sections.push(`${suite.label}: not run, its check files could not be written: ${run.report.detail}`);
      regressed ||= regression;
      return;
    }
    // Callers turn a product change into CheckRunChangedProduct first (productChangeOf); stated
    // here too, so this verdict never reads one as a pass.
    if (run.report.kind === "product_changed") {
      failures.push(`${suite.label}: no verdict: ${describeProductChange(run.report)}`);
      sections.push(`${suite.label}: no verdict: ${describeProductChange(run.report)}`);
      return;
    }
    const ran = run.report.runs;
    if (ran.length !== suite.checks.length || ran.length === 0) {
      failures.push(`${prefix}${suite.label}: ${ran.length} of ${suite.checks.length} checks ran`);
      regressed ||= regression;
    }
    for (const failed of ran.filter((check) => !checkPassed(check))) {
      failures.push(`${prefix}${suite.label}: check ${JSON.stringify(failed.name)} ${checkVerdict(failed)}`);
      regressed ||= regression;
    }
    sections.push(`${suite.label}:\n${formatCheckRuns(ran, checkVerdict)}`);
  });
  if (failures.length === 0) return { passed: true, details: sections.join("\n") };
  const head = [`${failures.length} failure(s) on ${on === "merge" ? "the merge" : "main"}:`, ...failures.map((failure) => `- ${failure}`)];
  if (regressed) {
    head.push("This task's merge breaks checks of a task already merged: the regression is this task's, and nothing was merged.");
  }
  return { passed: false, details: [...head, "", ...sections].join("\n") };
}

/** The PreCallRefusal anywhere in the error's cause chain, or null when no model call was refused. */
function preCallRefusalOf(e: unknown): PreCallRefusal | null {
  for (let current: unknown = e; current instanceof Error; current = current.cause) {
    if (current instanceof PreCallRefusal) return current;
  }
  return null;
}

/**
 * An acceptance sweep on main HEAD (TaskVerification.sweepForAcceptance): `ran` with its verdict
 * and the run as the verdict states it, `environmentVersion` null when main defines no environment
 * its cells can be built from; `unrunnable`, nothing decided, when the substrate failed under it
 * (its probe failed, or an EnvironmentError stopped a stage); or `faulted`, nothing decided, when
 * anything else stopped it (Z0's git or checkout machinery, a store, a bug): not the machines, so
 * never reported as the machines. `mainCommit` of a fault is null when main could not be read.
 */
export type AcceptanceSweep =
  | {
      readonly kind: "ran";
      readonly passed: boolean;
      readonly mainCommit: string;
      readonly environmentVersion: string | null;
      /** Completed implementation tasks whose latest stored checks ran. */
      readonly checkedTasks: readonly string[];
      /** Completed implementation tasks with no stored check: nothing of theirs ran, so they are not checked. */
      readonly uncheckedTasks: readonly string[];
      /** The public interface file on main against the product scaffold's: a scaffold's byte for byte, or none, is not accepted. */
      readonly publicInterface: InterfaceStanding;
      /**
       * Every stored check this sweep ran that passed, in the order run, with the command it ran:
       * the only ways of running the product acceptance saw work, which the delivered report
       * presents as verified (the public interface file's entries are never run).
       */
      readonly executedChecks: readonly ExecutedCheck[];
      readonly details: string;
    }
  | { readonly kind: "unrunnable"; readonly error: EnvironmentError }
  | { readonly kind: "faulted"; readonly mainCommit: string | null; readonly error: AcceptanceSweepFault };

/** One stored check an acceptance sweep ran and saw pass: whose it is, and the command run. */
export interface ExecutedCheck {
  readonly taskId: string;
  readonly name: string;
  readonly command: string;
}

/** Each task's stored checks that ran in `runs` and passed, in run order; a check that failed or never ran is none of them. */
function executedChecksOf(stored: ReadonlyArray<{ readonly taskId: string; readonly suite: CheckSuite }>, runs: readonly SuiteRun[]): ExecutedCheck[] {
  return stored.flatMap(({ taskId, suite }) => {
    const report = runs.find((run) => run.suite === suite)?.report;
    if (report?.kind !== "ran") return [];
    return report.runs.filter(checkPassed).map((run) => ({ taskId, name: run.name, command: run.command }));
  });
}

/** A step of an acceptance sweep failed on something other than the substrate: no verdict exists. */
class AcceptanceSweepFault extends Error {
  constructor(
    readonly projectId: ProjectId,
    /** What Z0 was doing when it failed, e.g. "read main". */
    readonly step: string,
    options: { readonly cause: unknown },
  ) {
    super(`the acceptance sweep of project ${projectId} could not run: ${step} failed: ${describeErrorChain(options.cause)}`, { cause: options.cause });
    this.name = "AcceptanceSweepFault";
  }
}

/** The sweep's result, handed to the installed observer first. */
function observed(sweep: AcceptanceSweep): AcceptanceSweep {
  sweepObserver?.(sweep);
  return sweep;
}

/** The ashara.role label of the post-merge check's cell. */
const POST_MERGE_VERIFIER_ROLE = "verifier";
/** The ashara.role label of the cell a check task's checks are red-run in on main. */
const RED_RUN_ROLE = "ci";

/** How a substrate-checked task's gate ended: passed with the image it tested, or the dispatch's result. */
type SubstrateGateOutcome =
  | { readonly kind: "passed"; readonly tested: TestedEnvironment }
  | { readonly kind: "ended"; readonly result: ExecutionResult };

/** Sees every acceptance sweep's result as production returns it; null in production. */
let sweepObserver: ((sweep: AcceptanceSweep) => void) | null = null;

/**
 * Installs `next` for the process: it is handed every acceptance sweep's result (the lifecycle
 * simulator counts their kinds). Returns what puts the previous observer back.
 */
export function observeAcceptanceSweeps(next: (sweep: AcceptanceSweep) => void): () => void {
  const previous = sweepObserver;
  sweepObserver = next;
  return () => {
    sweepObserver = previous;
  };
}

interface TaskVerificationDeps {
  readonly config: { readonly workdirBase: string };
  readonly cells: VerificationCells;
  readonly attemptPolicy: { readonly perCommandTimeoutSeconds: number };
  /**
   * The environment substrate (s-platform-role-m1): builds an environment version's image for the
   * substrate gate and a merge that changes the build context, and keeps the stack statements.
   */
  readonly environment: {
    readonly images: EnvironmentImages;
    readonly statements: EnvironmentStatementStore;
  };
  /**
   * Quality's task checks (s-independent-verify-m1): a check task stores the checks it wrote, and
   * an implementation task is decided by them. Required: no task is verified without them.
   */
  readonly checks: TaskCheckStore;
  /**
   * Quality's review of a plan revision's suites (ADR-074 addendum 2 d71 c): a review task is
   * dispatched to it, never to an agent, so it runs no cell. Required: no implementation is released
   * without it.
   */
  readonly suiteReview: SuiteReviewing;
  readonly eventSink?: ExecutionEventSink;
}

/** Quality's verification of one project's dispatches: every verdict a dispatch is decided by. */
export class TaskVerification {
  private readonly deps: TaskVerificationDeps;

  constructor(deps: TaskVerificationDeps) {
    this.deps = deps;
  }

  /**
   * The review of the plan revision's suites (ADR-074 addendum 2 d71 c). Clean only once the model's
   * verdict validated against its schema and names only suites it read: the plan's implementations
   * are released by completing it. Problems are returned for the orchestrator to route. A refused
   * model call is a refusal like an agent's; a verdict that never validated or is unfit to act on
   * fails the review; a provider's failure or Ashara's own (an unreadable suite, a store, its code)
   * blocks it under that class. Nothing is released on any of them.
   */
  async reviewSuites(task: VerifiedTask, sessionId: string, targetProjectPath: string): Promise<ExecutionResult> {
    const { eventSink } = this.deps;
    let outcome: Awaited<ReturnType<SuiteReviewing["review"]>>;
    try {
      outcome = await this.deps.suiteReview.review(task, targetProjectPath);
    } catch (e) {
      const refusal = preCallRefusalOf(e);
      if (refusal !== null) {
        const summary = `the review of the plan's checks for ${task.id} stopped at a refused model call: ${refusal.message}; nothing was reviewed`;
        return {
          status: "refused",
          refusal,
          detail: summary,
          outcome: null,
          sessionId,
          attempt: task.attempt,
          errorEnvelope: { outcome: "blocked", summary, chain: wrapError("development", "reviewSuites", e, { taskId: task.id }) },
        };
      }
      // Only the review model's own failure is the review's (a verdict that never validated, or one
      // unfit to act on), retried as its work. A provider's failure, or Ashara's (its records, git on
      // the host, a store, its code), says nothing of the suites: blocked under its class, uncharged.
      const failure = modelCallFailureOf(e);
      if (failure === "model") {
        const result = failedBeforeAgent(task, sessionId, "reviewSuites", e, `the review of the plan's checks for ${task.id} gave no verdict`);
        eventSink?.emit({ event: "task_failed", taskId: task.id, attempt: task.attempt, reason: result.detail });
        return result;
      }
      if (failure === "provider") {
        const errorClass = e instanceof Error ? e.name : typeof e;
        return environmentBlocked(
          {
            task,
            sessionId,
            stage: "reviewSuites",
            fault: "provider",
            errorClass,
            message: `the review of the plan's checks for ${task.id} gave no verdict: ${describeErrorChain(e)}`,
            chain: wrapError("development", "reviewSuites", e, { taskId: task.id, errorClass }),
            unavailable: "model provider (suite review)",
            ...NO_AGENT,
          },
          eventSink,
        );
      }
      return thrownBlocked(task, sessionId, "reviewSuites", e, { step: "review the plan's checks", cell: "no cell" }, NO_AGENT, eventSink);
    }
    const setAside = outcome.setAside.length === 0 ? "" : `; set aside the abandoned check task(s) ${outcome.setAside.join(", ")}`;
    // A rejection the second review did not reach is released; both judgements are recorded whole
    // by the reviewer (suite_review_judgements) before this outcome exists.
    const released =
      outcome.released.length === 0
        ? ""
        : `\nReleased as passing review, the two reviews disagreeing:\n` +
          outcome.released
            .map(
              (r) =>
                `- check ${JSON.stringify(r.check)} of ${r.checkTaskId}: the first review judged ${r.first}; the second, ${r.secondReview}, ` +
                (r.second.length === 0 ? "found no problem in that check task" : `judged ${r.second.join("; ")}`),
            )
            .join("\n");
    const releasedChecks = outcome.released.map((r) => `${r.checkTaskId}: ${r.check}`);
    // A finding with neither a witness nor another family's agreement reopens nothing; it is kept
    // as advisory, and an item it leaves undecided is reported unverified (ADR-084 decision 2).
    const advisory =
      (outcome.advisory.length === 0
        ? ""
        : `\nKept as advisory, acting on nothing:\n` + outcome.advisory.map((a) => `- [${a.kind}; ${a.checkTaskIds.join(", ")}] ${a.finding} (${a.why})`).join("\n")) +
      (outcome.undecided.length === 0
        ? ""
        : `\nLeft undecided, to be reported unverified: ${outcome.undecided.map((u) => `${u.itemId} of ${u.checkTaskId}`).join(", ")}`);
    if (outcome.kind === "clean") {
      const detail = `the review read the suites of ${outcome.reviewed.length} check task(s) with the vision and found no problem that acts${setAside}${released}${advisory}`;
      if (released !== "" || advisory !== "") console.warn(`[${task.id}] ${detail}`);
      eventSink?.emit({ event: "suites_reviewed", taskId: task.id, attempt: task.attempt, reviewed: outcome.reviewed, setAside: outcome.setAside, released: releasedChecks });
      return {
        status: "completed",
        delivered: { kind: "suites-reviewed", reviewed: outcome.reviewed },
        detail,
        outcome: null,
        sessionId,
        attempt: task.attempt,
      };
    }
    const named = [...new Set(outcome.problems.flatMap((problem) => problem.checkTaskIds))];
    const summary =
      `the review read the suites of ${outcome.reviewed.length} check task(s) with the vision and found ` +
      `${outcome.problems.length} problem(s) in the checks of ${named.join(", ")}${setAside}:\n` +
      outcome.problems.map((p) => `- [${p.kind}; ${p.checkTaskIds.join(", ")}] ${p.problem}`).join("\n") +
      released +
      advisory;
    console.warn(`[${task.id}] ${summary}`);
    eventSink?.emit({ event: "suite_review_problems", taskId: task.id, attempt: task.attempt, checkTasks: named, problems: outcome.problems.length, released: releasedChecks });
    return {
      status: "suite_review_problems",
      problems: outcome.problems,
      detail: summary,
      outcome: null,
      sessionId,
      attempt: task.attempt,
      errorEnvelope: { outcome: "blocked", summary, chain: wrapError("development", "reviewSuites", summary, { taskId: task.id, checkTasks: named }) },
    };
  }

  /** A failed teardown is logged at warn with its typed context; the substrate keeps the cell for teardownAll and reconcileOrphans. */
  async teardownCell(subject: EventSubject, cell: Cell): Promise<void> {
    try {
      await cell.teardown();
    } catch (e) {
      if (!(e instanceof CellTeardownFailed)) throw e;
      const owner = "projectId" in subject ? `acceptance-${subject.projectId}` : `${subject.taskId} attempt ${subject.attempt}`;
      console.warn(`[${owner}] cell teardown failed; the next cycle's release of held cells removes it (teardownAll at shutdown and reconcileOrphans at startup if the process ends first):`, e);
      this.deps.eventSink?.emit({ event: "cell_teardown_failed", ...subject, cellId: e.cellId, exitCode: e.exitCode, stderr: e.stderr });
    }
  }

  /** Cells for checks: from the dispatch's environment image, each mounting one throwaway checkout. */
  private checkCells(d: VerifiedDispatch): CheckCells {
    const scope = this.environmentScope(d);
    return {
      targetProjectPath: d.targetProjectPath,
      createCell: scope.createCell,
      teardownCell: scope.teardownCell,
      timeoutSeconds: this.deps.attemptPolicy.perCommandTimeoutSeconds,
    };
  }

  /** A throwaway checkout of the dispatch, under the workdir base the substrate mounts from. */
  private checkoutDir(
    d: VerifiedDispatch,
    purpose:
      | "red-run"
      | "verify"
      | "verify-probe"
      | "post-merge-checks"
      | "delivered-on-main"
      | "delivered-sweep"
      | `run-checks-${number}`
      | `define-check-${number}`
      | `probe-foundation-${number}`
      | "environment-check"
      | "substrate-gate"
      | "foundation-build",
  ): string {
    return join(checkoutsRoot(this.deps.config.workdirBase), `${purpose}-${d.task.id}-${d.sessionId}`);
  }

  /**
   * An implementer that finished done with no change against main (ADR-074 addendum 2 d67 b): an
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
   * fails there (ADR-074 addendum 2 d68 a): nothing was delivered and no model ran, so this is not
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
      console.log(
        `[${task.id}] its stored checks pass on main ${onMain.main}, but main's environment test or an earlier task's ` +
          `check fails there, so nothing is already delivered: dispatched to its implementer as usual\n${onMain.verdict.details}`,
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
    const { eventSink } = this.deps;
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
      runs = await runSuitesOnCheckout(this.checkCells(d), RED_RUN_ROLE, environment.imageId, main, this.checkoutDir(d, "delivered-on-main"), suites);
      // A run that changed main's tracked files decided nothing about main: unrunnable, never a verdict.
      const changed = productChangeOf(task.id, runs);
      if (changed !== null) {
        eventSink?.emit({ event: "check_run_product_changed", taskId: task.id, attempt: task.attempt, commit: main, suite: changed.suite, check: changed.check, paths: changed.paths });
        throw changed;
      }
    } catch (e) {
      if (subject.cleanWorkdir) await cleanupWorkdir(workDir, targetProjectPath);
      return { kind: "blocked", result: mainRunBlocked(task, sessionId, e, agent, eventSink, "deliveredCheckRun", "checks run on main") };
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
    await deleteSettledTaskBranch(targetProjectPath, task.id, "completed as already delivered");
    console.log(`[${task.id}] already delivered: its checks, the environment's test and the regression suite pass on main ${main}; nothing merged`);
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
   * The acceptance sweep (story s-independent-verify-m1 W7, design P11): once every task of a
   * project's plan is settled with its goal tasks done, Z0 runs, on main HEAD in one CI cell from
   * main's environment image, the environment's test and the latest checks of every Completed
   * implementation task (the regression suite), each suite's files written over the checkout, with
   * no model called. Passed only when every suite ran every check and each passed, and every goal
   * task in `goalTaskIds` has checks stored: a goal never checked is not accepted on its word.
   * Completed tasks with no stored check are named apart (`uncheckedTasks`), never counted as
   * passed. A main whose public interface file is byte for byte the one a product scaffold in
   * `scaffolds` wrote, or that holds no such file, fails the sweep, its details opening with what to
   * update or restore. Passing that comparison verifies nothing the file says: the delivered report
   * quotes the file as unverified, and presents as verified only `executedChecks`, the stored
   * checks this sweep ran and saw pass. A main with no environment its cells can be built from fails the sweep, with the
   * reason. A sweep that could not run is `unrunnable` only when the substrate failed (its probe, or
   * an EnvironmentError); any other error is `faulted`, with the step it stopped at. The caller
   * bounds both (orchestrator acceptance.ts).
   */
  async sweepForAcceptance(
    projectId: ProjectId,
    targetProjectPath: string,
    goalTaskIds: readonly string[],
    scaffolds: readonly ScaffoldMerge[],
  ): Promise<AcceptanceSweep> {
    const label = `acceptance-${projectId}`;
    let step = "probe the substrate";
    let main: string | null = null;
    try {
      await this.deps.cells.substrate.probeSubstrate();
      step = "read main";
      main = await mainCommit(targetProjectPath, label);
      return observed(
        await this.runAcceptanceSweep(projectId, targetProjectPath, goalTaskIds, scaffolds, main, (next) => {
          step = next;
        }),
      );
    } catch (e) {
      const substrate = environmentErrorOf(e);
      if (substrate !== null) return observed({ kind: "unrunnable", error: substrate });
      return observed({ kind: "faulted", mainCommit: main, error: new AcceptanceSweepFault(projectId, step, { cause: e }) });
    }
  }

  /** The sweep once the substrate answered and main was read; `at` names each step, for a fault. */
  private async runAcceptanceSweep(
    projectId: ProjectId,
    targetProjectPath: string,
    goalTaskIds: readonly string[],
    scaffolds: readonly ScaffoldMerge[],
    main: string,
    at: (step: string) => void,
  ): Promise<AcceptanceSweep> {
    const { cells, eventSink } = this.deps;
    const label = `acceptance-${projectId}`;
    at("resolve main's environment");
    const resolution = await resolveCurrentEnvironment(
      projectId,
      targetRepo(targetProjectPath),
      this.deps.environment.images,
      this.deps.environment.statements,
      readEnvironmentDefinition,
    );
    if (resolution.kind === "undefined") {
      return {
        kind: "ran",
        passed: false,
        mainCommit: main,
        environmentVersion: null,
        checkedTasks: [],
        uncheckedTasks: [],
        publicInterface: { kind: "not-compared" },
        executedChecks: [],
        details: `no environment its cells can be built from: ${resolution.reason}`,
      };
    }
    const environment: CurrentEnvironment<EnvironmentDefinition> = resolution.environment;
    at(`compare ${PUBLIC_INTERFACE_FILE} on main with the product scaffold's`);
    const publicInterface = await interfaceStandingOnMain(targetProjectPath, main, scaffolds);
    at("read the stored checks of the completed tasks");
    const completed = await this.deps.checks.completedOf(projectId, null);
    const checkedIds = new Set(completed.checked.map((prior) => prior.taskId));
    const neverChecked = goalTaskIds.filter((id) => !checkedIds.has(id));
    const stored = completed.checked.map((prior) => ({
      taskId: prior.taskId,
      suite: {
        label: `task ${prior.taskId}'s checks revision ${prior.revision} (check task ${prior.checkTaskId})`,
        checks: prior.checks,
        files: prior.files,
      },
    }));
    const suites: CheckSuite[] = [
      { label: `the environment's test (version ${environment.version})`, checks: [{ name: "environment test", command: environment.definition.test }], files: [] },
      ...stored.map((each) => each.suite),
    ];
    at("run the suites on a checkout of main");
    const checkCells: CheckCells = {
      targetProjectPath,
      createCell: ({ image, role, hostPath }) =>
        cells.substrate.createCell({ image, project: projectId, task: label, role, instance: cells.instance, mount: { hostPath, shared: true } }),
      teardownCell: (cell) => this.teardownCell({ projectId }, cell),
      timeoutSeconds: this.deps.attemptPolicy.perCommandTimeoutSeconds,
    };
    const dir = join(checkoutsRoot(this.deps.config.workdirBase), `acceptance-${projectId}-${createSessionId()}`);
    const runs: readonly SuiteRun[] = await runSuitesOnCheckout(checkCells, RED_RUN_ROLE, environment.imageId, main, dir, suites);
    const ran = suitesVerdict(suites, runs, completed.checked.length, "main");
    const gaps = [
      ...(neverChecked.length === 0 ? [] : [`Goal task(s) with no stored checks, so never checked: ${neverChecked.join(", ")}`]),
      ...(completed.unchecked.length === 0 ? [] : [`Not re-run, no check is stored for them: ${completed.unchecked.join(", ")}`]),
    ];
    const interfaceDefect = interfaceDefectLine(publicInterface);
    const passed = ran.passed && neverChecked.length === 0 && interfaceDefect === null;
    // The interface line comes first: a repair reads the start of these details when they are long.
    const details = [...(interfaceDefect === null ? [] : [interfaceDefect]), ran.details, ...gaps].join("\n");
    const checkedTasks = completed.checked.map((prior) => prior.taskId);
    eventSink?.emit({
      event: "acceptance_sweep",
      projectId,
      mainCommit: main,
      verdict: passed ? "passed" : "failed",
      checkedTasks,
      neverChecked,
      details,
    });
    return {
      kind: "ran",
      passed,
      mainCommit: main,
      environmentVersion: environment.version,
      checkedTasks,
      uncheckedTasks: completed.unchecked,
      publicInterface,
      executedChecks: executedChecksOf(stored, runs),
      details,
    };
  }

  /** What an environment check of this dispatch reaches: its worktree, its project's images, and cells mounting a tree. */
  environmentScope(d: VerifiedDispatch): EnvironmentCheckScope {
    const { cells } = this.deps;
    const { task } = d;
    return {
      projectId: task.projectId,
      taskId: task.id,
      workDir: d.workDir,
      repo: d.repo,
      targetProjectPath: d.targetProjectPath,
      checkoutDir: (purpose) => this.checkoutDir(d, purpose),
      images: this.deps.environment.images,
      // Shared label (`:z`): the task cell may still mount the same tree. Its `.git` is a throwaway
      // repository of the cell's own: the checkout's names host paths, and Z0's git reads that
      // repository after the cell ran.
      createCell: ({ image, role, hostPath }) =>
        cells.substrate.createCell({
          image,
          project: task.projectId,
          task: task.id,
          role,
          instance: cells.instance,
          mount: { hostPath, shared: true },
        }),
      teardownCell: (cell) => this.teardownCell({ taskId: task.id, attempt: task.attempt }, cell),
    };
  }

  /**
   * Separation of duties (s-platform-role-m1; ADR-074 addendum 2 d72 B1), before
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
        return substrateBlocked(task, sessionId, "ownershipGate", environmentFailure, "host git", { outcome, agentWork: "kept" }, eventSink);
      }
      const fault = new VerificationInfrastructureFault(task.id, step, { cause: e });
      const chain = wrapError("development", "ownershipGate", fault, { taskId: task.id, errorClass: fault.name });
      return asharaBlocked(task, sessionId, "ownershipGate", fault, { outcome, agentWork: "kept" }, eventSink, chain);
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
      console.warn(`[${task.id}] ${summary}`);
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

  /**
   * The Sprint 0 gate (task_spec.checkedBy "substrate"), in place of per-task verify: on the agent's
   * work as committed to the task branch (commitWork), its environment definition must parse, its image
   * build and its `test` pass in a fresh CI cell. A failed gate is a task failure (the definition
   * is the environment role's work), never environment_unavailable; a substrate that cannot run
   * the gate blocks the task. On a pass the finish statement (the stack statement only, never the
   * summary) is kept on the work item; a done without one fails the task before the gate runs.
   */
  async substrateGate(d: VerifiedDispatch, statement: string | null, outcome: Outcome): Promise<SubstrateGateOutcome> {
    const { eventSink, attemptPolicy } = this.deps;
    const { task, workDir, targetProjectPath, sessionId } = d;
    const fail = (summary: string, chain: ReturnType<typeof wrapError>): SubstrateGateOutcome => ({
      kind: "ended",
      result: { status: "failed", verdict: WORK_FAILED, detail: summary, outcome, sessionId, attempt: task.attempt, errorEnvelope: { outcome: "failed", summary, chain, agentOutput: outcomeRecord(outcome) } },
    });
    if (statement === null) {
      await cleanupWorkdir(workDir, targetProjectPath);
      const summary = `substrate gate failed for ${task.id}: the attempt finished done without a stack statement (finish's statement field)`;
      return fail(summary, wrapError("development", "substrateGate", summary, { taskId: task.id }));
    }
    eventSink?.emit({ event: "substrate_gate_started", taskId: task.id, attempt: task.attempt, workDir });

    let run: SubstrateGateRun;
    try {
      run = await runSubstrateGate(this.environmentScope(d), attemptPolicy.perCommandTimeoutSeconds);
    } catch (e) {
      await cleanupWorkdir(workDir, targetProjectPath);
      const fault = environmentErrorOf(e) ?? new VerificationInfrastructureFault(task.id, "substrate gate run", { cause: e });
      return { kind: "ended", result: thrownBlocked(task, sessionId, "substrateGate", fault, { step: "substrate gate run", cell: "CI cell" }, { outcome, agentWork: "kept" }, eventSink) };
    }

    const passed = environmentCheckPassed(run.report);
    const gateOutput = formatEnvironmentCheck(run.report);
    eventSink?.emit({ event: "substrate_gate_result", taskId: task.id, attempt: task.attempt, passed, report: run.report.kind, output: gateOutput });
    if (!passed || run.tested === null) {
      await cleanupWorkdir(workDir, targetProjectPath);
      const chain = wrapError("development", "substrateGate", gateOutput, { taskId: task.id, report: run.report.kind });
      return fail(`substrate gate failed for ${task.id}:\n${gateOutput}`, chain);
    }

    try {
      await this.deps.environment.statements.record(task.id, statement, run.tested.version);
    } catch (e) {
      // The gate passed; only Z0's store failed to keep its statement, as recordRebuiltStatement's write.
      await cleanupWorkdir(workDir, targetProjectPath);
      const fault = new VerificationInfrastructureFault(task.id, `record the environment statement for version ${run.tested.version}`, { cause: e });
      return { kind: "ended", result: asharaBlocked(task, sessionId, "substrateGate", fault, { outcome, agentWork: "kept" }, eventSink) };
    }
    return { kind: "passed", tested: run.tested };
  }

  /**
   * An environment task's post-merge check: the gate's run again, the definition's `probe` from the
   * gate's image, on a throwaway checkout of the tentative merge. Sprint 0's merge holds no product,
   * so it runs nothing else (ADR-074 addendum 2 d72 S), nor does an environment change opened with
   * product "absent" (the product scaffold asked before any scaffold completed; its own merge runs
   * them). Any other environment change lands on a product: after the probe, the product's `build`
   * then `test` run on the merge from the same image and must leave the checkout clean.
   */
  async postMergeEnvironmentTest(d: VerifiedDispatch, targetProjectPath: string, tested: TestedEnvironment, lease: CheckoutLease): Promise<PostMergeVerdict> {
    const commit = await tentativeMergeCommit(targetProjectPath, d.task.id);
    const scope = this.environmentScope(d);
    const timeoutSeconds = this.deps.attemptPolicy.perCommandTimeoutSeconds;
    lease.extend(cellRunBoundMs([timeoutSeconds]), "the post-merge probe cell");
    const probe = await runPostMergeProbe(scope, POST_MERGE_VERIFIER_ROLE, tested, commit, timeoutSeconds);
    let passed = environmentProbePassed(probe);
    let details = formatEnvironmentProbe(probe);
    const noProduct = d.task.taskSpec?.origin === "sprint0" || d.task.taskSpec?.product === "absent";
    if (passed && !noProduct) {
      lease.extend(cellRunBoundMs([timeoutSeconds, timeoutSeconds]), "the post-merge build and test cell");
      const commands = await runPostMergeEnvironmentCommands(scope, POST_MERGE_VERIFIER_ROLE, tested, commit, timeoutSeconds);
      passed = environmentCommandsPassed(commands);
      details = `${details}\nThe product's build and test on the merge:\n${formatEnvironmentCommands(commands)}`;
    }
    this.deps.eventSink?.emit({ event: "post_merge_verify", taskId: d.task.id, attempt: d.task.attempt, verdict: passed ? "passed" : "failed", details });
    return { passed, details };
  }

  /**
   * The product scaffold's post-merge check (ADR-074 addendum 2 d72 B2): the environment of the
   * tentative merge (mergedEnvironment: rebuilt when the scaffold wrote an input the recipe reads),
   * then the definition's `build` then `test` on a throwaway checkout of the merge in a verifier
   * cell from that image, which must pass and leave the checkout clean. A rebuilt version passing
   * records the dispatch's statement for it. A substrate failure throws.
   */
  async postMergeScaffold(d: VerifiedDispatch, targetProjectPath: string, lease: CheckoutLease): Promise<PostMergeVerdict> {
    const { task } = d;
    let verdict: PostMergeVerdict;
    let merged: MergedEnvironment;
    try {
      if (d.environment.kind !== "environment") throw new PostMergeEnvironmentMissing(task.id);
      const commit = await tentativeMergeCommit(targetProjectPath, task.id);
      merged = await this.mergedEnvironment(d, d.environment, commit, lease);
      if (merged.kind === "refused") {
        verdict = { passed: false, details: merged.details };
      } else if (merged.kind === "rebuilt") {
        verdict = { passed: true, details: merged.details };
      } else {
        const timeoutSeconds = this.deps.attemptPolicy.perCommandTimeoutSeconds;
        lease.extend(cellRunBoundMs([timeoutSeconds, timeoutSeconds]), "the post-merge build and test cell");
        const commands = await runPostMergeEnvironmentCommands(
          this.environmentScope(d),
          POST_MERGE_VERIFIER_ROLE,
          { version: merged.version, imageRef: merged.imageRef, definition: merged.definition },
          commit,
          this.deps.attemptPolicy.perCommandTimeoutSeconds,
        );
        verdict = {
          passed: environmentCommandsPassed(commands),
          details: `the product's build and test (environment version ${merged.version}) on the merge:\n${formatEnvironmentCommands(commands)}`,
        };
      }
    } catch (e) {
      if (environmentErrorOf(e) !== null) throw e;
      throw new VerificationInfrastructureFault(task.id, "product scaffold build and test", { cause: e });
    }
    this.deps.eventSink?.emit({ event: "post_merge_verify", taskId: task.id, attempt: task.attempt, verdict: verdict.passed ? "passed" : "failed", details: verdict.details });
    if (verdict.passed && merged.kind === "rebuilt") await this.recordRebuiltStatement(task.id, merged);
    return verdict;
  }

  /** The version a verified merge produced carries the statement of the stack it was built from. */
  private async recordRebuiltStatement(taskId: WorkItemId, merged: Extract<MergedEnvironment, { readonly kind: "rebuilt" }>): Promise<void> {
    try {
      await this.deps.environment.statements.record(taskId, merged.statement, merged.version);
    } catch (e) {
      throw new VerificationInfrastructureFault(taskId, `record the environment statement for rebuilt version ${merged.version}`, { cause: e });
    }
  }

  /**
   * Every other task's post-merge check (s-independent-verify-m1, ADR-074 addendum 2 d64 d, d72 B3).
   * First the merge's own environment (mergedEnvironment): when the work changed an input the
   * recipe reads, the merge's version is rebuilt and the product's build and test must pass on it,
   * and that version's image and test replace the dispatch's below; the merge passing records the
   * dispatch's statement for that version. Then, in one verifier cell from that image on a
   * throwaway checkout of the tentative merge, in order:
   * the environment definition's `test`; the latest stored checks of every implementation task of
   * the project already Completed, each with its files written over the checkout; then this task's
   * own stored checks with theirs, so whatever the implementer put at those paths is replaced and it
   * cannot grade itself. An earlier task's checks are not red-run again on this environment: they
   * are regression checks and must pass on the merge whatever version they were red-run on. Every
   * check must exit 0 with output; any failure fails this task naming the suite and the check, and
   * an earlier task's check that fails is this task's regression. Sequential, each check bounded by
   * the per-command timeout: the run takes at most (1 + every check counted) x that timeout, plus
   * the cell's start and teardown, plus, for a rebuilt environment, its image build (bounded by the
   * builder) and its build and test (2 x that timeout). A substrate failure throws, which finalize turns into an
   * environment block.
   */
  async postMergeStoredChecks(d: VerifiedDispatch, targetProjectPath: string, stored: TaskChecks, lease: CheckoutLease): Promise<PostMergeVerdict> {
    const { task } = d;
    let runs: readonly SuiteRun[];
    let suites: readonly CheckSuite[];
    let earlier: readonly CompletedTaskChecks[];
    let unchecked: readonly string[];
    let merged: MergedEnvironment;
    try {
      if (d.environment.kind !== "environment") {
        throw new PostMergeEnvironmentMissing(task.id);
      }
      const commit = await tentativeMergeCommit(targetProjectPath, task.id);
      merged = await this.mergedEnvironment(d, d.environment, commit, lease);
      if (merged.kind === "refused") {
        this.deps.eventSink?.emit({ event: "post_merge_verify", taskId: task.id, attempt: task.attempt, verdict: "failed", revision: stored.revision, details: merged.details });
        return { passed: false, details: merged.details };
      }
      const completed = await this.deps.checks.completedOf(task.projectId, task.id);
      earlier = completed.checked;
      unchecked = completed.unchecked;
      suites = [
        { label: `the environment's test (version ${merged.version})`, checks: [{ name: "environment test", command: merged.definition.test }], files: [] },
        ...earlier.map((prior) => ({
          label: `earlier task ${prior.taskId}'s checks revision ${prior.revision} (check task ${prior.checkTaskId})`,
          checks: prior.checks,
          files: prior.files,
        })),
        { label: `this task's checks revision ${stored.revision} (check task ${stored.checkTaskId})`, checks: stored.checks, files: stored.files },
      ];
      const checks = suites.reduce((sum, suite) => sum + suite.checks.length, 0);
      const perCheck = this.deps.attemptPolicy.perCommandTimeoutSeconds;
      lease.extend(cellRunBoundMs(Array.from({ length: checks }, () => perCheck)), `the post-merge cell of ${checks} check(s)`);
      runs = await runSuitesOnCheckout(
        this.checkCells(d),
        POST_MERGE_VERIFIER_ROLE,
        merged.image,
        commit,
        this.checkoutDir(d, "post-merge-checks"),
        suites,
      );
      // A run that changed the merge's tracked files is no verdict on the merge (L9): unrunnable,
      // carried out typed in the fault's cause, neither a pass nor the task's failure.
      const changed = productChangeOf(task.id, runs);
      if (changed !== null) {
        this.deps.eventSink?.emit({ event: "check_run_product_changed", taskId: task.id, attempt: task.attempt, commit, suite: changed.suite, check: changed.check, paths: changed.paths });
        throw changed;
      }
    } catch (e) {
      if (environmentErrorOf(e) !== null) throw e;
      throw new VerificationInfrastructureFault(task.id, "stored-check run", { cause: e });
    }
    const checkCount = suites.reduce((sum, suite) => sum + suite.checks.length, 0);
    const suitesVerdictRun = suitesVerdict(suites, runs, earlier.length, "merge");
    const suitesRun: PostMergeVerdict =
      merged.kind === "rebuilt"
        ? { passed: suitesVerdictRun.passed, details: `${merged.details}\n${suitesVerdictRun.details}` }
        : suitesVerdictRun;
    // A task completed with no stored check has nothing to re-run: skipping it is stated, never
    // silent, and never a block (no transition could ever give a Completed task checks, so every
    // later merge of the project would block on it with no exit).
    const verdict: PostMergeVerdict =
      unchecked.length === 0
        ? suitesRun
        : {
            passed: suitesRun.passed,
            details: `${suitesRun.details}\nNot re-run, no check is stored for them (completed before checks existed): ${unchecked.join(", ")}`,
          };
    if (unchecked.length > 0) {
      console.warn(`[${task.id}] post-merge regression suite skips Completed task(s) with no stored check: ${unchecked.join(", ")}`);
    }
    this.deps.eventSink?.emit({
      event: "post_merge_verify",
      taskId: task.id,
      attempt: task.attempt,
      verdict: verdict.passed ? "passed" : "failed",
      revision: stored.revision,
      regressionTasks: earlier.map((prior) => prior.taskId),
      uncheckedTasks: unchecked,
      boundSeconds: checkCount * this.deps.attemptPolicy.perCommandTimeoutSeconds,
      details: verdict.details,
    });
    // The version this merge produces is the stack the team stated, with inputs a verified merge
    // changed: it carries that statement, so the next dispatch resolves it (current-environment.ts).
    if (verdict.passed && merged.kind === "rebuilt") await this.recordRebuiltStatement(task.id, merged);
    return verdict;
  }

  /**
   * The environment of the tentative merge `commit` (ADR-074 addendum 2 d72 B3): its definition and
   * version read from the merge's committed objects, the version being the digest of the build
   * context (environmentVersion, the same function the image build uses). The same version as the
   * dispatch's: its image. Another one (the work changed an input the recipe reads): its image is
   * built and recorded, and the product's `build` then `test` run on a fresh checkout of the merge
   * in a verifier cell from it, which must pass and leave the checkout clean; the caller then runs
   * the stored checks on that image. A definition the merge leaves unreadable, an image that cannot
   * be built and a failed build or test refuse the merge with what failed, the task's failure. A
   * substrate failure throws.
   */
  private async mergedEnvironment(d: VerifiedDispatch, current: CurrentEnvironment<EnvironmentDefinition>, commit: string, lease: CheckoutLease): Promise<MergedEnvironment> {
    const { task } = d;
    const gitDir = targetRepo(d.targetProjectPath).gitDir;
    const refused = (details: string): MergedEnvironment => ({ kind: "refused", details });
    let definition: EnvironmentDefinition;
    let version: string;
    try {
      definition = await readEnvironmentDefinition(gitDir, commit);
      version = (await environmentVersion(gitDir, commit, definition)).version;
    } catch (e) {
      if (e instanceof EnvironmentDefinitionInvalid || e instanceof EnvironmentVersionUnresolved) {
        return refused(`The merge leaves no environment that can be built (it was version ${current.version}): ${e.message}`);
      }
      throw e;
    }
    if (version === current.version) {
      return { kind: "unchanged", version, image: current.imageId, imageRef: current.imageRef, definition: current.definition };
    }

    const change = `The merge changes the environment's build context (its inputs): version ${current.version} becomes ${version}`;
    const timeoutSeconds = this.deps.attemptPolicy.perCommandTimeoutSeconds;
    lease.extend(ENVIRONMENT_BUILD_TIMEOUT_MS + cellRunBoundMs([timeoutSeconds, timeoutSeconds]), "the merge's environment rebuild and its build and test cell");
    let built: BuiltEnvironment;
    try {
      built = await this.deps.environment.images.build({ projectId: task.projectId, repoGitDir: gitDir, commit, definition });
    } catch (e) {
      if (e instanceof EnvironmentBuildFailed) {
        return refused(
          `${change}, and its image could not be built: ${e.detail}\nBuild log:\n${renderElided(e.log).trim() || "(empty)"}`,
        );
      }
      if (e instanceof EnvironmentVersionUnresolved) return refused(`${change}, and it cannot be built: ${e.message}`);
      throw e;
    }
    if (built.version !== version) {
      throw new VerificationInfrastructureFault(task.id, "rebuild the merge's environment", {
        cause: `version ${version} was resolved at ${commit}, but the image was built for ${built.version}`,
      });
    }
    this.deps.eventSink?.emit({
      event: "environment_rebuilt",
      taskId: task.id,
      attempt: task.attempt,
      from: current.version,
      to: version,
      imageId: built.imageId,
      imageRef: built.imageRef,
      reused: built.reused,
    });
    const commands = await runPostMergeEnvironmentCommands(
      this.environmentScope(d),
      POST_MERGE_VERIFIER_ROLE,
      { version, imageRef: built.imageRef, definition },
      commit,
      this.deps.attemptPolicy.perCommandTimeoutSeconds,
    );
    const ran = `the product's build and test on the rebuilt environment (version ${version}) on the merge:\n${formatEnvironmentCommands(commands)}`;
    if (!environmentCommandsPassed(commands)) return refused(`${change}, and ${ran}`);
    return {
      kind: "rebuilt",
      version,
      image: built.imageId,
      imageRef: built.imageRef,
      definition,
      statement: current.statement,
      details: `${change}; ${ran}`,
    };
  }

  /**
   * run_checks' port: the stored checks, with their stored files written over a throwaway checkout
   * of a snapshot of the implementer's current worktree, run in a fresh CI cell from the dispatch's
   * image. The implementer's worktree itself is never written. A substrate failure throws as it
   * is; a failure of Z0's own machinery (the snapshot commit, the checkout) throws as a
   * VerificationInfrastructureFault. Either ends the attempt as its environment failing, and
   * endWithoutDone names which.
   */
  taskCheckRunPort(d: VerifiedDispatch, stored: TaskChecks, merged: readonly CompletedTaskChecks[]): TaskCheckRunPort {
    let runs = 0;
    return {
      checkNames: stored.checks.map((check) => check.name),
      mergedChecks: merged.flatMap((prior) => prior.checks.map((check) => ({ taskId: prior.taskId, name: check.name }))),
      run: async (timeoutSeconds) => {
        runs += 1;
        let report: CheckRunReport;
        try {
          const commit = await worktreeSnapshotCommit(d.repo, d.task.id, "run_checks");
          report = await runChecksOnCheckout(
            { ...this.checkCells(d), timeoutSeconds },
            RED_RUN_ROLE,
            cellImageOf(d.environment),
            commit,
            this.checkoutDir(d, `run-checks-${runs}`),
            stored.checks,
            stored.files,
          );
        } catch (e) {
          if (environmentErrorOf(e) !== null) throw e;
          throw new VerificationInfrastructureFault(d.task.id, "run_checks", { cause: e });
        }
        this.deps.eventSink?.emit({
          event: "task_checks_run",
          taskId: d.task.id,
          attempt: d.task.attempt,
          run: runs,
          revision: stored.revision,
          ...(report.kind === "ran"
            ? { passed: report.runs.filter(checkPassed).map((run) => run.name) }
            : report.kind === "files_refused"
              ? { refused: report.detail }
              : { productChanged: describeProductChange(report) }),
        });
        return checkRunVerdict(report);
      },
    };
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
      build = await runFoundationBuild(
        this.environmentScope(d),
        RED_RUN_ROLE,
        work.environment.imageId,
        work.foundation.commit,
        work.environment.definition,
        this.deps.attemptPolicy.perCommandTimeoutSeconds,
      );
    } catch (e) {
      await discardCheckWorkdir(d.workDir, targetProjectPath, work.branch);
      return mainRunBlocked(task, sessionId, e, NO_AGENT, eventSink, "checkRedRun", "build on the foundation");
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

    await discardCheckWorkdir(d.workDir, targetProjectPath, work.branch);
    const unbuildable = new FoundationUnbuildable(task.id, work.foundation.taskId, work.environment.version, build);
    const summary = `no check of task ${task.id} can be red-run: ${unbuildable.message}; no agent ran`;
    console.warn(`[${task.id}] ${summary}`);
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

  /**
   * define_check's port (ADR-074 addendum 2 d65 a): records the definition, the last of a name
   * winning, then red-runs that one check at once by the harvest's own machinery: the files the
   * attempt has changed so far (a snapshot of its throwaway worktree, by the harvest's rules) are
   * written over a fresh checkout of the plan's foundation (ADR-074 addendum 2 d74 A), and the check
   * runs in a CI cell from the environment image. The author is shown its exit code and output and
   * whether the red run at finish would reject it; that red run still decides, unchanged. A
   * substrate failure throws as it is; a failure of Z0's own machinery throws as a
   * VerificationInfrastructureFault.
   */
  checkDefinitionPort(d: VerifiedDispatch, work: CheckAuthoring): CheckDefinitionPort {
    let runs = 0;
    // One command on a fresh checkout of the foundation with the attempt's check files so far over
    // it, by the harvest's own rules: define_check's red run and probe_foundation's look alike.
    const onFoundation = async (
      check: CheckDefinition,
      timeoutSeconds: number,
      purpose: "define-check" | "probe-foundation",
    ): Promise<{ readonly report: CheckRunReport; readonly dir: string; readonly discarded: readonly string[] }> => {
      runs += 1;
      const dir = this.checkoutDir(d, `${purpose}-${runs}`);
      try {
        const harvest = await previewCheckFiles(
          d.repo,
          d.task.id,
          work.startCommit,
          buildContextPaths(work.environment.definition),
          work.recorder.writtenFiles(),
          checkAreaOf(work.checkedTaskId),
        );
        if (harvest.kind === "rejected") return { report: { kind: "files_refused", detail: harvest.reason }, dir, discarded: [] };
        const report = await runChecksOnCheckout(
          { ...this.checkCells(d), timeoutSeconds },
          RED_RUN_ROLE,
          work.environment.imageId,
          work.foundation.commit,
          dir,
          [check],
          harvest.files,
        );
        return { report, dir, discarded: harvest.discarded };
      } catch (e) {
        if (environmentErrorOf(e) !== null) throw e;
        throw new VerificationInfrastructureFault(d.task.id, purpose === "define-check" ? "define_check red run" : "probe_foundation run", { cause: e });
      }
    };
    return {
      fileWritten: (path) => work.recorder.fileWritten(path),
      probe: async (command, timeoutSeconds): Promise<FoundationProbe> => {
        const { report, dir } = await onFoundation({ name: "probe", command }, timeoutSeconds, "probe-foundation");
        this.deps.eventSink?.emit({
          event: "foundation_probed",
          taskId: d.task.id,
          attempt: d.task.attempt,
          command,
          ...(report.kind === "ran"
            // eslint-disable-next-line no-restricted-syntax -- policy default: event-sink telemetry only, no verdict reads it; a ran report carries its one run
            ? { exitCode: report.runs[0]?.exitCode ?? null, timedOut: report.runs[0]?.timedOut ?? false }
            : { notRun: report.kind }),
        });
        return foundationProbeOf(report, timeoutSeconds, dir);
      },
      define: async (check, timeoutSeconds) => {
        const recording = work.recorder.record(check);
        if (recording.kind === "refused") return recording;
        const { report, dir, discarded } = await onFoundation(check, timeoutSeconds, "define-check");
        const redRun: CheckRedRunPreview = redRunPreview(report, timeoutSeconds, dir);
        this.deps.eventSink?.emit({
          event: "check_defined",
          taskId: d.task.id,
          attempt: d.task.attempt,
          name: check.name,
          command: check.command,
          decides: check.decides,
          replaced: recording.replaced,
          defined: recording.defined,
          ...(redRun.kind === "ran"
            ? { exitCode: redRun.run.exitCode, timedOut: redRun.run.timedOut, rejection: redRun.rejection }
            : redRun.kind === "files_refused"
              ? { filesRefused: redRun.detail }
              : { productChanged: redRun.detail }),
          ...(discarded.length > 0 ? { discarded } : {}),
        });
        return { ...recording, redRun, discarded, undecided: work.recorder.undecided() };
      },
    };
  }

  /**
   * The delivered sweep, before every dispatch of an implementation task and before any model is
   * called (ADR-074 addendum 2 d74 A), once revalidateOnBaseline has trusted them: the task's stored
   * checks run on main in a CI cell from this dispatch's image. Every one passing: the task's work may be on main already, whoever delivered
   * it, and deliveredBeforeModel decides it by the environment's test, the regression suite and those
   * checks on main (d67 b, d68 a). Any failing: null, and the dispatch goes on; partial progress is
   * not staleness. A run that could not run at all is environment-blocked.
   */
  async sweepDelivered(d: VerifiedDispatch, stored: TaskChecks): Promise<ExecutionResult | null> {
    const { eventSink } = this.deps;
    const { task, sessionId, workDir, targetProjectPath } = d;
    let onMain: CheckRunReport;
    let main: string;
    try {
      main = await mainCommit(targetProjectPath, task.id);
      onMain = await runChecksOnCheckout(
        this.checkCells(d),
        RED_RUN_ROLE,
        cellImageOf(d.environment),
        main,
        this.checkoutDir(d, "delivered-sweep"),
        stored.checks,
        stored.files,
      );
    } catch (e) {
      await cleanupWorkdir(workDir, targetProjectPath);
      return mainRunBlocked(task, sessionId, e, NO_AGENT, eventSink, "deliveredCheckRun", "delivered sweep on main");
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
      console.warn(`[${task.id}] the delivered sweep on main ${main} reached no verdict: ${describeProductChange(onMain)}`);
    }
    return allPass ? this.deliveredBeforeModel(d, stored) : null;
  }

  /**
   * Stored checks were red-run on their baseline in their check task's environment version. On a
   * dispatch from another version they are red-run again on that baseline in a CI cell from this
   * dispatch's image, by the same set rule (ADR-074 addendum 2 d74 A): every check runs to a verdict
   * and at least one fails decisively. Holding: trusted, null. Not holding, or no baseline on record
   * (a revision stored before migration 045): checks_stale before the model is called, naming both
   * versions and the check task, since such a set cannot tell the task's work from its absence and
   * the implementer could not answer for it. A red run that could not run at all is environment-blocked.
   */
  async revalidateOnBaseline(d: VerifiedDispatch, stored: TaskChecks): Promise<ExecutionResult | null> {
    const { eventSink } = this.deps;
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
            this.environmentScope(d),
            RED_RUN_ROLE,
            d.environment.imageId,
            stored.baselineCommit,
            d.environment.definition,
            this.deps.attemptPolicy.perCommandTimeoutSeconds,
          );
        } catch (e) {
          await cleanupWorkdir(workDir, targetProjectPath);
          return mainRunBlocked(task, sessionId, e, NO_AGENT, eventSink, "checkRedRun", "build on the baseline");
        }
      }
      let redRun: CheckRunReport | { readonly kind: "unbuilt"; readonly build: EnvironmentTestRun };
      if (build !== null && !environmentBuildPassed(build)) {
        redRun = { kind: "unbuilt", build };
      } else {
        try {
          redRun = await runChecksOnCheckout(
            this.checkCells(d),
            RED_RUN_ROLE,
            cellImageOf(d.environment),
            stored.baselineCommit,
            this.checkoutDir(d, "red-run"),
            stored.checks,
            stored.files,
          );
        } catch (e) {
          await cleanupWorkdir(workDir, targetProjectPath);
          return mainRunBlocked(task, sessionId, e, NO_AGENT, eventSink, "checkRedRun", "red run on the baseline");
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
    console.warn(`[${task.id}] ${stale.message}`);
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
   * image (ADR-074 addendum 2 d74 A), whatever authoring this is: the first, or one after a dispute,
   * a review or staleness. A check that times out or whose command cannot run rejects the whole
   * set; a check that passes there is kept as a guard of behaviour that already holds; the set is
   * kept only when at least one of its checks fails there decisively, and only when every vision item
   * the check task cites is decided by at least one of its checks (ADR-083). The kept revision is appended
   * to Quality's task_checks for the implementation task with the foundation as its baseline; the
   * throwaway branch is discarded either way.
   */
  async keepChecks(d: VerifiedDispatch, work: CheckAuthoring, outcome: Outcome): Promise<ExecutionResult> {
    const { eventSink } = this.deps;
    const { task, sessionId, targetProjectPath } = d;
    const { foundation } = work;
    try {
      const defined = work.recorder.checks();
      if (defined.length === 0) return this.checksRejected(d, outcome, "no check was defined with define_check", {});
      // ADR-083: which items are checked is what the stored checks decide, never what a line cites.
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
      );
      if (harvest.kind === "rejected") return this.checksRejected(d, outcome, harvest.reason, {});
      if (harvest.discarded.length > 0) {
        eventSink?.emit({ event: "check_files_discarded", taskId: task.id, attempt: task.attempt, area: checkAreaOf(work.checkedTaskId), paths: harvest.discarded });
      }

      let redRun: CheckRunReport;
      try {
        redRun = await runChecksOnCheckout(
          this.checkCells(d),
          RED_RUN_ROLE,
          work.environment.imageId,
          foundation.commit,
          this.checkoutDir(d, "red-run"),
          defined,
          harvest.files,
        );
      } catch (e) {
        return mainRunBlocked(task, sessionId, e, { outcome, agentWork: "discarded" }, eventSink, "checkRedRun", "red run on the foundation");
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
      await discardCheckWorkdir(d.workDir, targetProjectPath, work.branch);
    }
  }

  /**
   * A check author that finished `blocked` (ADR-074 addendum 2 d74 A): its reason may be that the
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
    console.log(`[${task.id}] the check author finished blocked and task ${work.checkedTaskId} is delivered on main ${onMain.main}: its checks and every suite pass there`);
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
