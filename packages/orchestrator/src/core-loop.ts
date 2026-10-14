import { SPEND_CAP_ERROR_CLASS } from "@ashara/shared";
import type { AnswerOutcome, IntakeOutcome } from "./acl/engagement-acl.js";
import type { RosterOutcome } from "./acl/organization-acl.js";
import type { FirstPlanOutcome, ReplanOutcome, WorkItem } from "./acl/planning-acl.js";
import { PlanningService } from "./acl/planning-acl.js";
import type { CoreLoopDeps, CycleResult, LoopStop, TaskLanes, TaskResult } from "./types.js";
import { processTask, handleProcessingError } from "./execution.js";
import { runAcceptanceSweeps } from "./acceptance.js";
import { resumeInfrastructureHalts } from "./infrastructure-halts.js";
import { releaseClearedBlocks } from "./parked-exits.js";

/** Failures are logged at warn by the Liaison itself, with their attempt count. */
function logIntake(outcome: IntakeOutcome): void {
  if (outcome.kind === "recorded") {
    console.log(
      `[liaison-intake] tender ${outcome.tenderId}: vision v1 written for project ${outcome.projectId}, ` +
        `${outcome.questions} question(s) posted`,
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

/** A blocked project is logged at warn by the roster step itself, with the violations. */
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
    await this.takeClientStops();

    // The stack a Sprint 0 task merged in an earlier cycle (or before a restart) chose: an
    // Inferred assumption in a new vision version and one report to the client. No LLM call,
    // so before the spend-cap check.
    for (const choice of await deps.stackChoices.runPending()) {
      if (choice.kind !== "project-blocked") {
        const version = choice.kind === "recorded" ? ` as vision v${choice.visionVersion}` : "";
        console.log(`[liaison-stack-choice] project ${choice.projectId}: ${choice.kind}${version}`);
      }
    }

    // A project halted on infrastructure resumes by itself once the substrate probe passes (one
    // probe per cycle while any is halted, no LLM call), before the reports, so its resumption is
    // told this cycle. Only a halt already told is resumed: one written late in the previous cycle
    // is reported below first, and resumes from the next cycle on.
    await resumeInfrastructureHalts(deps.projectRepo, deps.infrastructureProbe);

    // Halts recorded in an earlier cycle (or before a restart) and a project's return to work: one
    // plain report each to the client. No LLM call, so before the spend-cap check: a project the
    // budget cap halted is told so.
    await this.postBlockReports();
    // An acceptance recorded before a restart, or before the cap stopped the loop, is told here.
    await this.postDeliveredReports();

    // Every step below makes LLM calls, each admitted by Finance's spend cap.
    const atCap = await deps.spendCap.deploymentStop();
    if (atCap) return this.haltAtCap(atCap);

    // Tenders first: a project's intake comes before any work on it.
    const intake = await this.step("liaison-intake", () => deps.liaisonIntake.runPending());
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
    const rosters = await this.step("roster", () => deps.rosterDerivation.runPending());
    if (rosters.kind === "stop") return this.haltAtCap(rosters.stop);
    for (const outcome of rosters.outcomes) logRoster(outcome);

    // Answers posted while the roster was derived are read before the first plan, so it is made
    // from the vision they state (W11 D5).
    const beforePlan = await this.readAnswers();
    if (beforePlan !== null) return this.haltAtCap(beforePlan);

    // Then a first plan for each project that has a vision, a roster and no work items,
    // and the Liaison's report on each recorded planning outcome. Both before
    // gating, so a plan written this cycle can be dispatched this cycle.
    // A project whose own record is bad is blocked inside each step, logged at
    // warn there, and skipped; any other failure throws out of the cycle.
    const plans = await this.step("first-plan", () => deps.firstPlanning.runPending());
    if (plans.kind === "stop") return this.haltAtCap(plans.stop);
    for (const outcome of plans.outcomes) logFirstPlan(outcome);
    // Answers posted while the first plan was being written are read before any of its tasks is
    // dispatched (W11 D5): one that changes an assumption the plan relied on flags the project, the
    // revision below replans it in this cycle, and the gate never dispatches the plan it replaces.
    const afterPlan = await this.readAnswers();
    if (afterPlan !== null) return this.haltAtCap(afterPlan);
    // Then a revision of each flagged plan, and a repair of each plan a given-up task stopped (ADR-074
    // addendum 2 d74 D, d76; the gate dispatches neither project's tasks meanwhile, so no dependent of a
    // given-up task waits on anyone), whose project has no task in progress: the previous
    // cycle awaited every task it dispatched, so in-flight work has finished before its plan is
    // revised. Only Tasks count: the plan's Epic stays InProgress while any child is open, and the
    // revision supersedes it with the open tasks. The Liaison's report on the revision follows with the other planning reports.
    const replans = await this.step("replan", () => deps.replanning.runPending());
    if (replans.kind === "stop") return this.haltAtCap(replans.stop);
    for (const outcome of replans.outcomes) logReplan(outcome);
    for (const report of await deps.planReports.runPending()) {
      if (report.kind !== "project-blocked") {
        console.log(`[liaison-report] project ${report.projectId}: ${report.subject} report ${report.kind}`);
      }
    }

    // Every Blocked task takes its exit (Completed, Pending or given up) before the gate reads them.
    await releaseClearedBlocks({
      workItemRepo: deps.workItemRepo,
      eventStore: deps.eventStore,
      projects: deps.projectRepo,
    });

    // A project with every task settled and a goal task done is swept on main (no LLM call): Accepted
    // and told so, or a defect whose repair the next cycle's replanning plans.
    await runAcceptanceSweeps(deps);
    await this.postDeliveredReports();

    const eligible = await PlanningService.gate(deps.workItemRepo, deps.projectRepo, deps.eventStore);
    if (eligible.length === 0) return { tasksProcessed: 0, results: [], stop: null };

    const weights = await PlanningService.unlockWeights(deps.workItemRepo, eligible);
    const batch = PlanningService.select(eligible, deps.config.maxBatchSize, weights);

    // Each task gets its own worktree (workspace.ts creates per-task branches),
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
        refusedAtDeployment ??= { reason: result.refusal.reason };
      }
      results.push(result);
    }

    const completed = results.filter((r) => r.status === "completed").length;
    const failed = results.filter((r) => r.status === "failed").length;
    const refused = results.filter((r) => r.status === "refused").length;
    const interrupted = results.filter((r) => r.status === "interrupted").length;
    deps.eventLogger?.emit({ event: "cycle_complete", tasksProcessed: batch.length, completed, failed, refused, interrupted });

    const stop = refusedAtDeployment ?? (await deps.spendCap.deploymentStop());
    if (stop) return { ...(await this.haltAtCap(stop)), tasksProcessed: batch.length, results };
    return { tasksProcessed: batch.length, results, stop: null };
  }

  /**
   * What runs once a cycle has stopped the loop (the deployment's spend cap): only the client's
   * stops, each recorded and answered with no LLM call (smoke1 D3). A project stopped here stays
   * stopped when the halt is lifted: the owner's unblock admits only a blocked project.
   */
  async runHaltedCycle(): Promise<void> {
    await this.takeClientStops();
  }

  private async takeClientStops(): Promise<void> {
    for (const stop of await this.deps.clientStops.runPending()) {
      console.log(`[liaison-stop] stop ${stop.stopId}: project ${stop.projectId} ${stop.kind}`);
    }
  }

  /** The client's answers not yet read, each read once; the spend cap's stop when a call was refused, else null. */
  private async readAnswers(): Promise<LoopStop | null> {
    const answers = await this.step("liaison-answers", () => this.deps.liaisonAnswers.runPending());
    if (answers.kind === "stop") return answers.stop;
    for (const outcome of answers.outcomes) logAnswer(outcome);
    return null;
  }

  private async postDeliveredReports(): Promise<void> {
    for (const report of await this.deps.deliveredReports.runPending()) {
      console.log(`[liaison-delivered-report] project ${report.projectId}: delivered report ${report.kind}`);
    }
  }

  private async postBlockReports(): Promise<void> {
    for (const report of await this.deps.blockReports.runPending()) {
      console.log(`[liaison-block-report] project ${report.projectId}: ${report.subject} report ${report.kind}`);
    }
  }

  /**
   * The deployment's spend cap was reached (design P14): every active project halts at the cap,
   * each with its one report posted now, before the loop stops, since no later cycle of this run
   * posts it. A project's exit is the owner's raise of the cap (X1). The loop stops with the cap's
   * own reason.
   */
  private async haltAtCap(stop: LoopStop): Promise<CycleResult> {
    const halted = await this.deps.projectRepo.blockAllActive({
      category: "budget_cap",
      errorClass: SPEND_CAP_ERROR_CLASS.deployment,
      reason: stop.reason,
    });
    if (halted.length > 0) console.warn(`[budget_cap] ${halted.length} project(s) halted at the deployment's spend cap: ${stop.reason}`);
    await this.postBlockReports();
    return stopped(stop);
  }

  /**
   * Runs one step and checks the deployment cap after it. A spend-cap refusal
   * thrown out of the step ends the step: a project refusal has blocked its
   * project already, and the step's remaining projects run next cycle; a
   * deployment refusal stops the loop with the refusal's own reason. Any other
   * error throws out of the cycle.
   */
  private async step<T>(name: string, run: () => Promise<readonly T[]>): Promise<StepRun<T>> {
    let outcomes: readonly T[] = [];
    try {
      outcomes = await run();
    } catch (err) {
      const refusal = this.deps.spendCap.refusalOf(err);
      if (refusal === null) throw err;
      if (refusal.kind === "deployment") return { kind: "stop", stop: { reason: refusal.reason } };
      console.warn(
        `[budget_cap] ${name}: project ${refusal.projectId} is blocked at its spend cap; ` +
          `the step's other projects run next cycle. ${refusal.reason}`,
      );
    }
    const stop = await this.deps.spendCap.deploymentStop();
    return stop ? { kind: "stop", stop } : { kind: "ran", outcomes };
  }
}

/** The policy default: every task of the batch at once, each settled on its own. */
export const concurrentTaskLanes: TaskLanes = (items, run) => Promise.allSettled(items.map(run));

function stopped(stop: LoopStop): CycleResult {
  return { tasksProcessed: 0, results: [], stop };
}
