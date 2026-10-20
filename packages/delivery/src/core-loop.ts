import { parseProjectId } from "@ashara/shared";
import type { Logger, ProjectId } from "@ashara/shared";
import type { AnswerOutcome, ClientChangeOutcome, IntakeOutcome } from "./acl/engagement-acl.js";
import type { RosterOutcome } from "./acl/organization-acl.js";
import type { FirstPlanOutcome } from "./first-plan.js";
import type { ReplanOutcome } from "./replan.js";
import type { WorkItem } from "./domain/index.js";
import { PlanningService } from "./domain/index.js";
import type { CoreLoopDeps, CycleResult, LoopStop, TaskLanes, TaskResult } from "./types.js";
import { processTask, handleProcessingError } from "./execution.js";
import { runAcceptanceSweeps } from "./acceptance.js";
import { runTerminalSweeps } from "./terminal-sweep.js";
import { resumeInfrastructureHalts } from "./infrastructure-halts.js";
import { deploymentCapCause, projectBlockCause, projectCapCause, projectWorkCause } from "./project-halt.js";
import type { ProjectBlockCause } from "./project-halt.js";
import { releaseClearedBlocks } from "./parked-exits.js";
import { releaseBranchesOfSettledTasks } from "./settled-branches.js";

/** Failures are logged at warn by the Liaison itself, with their attempt count. */
function logIntake(logger: Logger, outcome: IntakeOutcome): void {
  if (outcome.kind === "recorded") {
    logger.info(
      "delivery.intake-recorded",
      `tender ${outcome.tenderId}: vision v1 written for project ${outcome.projectId}, ` +
        `${outcome.questions} question(s) posted; reading confirmation: ${outcome.confirmation}`,
      { projectId: outcome.projectId, tenderId: outcome.tenderId, questions: outcome.questions },
    );
  }
}

/** Failures, a blocked project and an answer that answers nothing are logged at warn by the Liaison itself. */
function logAnswer(logger: Logger, outcome: AnswerOutcome): void {
  if (outcome.kind === "stated") {
    const replan = outcome.replanRequested
      ? "; the plan relied on it, so the tasks citing it are held until its plan is revised"
      : "";
    logger.info(
      "delivery.answer-stated",
      `answer ${outcome.answerId}: ${outcome.verdict} assumption ${outcome.assumptionKey} of project ` +
        `${outcome.projectId}, now Stated in vision v${outcome.visionVersion}${replan}`,
      {
        projectId: outcome.projectId,
        answerId: outcome.answerId,
        assumptionKey: outcome.assumptionKey,
        visionVersion: outcome.visionVersion,
        replanRequested: outcome.replanRequested,
      },
    );
  }
}

/** Failures and a blocked project are logged at warn by the Liaison itself. */
function logChange(logger: Logger, outcome: ClientChangeOutcome): void {
  if (outcome.kind !== "recorded") return;
  const { revision } = outcome;
  const own =
    revision.status === "applied"
      ? `applied as vision v${revision.visionVersion} (${revision.direction})`
      : revision.status === "proposed"
        ? `held for the client's confirmation (${revision.direction}; ${revision.pushback.reasons.map((r) => r.kind).join(", ")})`
        : "no change of its own";
  logger.info(
    "delivery.client-change-read",
    `change ${outcome.changeId}: ${own}${outcome.confirmed.length === 0 ? "" : `; confirmed ${outcome.confirmed.join(", ")}`}; impact note posted`,
    { projectId: outcome.projectId, changeId: outcome.changeId, status: revision.status, confirmed: outcome.confirmed.length },
  );
}

/** A refused roster is logged at warn by the roster step itself, with the violations, and halts its project here. */
function logRoster(logger: Logger, outcome: RosterOutcome): void {
  if (outcome.kind === "recorded") {
    logger.info(
      "delivery.roster-recorded",
      `roster revision ${outcome.revision} recorded, ${outcome.roles.length} role(s): ${outcome.roles.join(", ")}`,
      { projectId: outcome.projectId, revision: outcome.revision, roles: outcome.roles },
    );
  }
}

/** Failures are logged at warn by the planner itself, with their attempt count. */
function logFirstPlan(logger: Logger, outcome: FirstPlanOutcome): void {
  if (outcome.kind === "planned") {
    logger.info("delivery.first-plan-written", `first plan written, ${outcome.epics} epic(s), ${outcome.tasks} task(s)`, {
      projectId: outcome.projectId,
      epics: outcome.epics,
      tasks: outcome.tasks,
    });
  }
}

/** A revision is logged by the replanner; failures and blocks at warn there, with their attempt count. */
function logReplan(logger: Logger, outcome: ReplanOutcome): void {
  if (outcome.kind === "revised") {
    logger.info(
      "delivery.plan-revised",
      `plan revision ${outcome.revision} (${outcome.cause}), ${outcome.tasks} new task(s), ` +
        `${outcome.superseded} superseded${outcome.newEnvironment ? ", environment set up again" : ""}`,
      { projectId: outcome.projectId, revision: outcome.revision, cause: outcome.cause, tasks: outcome.tasks, superseded: outcome.superseded },
    );
  }
}

/**
 * How one step ended: it ran, with its value; a project's spend-cap refusal ended it (that project is
 * halted, and the step's other subjects run next cycle); or the deployment's cap stopped the loop.
 */
type StepEnd<T> = { readonly kind: "ran"; readonly value: T } | { readonly kind: "refused" } | { readonly kind: "stop"; readonly stop: LoopStop };

/** A step of model calls, with the deployment's cap checked after it: its outcomes, or the cap's stop. */
type StepRun<T> = { readonly kind: "ran"; readonly outcomes: readonly T[] } | { readonly kind: "stop"; readonly stop: LoopStop };

export class CoreLoop {
  private readonly deps: CoreLoopDeps;

  constructor(deps: CoreLoopDeps) {
    this.deps = deps;
  }

  async runCycle(): Promise<CycleResult> {
    const { deps } = this;

    // The client's stops first, even at the spend cap (no LLM call): a project
    // stopped here is not active, so no step below takes it in, plans it,
    // reports on it or dispatches its tasks. Nothing of this process is running
    // for it now: the previous cycle awaited every task it dispatched.
    const stops = await this.takeClientStops();
    if (stops !== null) return this.haltAtCap(stops);

    // The stack a Sprint 0 task merged in an earlier cycle (or before a restart) chose: an
    // Inferred assumption in a new vision version and one report to the client. No LLM call,
    // so before the spend-cap check.
    const choices = await this.step("stack-choice", () => deps.stackChoices.runPending());
    if (choices.kind === "stop") return this.haltAtCap(choices.stop);
    for (const choice of choices.kind === "ran" ? choices.value : []) {
      if (choice.kind !== "project-blocked" && choice.kind !== "step-faulted") {
        const version = choice.kind === "recorded" ? ` as vision v${choice.visionVersion}` : "";
        deps.logger.info("delivery.stack-choice", `${choice.kind}${version}`, { projectId: choice.projectId, outcome: choice.kind });
      }
    }

    // A project halted on infrastructure resumes by itself once the substrate probe passes (one
    // probe per cycle while any is halted, no LLM call), before the reports, so its resumption is
    // told this cycle. Only a halt already told is resumed: one written late in the previous cycle
    // is reported below first, and resumes from the next cycle on.
    const resumed = await this.step("infrastructure-resume", () => resumeInfrastructureHalts(deps.projectRepo, deps.infrastructureProbe, deps.containment, deps.logger));
    if (resumed.kind === "stop") return this.haltAtCap(resumed.stop);

    // Each stop and halt episode still owed one gets its terminal sweep on main (no LLM call), before
    // the stop's and the halt's report, so each guarantee's evidence on the last commit is on record
    // when it is told.
    const terminal = await this.sweepTerminals();
    if (terminal !== null) return this.haltAtCap(terminal);
    const stopReports = await this.postStopReports();
    if (stopReports !== null) return this.haltAtCap(stopReports);

    // Halts recorded in an earlier cycle (or before a restart) and a project's return to work: one
    // plain report each to the client. No LLM call, so before the spend-cap check: a project the
    // budget cap halted is told so.
    const blockReports = await this.postBlockReports();
    if (blockReports !== null) return this.haltAtCap(blockReports);
    // A project whose model requests run ahead of its finished work is warned once per zone and plan
    // revision, from the ledger's rows (no LLM call), so the warning reaches the client and the
    // operator before the budget halts the project.
    const warnings = await this.step("burn-warning", () => deps.burnWarnings.runPending());
    if (warnings.kind === "stop") return this.haltAtCap(warnings.stop);
    for (const warning of warnings.kind === "ran" ? warnings.value : []) {
      if (warning.kind !== "step-faulted") {
        deps.logger.info("delivery.burn-warning", `${warning.zone} warning ${warning.kind}`, { projectId: warning.projectId, zone: warning.zone, outcome: warning.kind });
      }
    }
    // An acceptance recorded before a restart, or before the cap stopped the loop, is told here.
    const delivered = await this.postDeliveredReports();
    if (delivered !== null) return this.haltAtCap(delivered);

    // Every step below makes LLM calls, each admitted by Finance's spend cap. A cycle at the cap
    // releases what the previous cycle's attempts held inside haltAtCap.
    const atCap = await deps.spendCap.deploymentStop();
    if (atCap) return this.haltAtCap(atCap);
    const held = await this.releaseHeld();
    if (held.kind === "stop") return this.haltAtCap(held.stop);

    // Tenders first: a project's intake comes before any work on it.
    const intake = await this.stepThenCap("liaison-intake", () => deps.liaisonIntake.runPending());
    if (intake.kind === "stop") return this.haltAtCap(intake.stop);
    for (const outcome of intake.outcomes) logIntake(deps.logger, outcome);

    // Then the client's answers, before planning: one read now appends the vision version
    // the first plan is made from. One that changes an assumption an existing plan was
    // built on is a correction: it holds the tasks citing that assumption (correction_holds), which the
    // gate below never dispatches, while the project's other tasks go on, until the replanning step
    // replaces them.
    const answers = await this.readAnswers();
    if (answers !== null) return this.haltAtCap(answers);
    // Then the client's changes of direction, each read into operations on the contract in force and
    // answered with its impact note this cycle: applied as the next vision version, holding the tasks
    // citing a key it affects as answers do, or held for the client's confirmation when the Liaison
    // pushes back.
    const changes = await this.stepThenCap("client-change", () => deps.clientChanges.runPending());
    if (changes.kind === "stop") return this.haltAtCap(changes.stop);
    for (const outcome of changes.outcomes) logChange(deps.logger, outcome);

    // Then a roster for each project with vision v1 and none: first planning
    // requires one, since every planned task gets its owning role.
    const rosters = await this.stepThenCap("roster", () => deps.rosterDerivation.runPending());
    if (rosters.kind === "stop") return this.haltAtCap(rosters.stop);
    for (const outcome of rosters.outcomes) {
      // Organization refuses a roster it cannot derive; the project's halt is Delivery's,
      // blamed by the refusal's cause chain: a ladder run out is the model's failure, an unreadable
      // vision Ashara's own.
      if (outcome.kind === "refused") await this.halt(outcome.projectId, projectBlockCause(outcome.refusal.error), "roster");
      logRoster(deps.logger, outcome);
    }

    // Answers posted while the roster was derived are read before the first plan, so it is made
    // from the vision they state.
    const beforePlan = await this.readAnswers();
    if (beforePlan !== null) return this.haltAtCap(beforePlan);

    // Then a first plan for each project that has a vision, a roster and no work items,
    // and the Liaison's report on each recorded planning outcome. Both before
    // gating, so a plan written this cycle can be dispatched this cycle; a plan whose report's post
    // faulted is not dispatched until a retry posts it (ProjectRepository.listActiveIds).
    // A project whose own record is bad is blocked inside each step, logged at
    // warn there, and skipped; any other failure of one project is contained to it (containEach).
    const plans = await this.stepThenCap("first-plan", () => deps.firstPlanning.runPending());
    if (plans.kind === "stop") return this.haltAtCap(plans.stop);
    for (const outcome of plans.outcomes) logFirstPlan(deps.logger, outcome);
    // Answers posted while the first plan was being written are read before any of its tasks is
    // dispatched: one that changes an assumption the plan relied on holds the tasks citing it, the
    // revision below replaces them in this cycle, and the gate never dispatches the work it replaces.
    const afterPlan = await this.readAnswers();
    if (afterPlan !== null) return this.haltAtCap(afterPlan);
    // Then a revision for each project's awaited corrections, once no task citing a key they affect
    // is in progress, replacing only that work; and a repair of each plan a given-up task stopped
    // (the gate dispatches none of that project's tasks meanwhile, so no dependent of a given-up task
    // waits on anyone), once no task of it is in progress: the previous cycle awaited every task it
    // dispatched, so in-flight work has finished before its plan is revised. Only Tasks count: the
    // plan's Epic stays InProgress while any child is open, and the revision supersedes it with the
    // open tasks it held. The Liaison's report on the revision follows with the other planning reports.
    const replans = await this.stepThenCap("replan", () => deps.replanning.runPending());
    if (replans.kind === "stop") return this.haltAtCap(replans.stop);
    for (const outcome of replans.outcomes) logReplan(deps.logger, outcome);
    const planReports = await this.postPlanReports();
    if (planReports !== null) return this.haltAtCap(planReports);

    // Every Blocked task takes its exit (Completed, Pending or given up) before the gate reads them.
    const released = await this.step("parked-exits", () =>
      releaseClearedBlocks({
        workItemRepo: deps.workItemRepo,
        eventStore: deps.eventStore,
        projects: deps.projectRepo,
        workdirBase: deps.config.workdirBase,
        containment: deps.containment,
        logger: deps.logger,
      }),
    );
    if (released.kind === "stop") return this.haltAtCap(released.stop);

    // A project with every task settled and a goal task done is swept on main (no LLM call): Accepted
    // and told so, or a defect whose repair the next cycle's replanning plans.
    const swept = await this.step("acceptance", () => runAcceptanceSweeps(deps));
    if (swept.kind === "stop") return this.haltAtCap(swept.stop);
    const deliveredAfterSweep = await this.postDeliveredReports();
    if (deliveredAfterSweep !== null) return this.haltAtCap(deliveredAfterSweep);

    const gated = await this.step("gate", () => PlanningService.gate(deps.workItemRepo, deps.projectRepo, deps.eventStore, deps.containment, deps.logger));
    if (gated.kind === "stop") return this.haltAtCap(gated.stop);
    if (gated.kind === "refused" || gated.value.available.length === 0) return { tasksProcessed: 0, results: [], stop: null };

    const batch = PlanningService.select(gated.value.available, deps.config.maxBatchSize, gated.value.unlockWeights);

    // Each task gets its own worktree (execution-infra's worktree.ts creates per-task branches),
    // so concurrent execution is safe at the process boundary. Every LLM call a
    // task makes is admitted by the spend cap; a refused call ends that task's
    // attempt and returns the item to Pending: a project refusal has already
    // blocked the project, and a deployment refusal stops the loop here.
    const settled = await deps.taskLanes(batch, (task) => processTask(deps, task));
    const results: TaskResult[] = [];
    let refusedAtDeployment: LoopStop | null = null;
    for (const [i, s] of settled.entries()) {
      const task: WorkItem = batch[i];
      const result = s.status === "fulfilled" ? s.value : await handleProcessingError(deps, task, s.reason);
      if (result.status === "refused" && result.refusal.kind === "deployment") {
        refusedAtDeployment ??= { reason: result.refusal.reason, spend: result.refusal.spend };
      }
      results.push(result);
    }

    const completed = results.filter((r) => r.status === "completed").length;
    const failed = results.filter((r) => r.status === "failed").length;
    const refused = results.filter((r) => r.status === "refused").length;
    const interrupted = results.filter((r) => r.status === "interrupted").length;
    deps.cycleLog.emit({ event: "cycle_complete", tasksProcessed: batch.length, completed, failed, refused, interrupted });

    const stop = refusedAtDeployment ?? (await deps.spendCap.deploymentStop());
    if (stop) return { ...(await this.haltAtCap(stop)), tasksProcessed: batch.length, results };
    return { tasksProcessed: batch.length, results, stop: null };
  }

  /**
   * What runs once a cycle has stopped the loop (the deployment's spend cap): only the client's
   * stops, each recorded and answered with no LLM call, so a stop sent while the loop is halted holds,
   * the release of what attempts held, and the block, delivered and plan reports still due. A project stopped here
   * stays stopped when the halt is lifted: the owner's unblock admits only a blocked project.
   */
  async runHaltedCycle(): Promise<void> {
    // The loop is already stopped at the cap: a stop any of these returns is that same stop.
    await this.takeClientStops();
    await this.releaseHeld();
    // A stop taken here, and a halt recorded at the cap, is owed its terminal sweep (no LLM call)
    // before its report; no full cycle runs again in this process to sweep it.
    await this.sweepTerminals();
    await this.postStopReports();
    // A report whose post faulted is contained to its project and retried after a backoff, and a plan
    // written in the cycle that reached the cap is reported after its block report; no full cycle runs
    // again in this process, so both are here. No report makes an LLM call.
    await this.postBlockReports();
    await this.postDeliveredReports();
    await this.postPlanReports();
  }

  /**
   * What every attempt held on the host is released, whichever path ended it: the cells a failed
   * teardown left, then every settled task's branches. Called only where no attempt is in flight:
   * before a full cycle's dispatch (the previous cycle awaited every attempt it dispatched), in the
   * cycle that stops at the cap (haltAtCap, after its batch settled), and on each halted cycle,
   * which dispatches nothing and retries a release the stopping cycle failed. No LLM call. The
   * branch release is a cycle step like any other: a stop it returns is the caller's to act on.
   */
  private async releaseHeld(): Promise<StepEnd<unknown>> {
    await this.deps.heldCells.release();
    return this.step("settled-branches", () =>
      releaseBranchesOfSettledTasks({
        workItemRepo: this.deps.workItemRepo,
        projects: this.deps.projectRepo,
        workdirBase: this.deps.config.workdirBase,
        logger: this.deps.logger,
      }),
    );
  }

  /** The client's stops, each taken once; the deployment cap's stop when a refusal named it, else null. */
  private async takeClientStops(): Promise<LoopStop | null> {
    const stops = await this.step("client-stop", () => this.deps.clientStops.runPending());
    if (stops.kind === "stop") return stops.stop;
    for (const stop of stops.kind === "ran" ? stops.value : []) {
      if (stop.kind !== "step-faulted") this.deps.logger.info("delivery.client-stop", `stop ${stop.stopId}: ${stop.kind}`, { projectId: stop.projectId, stopId: stop.stopId, outcome: stop.kind });
    }
    return null;
  }

  /** The stop reports due, each posted once; the deployment cap's stop when a refusal named it, else null. */
  private async postStopReports(): Promise<LoopStop | null> {
    const reports = await this.step("client-stop-report", () => this.deps.clientStops.reportPending());
    if (reports.kind === "stop") return reports.stop;
    for (const report of reports.kind === "ran" ? reports.value : []) {
      if (report.kind !== "step-faulted") this.deps.logger.info("delivery.client-stop", `stop ${report.stopId}: ${report.kind}`, { projectId: report.projectId, stopId: report.stopId, outcome: report.kind });
    }
    return null;
  }

  /**
   * The terminal sweep of each stop and halt episode owed one, each contained to its terminal; the
   * deployment cap's stop when a refusal named it, else null.
   */
  private async sweepTerminals(): Promise<LoopStop | null> {
    const { deps } = this;
    const swept = await this.step("terminal-sweep", () =>
      runTerminalSweeps({ terminalSweeps: deps.terminalSweeps, terminalSweeper: deps.terminalSweeper, containment: deps.containment, logger: deps.logger }),
    );
    return swept.kind === "stop" ? swept.stop : null;
  }

  /** The client's answers not yet read, each read once; the spend cap's stop when a call was refused, else null. */
  private async readAnswers(): Promise<LoopStop | null> {
    const answers = await this.stepThenCap("liaison-answers", () => this.deps.liaisonAnswers.runPending());
    if (answers.kind === "stop") return answers.stop;
    for (const outcome of answers.outcomes) logAnswer(this.deps.logger, outcome);
    return null;
  }

  /**
   * A project whose report failed is logged at warn by the Liaison, recorded on its sweep and retried;
   * the cycle goes on. The deployment cap's stop when a refusal named it, else null.
   */
  private async postDeliveredReports(): Promise<LoopStop | null> {
    const reports = await this.step("delivered-report", () => this.deps.deliveredReports.runPending());
    if (reports.kind === "stop") return reports.stop;
    for (const report of reports.kind === "ran" ? reports.value : []) {
      if (report.kind !== "failed") this.deps.logger.info("delivery.delivered-report", `delivered report ${report.kind}`, { projectId: report.projectId, outcome: report.kind });
    }
    return null;
  }

  /**
   * The planning outcomes not yet reported, each posted once; a project whose record is bad is
   * blocked by the Liaison. The deployment cap's stop when a refusal named it, else null.
   */
  private async postPlanReports(): Promise<LoopStop | null> {
    const reports = await this.step("plan-report", () => this.deps.planReports.runPending());
    if (reports.kind === "stop") return reports.stop;
    for (const report of reports.kind === "ran" ? reports.value : []) {
      if (report.kind !== "project-blocked" && report.kind !== "step-faulted") {
        this.deps.logger.info("delivery.plan-report", `${report.subject} report ${report.kind}`, { projectId: report.projectId, subject: report.subject, outcome: report.kind });
      }
    }
    return null;
  }

  /** The block reports due, each posted once; the deployment cap's stop when a refusal named it, else null. */
  private async postBlockReports(): Promise<LoopStop | null> {
    const reports = await this.step("block-report", () => this.deps.blockReports.runPending());
    if (reports.kind === "stop") return reports.stop;
    for (const report of reports.kind === "ran" ? reports.value : []) {
      if (report.kind !== "step-faulted") {
        this.deps.logger.info("delivery.block-report", `${report.subject} report ${report.kind}`, { projectId: report.projectId, subject: report.subject, outcome: report.kind });
      }
    }
    return null;
  }

  /**
   * The deployment's spend cap was reached: every active project halts at the cap,
   * each with its one report posted now, before the loop stops, since no later cycle of this run
   * posts it. A project's exit is the owner's raise of the cap. The loop stops with the cap's
   * own reason.
   */
  private async haltAtCap(stop: LoopStop): Promise<CycleResult> {
    // The runner runs no full cycle after this one, so a task settled in it is released here; the
    // loop stops on `stop`, so a stop the release returns is the cap's too.
    await this.releaseHeld();
    const halted = await this.deps.projectRepo.blockAllActive(deploymentCapCause(stop));
    if (halted.length > 0) {
      this.deps.logger.info("delivery.deployment-cap-halt", `${halted.length} project(s) halted at the deployment's spend cap: ${stop.reason}`, { projects: halted });
    }
    // The loop stops here on `stop`: a stop the sweeps' or the reports' step returns is the cap's too.
    await this.sweepTerminals();
    await this.postStopReports();
    await this.postBlockReports();
    return stopped(stop);
  }

  /**
   * Halts the project under `cause` through Delivery's guard, the one writer of a project halt,
   * in a trace of its own carrying the project, a child of whatever trace reached the halt.
   */
  private halt(projectId: ProjectId, cause: ProjectBlockCause, step: string): Promise<void> {
    return this.deps.logger.scope({ projectId, trace: "new" }, async () => {
      const result = await this.deps.projectRepo.block(projectId, cause);
      this.deps.logger.info("delivery.project-blocked", `project ${projectId} ${result}: ${cause.errorClass}: ${cause.reason}`, {
        projectId,
        step,
        category: cause.category,
        errorClass: cause.errorClass,
        result,
      });
    });
  }

  /**
   * Runs one step of the cycle; every step runs through here. A spend-cap refusal thrown out of the
   * step ends the step: a project refusal blocks its project here (Finance refuses, Delivery halts),
   * and the step's remaining projects run next cycle; a deployment refusal stops the loop with the
   * refusal's own reason. Any other error throws out of the cycle: a step contains each subject's
   * failure itself (containEach records it on the subject and retries it after a backoff), so what
   * reaches here is a failure of the step as a whole, such as recording a fault.
   */
  private async step<T>(name: string, run: () => Promise<T>): Promise<StepEnd<T>> {
    try {
      return { kind: "ran", value: await run() };
    } catch (err) {
      const refusal = this.deps.spendCap.refusalOf(err);
      // A step's calls serve no task (only a dispatch's do), so a task's spent budget reaching a
      // step is no refusal a step can route: it throws out of the cycle like any other error.
      if (refusal === null || refusal.kind === "task_work") throw err;
      if (refusal.kind === "deployment") return { kind: "stop", stop: { reason: refusal.reason, spend: refusal.spend } };
      const projectId = parseProjectId(refusal.projectId, "spend refusal projectId");
      if (refusal.kind === "project_work") {
        await this.halt(projectId, projectWorkCause(refusal), `work_budget ${name}`);
        this.deps.logger.info("delivery.step-refused", `${name}: the step's other projects run next cycle`, { step: name, projectId, category: "work_budget" });
        return { kind: "refused" };
      }
      await this.halt(projectId, projectCapCause(refusal), `budget_cap ${name}`);
      this.deps.logger.info("delivery.step-refused", `${name}: the step's other projects run next cycle`, { step: name, projectId, category: "budget_cap" });
      return { kind: "refused" };
    }
  }

  /** Runs a step of model calls (step) and checks the deployment cap after it. */
  private async stepThenCap<T>(name: string, run: () => Promise<readonly T[]>): Promise<StepRun<T>> {
    const ended = await this.step(name, run);
    if (ended.kind === "stop") return ended;
    const stop = await this.deps.spendCap.deploymentStop();
    if (stop) return { kind: "stop", stop };
    return { kind: "ran", outcomes: ended.kind === "ran" ? ended.value : [] };
  }
}

/** The policy default: every task of the batch at once, each settled on its own. */
export const concurrentTaskLanes: TaskLanes = (items, run) => Promise.allSettled(items.map(run));

function stopped(stop: LoopStop): CycleResult {
  return { tasksProcessed: 0, results: [], stop };
}
