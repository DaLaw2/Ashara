import { parseProjectId } from "@ashara/shared";
import type { ProjectId } from "@ashara/shared";
import type { AnswerOutcome, IntakeOutcome } from "./acl/engagement-acl.js";
import type { RosterOutcome } from "./acl/organization-acl.js";
import type { FirstPlanOutcome } from "./first-plan.js";
import type { ReplanOutcome } from "./replan.js";
import type { WorkItem } from "./domain/index.js";
import { PlanningService } from "./domain/index.js";
import type { CoreLoopDeps, CycleResult, LoopStop, TaskLanes, TaskResult } from "./types.js";
import { processTask, handleProcessingError } from "./execution.js";
import { runAcceptanceSweeps } from "./acceptance.js";
import { resumeInfrastructureHalts } from "./infrastructure-halts.js";
import { deploymentCapCause, projectBlockCause, projectCapCause, projectWorkCause } from "./project-halt.js";
import type { ProjectBlockCause } from "./project-halt.js";
import { releaseClearedBlocks } from "./parked-exits.js";
import { releaseBranchesOfSettledTasks } from "./settled-branches.js";

/** Failures are logged at warn by the Liaison itself, with their attempt count. */
function logIntake(outcome: IntakeOutcome): void {
  if (outcome.kind === "recorded") {
    console.log(
      `[liaison-intake] tender ${outcome.tenderId}: vision v1 written for project ${outcome.projectId}, ` +
        `${outcome.questions} question(s) posted; reading confirmation: ${outcome.confirmation}`,
    );
  }
}

/** Failures, a blocked project and an answer that answers nothing are logged at warn by the Liaison itself. */
function logAnswer(outcome: AnswerOutcome): void {
  if (outcome.kind === "stated") {
    const replan = outcome.replanRequested
      ? "; the plan relied on it, so the project is not dispatched until its plan is revised"
      : "";
    console.log(
      `[liaison-answer] answer ${outcome.answerId}: ${outcome.verdict} assumption ${outcome.assumptionKey} of project ` +
        `${outcome.projectId}, now Stated in vision v${outcome.visionVersion}${replan}`,
    );
  }
}

/** A refused roster is logged at warn by the roster step itself, with the violations, and halts its project here. */
function logRoster(outcome: RosterOutcome): void {
  if (outcome.kind === "recorded") {
    console.log(
      `[roster] project ${outcome.projectId}: roster revision ${outcome.revision} recorded, ` +
        `${outcome.roles.length} role(s): ${outcome.roles.join(", ")}`,
    );
  }
}

/** Failures are logged at warn by the planner itself, with their attempt count. */
function logFirstPlan(outcome: FirstPlanOutcome): void {
  if (outcome.kind === "planned") {
    console.log(
      `[first-plan] project ${outcome.projectId}: first plan written, ${outcome.epics} epic(s), ${outcome.tasks} task(s)`,
    );
  }
}

/** A revision is logged by the replanner; failures and blocks at warn there, with their attempt count. */
function logReplan(outcome: ReplanOutcome): void {
  if (outcome.kind === "revised") {
    console.log(
      `[replan] project ${outcome.projectId}: plan revision ${outcome.revision} (${outcome.cause}), ${outcome.tasks} new task(s), ` +
        `${outcome.superseded} superseded${outcome.newEnvironment ? ", environment set up again" : ""}`,
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
    // The client's changes of direction, each answered once that it is kept but not applied (no
    // LLM call), so none is left unread even at the spend cap.
    const changes = await this.answerClientChanges();
    if (changes !== null) return this.haltAtCap(changes);

    // The stack a Sprint 0 task merged in an earlier cycle (or before a restart) chose: an
    // Inferred assumption in a new vision version and one report to the client. No LLM call,
    // so before the spend-cap check.
    const choices = await this.step("stack-choice", () => deps.stackChoices.runPending());
    if (choices.kind === "stop") return this.haltAtCap(choices.stop);
    for (const choice of choices.kind === "ran" ? choices.value : []) {
      if (choice.kind !== "project-blocked" && choice.kind !== "step-faulted") {
        const version = choice.kind === "recorded" ? ` as vision v${choice.visionVersion}` : "";
        console.log(`[liaison-stack-choice] project ${choice.projectId}: ${choice.kind}${version}`);
      }
    }

    // A project halted on infrastructure resumes by itself once the substrate probe passes (one
    // probe per cycle while any is halted, no LLM call), before the reports, so its resumption is
    // told this cycle. Only a halt already told is resumed: one written late in the previous cycle
    // is reported below first, and resumes from the next cycle on.
    const resumed = await this.step("infrastructure-resume", () => resumeInfrastructureHalts(deps.projectRepo, deps.infrastructureProbe, deps.containment));
    if (resumed.kind === "stop") return this.haltAtCap(resumed.stop);

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
      if (warning.kind !== "step-faulted") console.log(`[liaison-burn-warning] project ${warning.projectId}: ${warning.zone} warning ${warning.kind}`);
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
    for (const outcome of intake.outcomes) logIntake(outcome);

    // Then the client's answers, before planning: one read now appends the vision version
    // the first plan is made from. One that changes an assumption an existing plan was
    // built on records a request to revise it (replan_requests), and the gate below does not dispatch
    // the tasks of a project awaiting that revision (ProjectRepository.listActiveIds) until the replanning
    // step revises its plan.
    const answers = await this.readAnswers();
    if (answers !== null) return this.haltAtCap(answers);

    // Then a roster for each project with vision v1 and none: first planning
    // requires one, since every planned task gets its owning role.
    const rosters = await this.stepThenCap("roster", () => deps.rosterDerivation.runPending());
    if (rosters.kind === "stop") return this.haltAtCap(rosters.stop);
    for (const outcome of rosters.outcomes) {
      // Organization refuses a roster it cannot derive; the project's halt is Delivery's (O3 c),
      // blamed by the refusal's cause chain: a ladder run out is the model's failure, an unreadable
      // vision Ashara's own.
      if (outcome.kind === "refused") await this.halt(outcome.projectId, projectBlockCause(outcome.refusal.error), "roster");
      logRoster(outcome);
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
    for (const outcome of plans.outcomes) logFirstPlan(outcome);
    // Answers posted while the first plan was being written are read before any of its tasks is
    // dispatched: one that changes an assumption the plan relied on flags the project, the
    // revision below replans it in this cycle, and the gate never dispatches the plan it replaces.
    const afterPlan = await this.readAnswers();
    if (afterPlan !== null) return this.haltAtCap(afterPlan);
    // Then a revision of each flagged plan, and a repair of each plan a given-up task stopped (ADR-074
    // addendum 2 d74 D, d76; the gate dispatches neither project's tasks meanwhile, so no dependent of a
    // given-up task waits on anyone), whose project has no task in progress: the previous
    // cycle awaited every task it dispatched, so in-flight work has finished before its plan is
    // revised. Only Tasks count: the plan's Epic stays InProgress while any child is open, and the
    // revision supersedes it with the open tasks. The Liaison's report on the revision follows with the other planning reports.
    const replans = await this.stepThenCap("replan", () => deps.replanning.runPending());
    if (replans.kind === "stop") return this.haltAtCap(replans.stop);
    for (const outcome of replans.outcomes) logReplan(outcome);
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
      }),
    );
    if (released.kind === "stop") return this.haltAtCap(released.stop);

    // A project with every task settled and a goal task done is swept on main (no LLM call): Accepted
    // and told so, or a defect whose repair the next cycle's replanning plans.
    const swept = await this.step("acceptance", () => runAcceptanceSweeps(deps));
    if (swept.kind === "stop") return this.haltAtCap(swept.stop);
    const deliveredAfterSweep = await this.postDeliveredReports();
    if (deliveredAfterSweep !== null) return this.haltAtCap(deliveredAfterSweep);

    const gated = await this.step("gate", () => PlanningService.gate(deps.workItemRepo, deps.projectRepo, deps.eventStore, deps.containment));
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
   * stops and changes, each recorded and answered with no LLM call, so a stop sent while the loop is halted holds,
   * the release of what attempts held, and the block, delivered and plan reports still due. A project stopped here
   * stays stopped when the halt is lifted: the owner's unblock admits only a blocked project.
   */
  async runHaltedCycle(): Promise<void> {
    // The loop is already stopped at the cap: a stop any of these returns is that same stop.
    await this.takeClientStops();
    await this.answerClientChanges();
    await this.releaseHeld();
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
      releaseBranchesOfSettledTasks({ workItemRepo: this.deps.workItemRepo, projects: this.deps.projectRepo, workdirBase: this.deps.config.workdirBase }),
    );
  }

  /** The client's stops, each taken once; the deployment cap's stop when a refusal named it, else null. */
  private async takeClientStops(): Promise<LoopStop | null> {
    const stops = await this.step("client-stop", () => this.deps.clientStops.runPending());
    if (stops.kind === "stop") return stops.stop;
    for (const stop of stops.kind === "ran" ? stops.value : []) {
      if (stop.kind !== "step-faulted") console.log(`[liaison-stop] stop ${stop.stopId}: project ${stop.projectId} ${stop.kind}`);
    }
    return null;
  }

  /** The client's changes, each answered once; the deployment cap's stop when a refusal named it, else null. */
  private async answerClientChanges(): Promise<LoopStop | null> {
    const changes = await this.step("client-change", () => this.deps.clientChanges.runPending());
    if (changes.kind === "stop") return changes.stop;
    for (const change of changes.kind === "ran" ? changes.value : []) {
      if (change.kind === "deferred") console.log(`[liaison-change] change ${change.changeId}: project ${change.projectId} told not applied, reply ${change.replyId}`);
    }
    return null;
  }

  /** The client's answers not yet read, each read once; the spend cap's stop when a call was refused, else null. */
  private async readAnswers(): Promise<LoopStop | null> {
    const answers = await this.stepThenCap("liaison-answers", () => this.deps.liaisonAnswers.runPending());
    if (answers.kind === "stop") return answers.stop;
    for (const outcome of answers.outcomes) logAnswer(outcome);
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
      if (report.kind !== "failed") console.log(`[liaison-delivered-report] project ${report.projectId}: delivered report ${report.kind}`);
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
        console.log(`[liaison-report] project ${report.projectId}: ${report.subject} report ${report.kind}`);
      }
    }
    return null;
  }

  /** The block reports due, each posted once; the deployment cap's stop when a refusal named it, else null. */
  private async postBlockReports(): Promise<LoopStop | null> {
    const reports = await this.step("block-report", () => this.deps.blockReports.runPending());
    if (reports.kind === "stop") return reports.stop;
    for (const report of reports.kind === "ran" ? reports.value : []) {
      if (report.kind !== "step-faulted") console.log(`[liaison-block-report] project ${report.projectId}: ${report.subject} report ${report.kind}`);
    }
    return null;
  }

  /**
   * The deployment's spend cap was reached (design P14): every active project halts at the cap,
   * each with its one report posted now, before the loop stops, since no later cycle of this run
   * posts it. A project's exit is the owner's raise of the cap (X1). The loop stops with the cap's
   * own reason.
   */
  private async haltAtCap(stop: LoopStop): Promise<CycleResult> {
    // The runner runs no full cycle after this one, so a task settled in it is released here; the
    // loop stops on `stop`, so a stop the release returns is the cap's too.
    await this.releaseHeld();
    const halted = await this.deps.projectRepo.blockAllActive(deploymentCapCause(stop));
    if (halted.length > 0) console.warn(`[budget_cap] ${halted.length} project(s) halted at the deployment's spend cap: ${stop.reason}`);
    // The loop stops here on `stop`: a stop the reports' step returns is the cap's too.
    await this.postBlockReports();
    return stopped(stop);
  }

  /** Halts the project under `cause` through Delivery's guard, the one writer of a project halt (O3 c). */
  private async halt(projectId: ProjectId, cause: ProjectBlockCause, step: string): Promise<void> {
    const result = await this.deps.projectRepo.block(projectId, cause);
    console.warn(`[${step}] project ${projectId} ${result}: ${cause.errorClass}: ${cause.reason}`);
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
        console.warn(`[work_budget] ${name}: the step's other projects run next cycle`);
        return { kind: "refused" };
      }
      await this.halt(projectId, projectCapCause(refusal), `budget_cap ${name}`);
      console.warn(`[budget_cap] ${name}: the step's other projects run next cycle`);
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
