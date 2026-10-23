import { describeErrorChain, parseProjectId } from "@ashara/shared";
import type { Logger, ProjectId } from "@ashara/shared";
import { TERMINAL_KINDS } from "./acl/engagement-acl.js";
import type { AnswerOutcome, ClientChangeOutcome, IntakeOutcome, TerminalKind } from "./acl/engagement-acl.js";
import type { RosterOutcome } from "./acl/organization-acl.js";
import type { FirstPlanOutcome } from "./first-plan.js";
import type { ReplanOutcome } from "./replan-port.js";
import type { GatedWork, WorkItem } from "./domain/index.js";
import { PlanningService } from "./domain/index.js";
import type { CoreLoopDeps, CycleResult, LaneSettlement, LoopStop, TaskLanes, TaskResult } from "./types.js";
import { processTask, handleProcessingError } from "./execution/dispatch-run.js";
import { runAcceptanceSweeps } from "./acceptance.js";
import { runTerminalSweeps } from "./terminal-sweep.js";
import { resumeClientWaitHalts } from "./client-wait-halts.js";
import { resumeInfrastructureHalts } from "./infrastructure-halts.js";
import { deploymentCapCause, projectBlockCause, projectCapCause, projectWorkCause } from "./project-halt.js";
import type { ProjectBlockCause } from "./project-halt.js";
import { releaseClearedBlocks } from "./parked-exits.js";
import { releaseBranchesOfSettledTasks } from "./settled-branches.js";

// The kinds of terminal message each point of a full cycle tells, each where it can become due: a stop
// or a halt once its terminal sweep is recorded, carried into the cycle; a first planning that stopped
// and a declined contract version after the steps that write them; a delivered report after the
// acceptance sweeps. Each kind is told at one point of a full cycle, and every kind as the cap halts it.
const CARRIED_TERMINALS: readonly TerminalKind[] = ["stopped", "halted"];
const PLANNED_TERMINALS: readonly TerminalKind[] = ["planning-stopped", "declined"];
const ACCEPTED_TERMINALS: readonly TerminalKind[] = ["delivered"];

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
 * @testseam core-loop.test.ts checks every step a cycle runs is named here
 * Every step CoreLoop runs, in the order a full cycle first runs them; step and stepThenCap take
 * only these names, so a step is named here before it can run.
 */
export const CORE_LOOP_STEPS = [
  "client-stop",
  "client-receipt",
  "stack-choice",
  "infrastructure-resume",
  "client-wait-resume",
  "terminal-sweep",
  "terminal-report",
  "block-report",
  "burn-warning",
  "settled-branches",
  "liaison-intake",
  "liaison-answers",
  "client-change",
  "roster",
  "first-plan",
  "replan",
  "plan-report",
  "parked-exits",
  "acceptance",
  "gate",
] as const;

type CoreLoopStep = (typeof CORE_LOOP_STEPS)[number];

/** Why a step of model calls is left out of a halted cycle. */
const MODEL_CALLS = { excluded: "it makes model calls, which the deployment's spend cap the loop is halted at refuses" } as const;

/**
 * @testseam core-loop.test.ts checks it at runtime against the steps a cycle runs
 * Whether runHaltedCycle runs each step, or why not. A step with no model call that posts what the
 * client is owed and is left out of runHaltedCycle waits, after a cap halt, for a full cycle this
 * process never runs; the map is total over CORE_LOOP_STEPS, so a new step is classified here.
 */
export const HALTED_CYCLE_CLASSIFICATION: Readonly<Record<CoreLoopStep, "halted" | { readonly excluded: string }>> = {
  "client-stop": "halted",
  "client-receipt": "halted",
  "settled-branches": "halted",
  "block-report": "halted",
  "terminal-report": "halted",
  "plan-report": "halted",
  "terminal-sweep": "halted",
  "stack-choice": { excluded: "it records a vision version from a merged choice, a change a halted loop does not make; only a project at work has a choice due, so a project halted at the cap has its choice recorded and reported once it resumes, in a full cycle after the process restarts" },
  "infrastructure-resume": { excluded: "it returns a halted project to work, which a loop halted at the cap does not admit" },
  "client-wait-resume": { excluded: "it returns a halted project to work, which a loop halted at the cap does not admit" },
  "parked-exits": { excluded: "it moves Blocked tasks toward dispatch, and a halted cycle dispatches nothing" },
  acceptance: { excluded: "it sweeps main on cells, which is work, not a report" },
  gate: { excluded: "it selects tasks to dispatch, and a halted cycle dispatches nothing" },
  "burn-warning": { excluded: "it warns before the budget halts a project; a project halted at the cap is told so by its block report" },
  "liaison-intake": MODEL_CALLS,
  "liaison-answers": MODEL_CALLS,
  "client-change": MODEL_CALLS,
  roster: MODEL_CALLS,
  "first-plan": MODEL_CALLS,
  replan: MODEL_CALLS,
};

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

  /**
   * One full cycle, closed by the receipts of the client's messages that arrived while it ran, so a
   * message sent during a cycle is answered in it. A cycle that stopped the loop posted them in
   * haltAtCap.
   */
  async runCycle(): Promise<CycleResult> {
    const result = await this.cycleSteps();
    if (result.stop !== null) return result;
    const stop = await this.postReceipts("read-cap");
    if (stop !== null) return { ...(await this.haltAtCap(stop)), tasksProcessed: result.tasksProcessed, results: result.results };
    return result;
  }

  private async cycleSteps(): Promise<CycleResult> {
    const { deps } = this;

    // The client's stops first, even at the spend cap (no LLM call): a project
    // stopped here is not active, so no step below takes it in, plans it,
    // reports on it or dispatches its tasks. Nothing of this process is running
    // for it now: the previous cycle awaited every task it dispatched.
    const stops = await this.takeClientStops();
    if (stops !== null) return this.haltAtCap(stops);
    // Then every message of the client's still unanswered gets its receipt (no LLM call), stating its
    // project's state as the stops just left it and what happens to the message.
    const receipts = await this.postReceipts("read-cap");
    if (receipts !== null) return this.haltAtCap(receipts);

    // The stack a Sprint 0 task merged in an earlier cycle (or before a restart) chose: an
    // Inferred assumption in a new vision version and one report to the client. No LLM call,
    // so before the spend-cap check.
    const choices = await this.step("stack-choice", () => deps.reporting.stackChoices.runPending());
    if (choices.kind === "stop") return this.haltAtCap(choices.stop);
    for (const choice of choices.kind === "ran" ? choices.value : []) {
      if (choice.kind !== "project-blocked" && choice.kind !== "step-faulted") {
        const version = choice.kind === "recorded" ? ` as vision v${choice.visionVersion}` : "";
        deps.loop.logger.info("delivery.stack-choice", `${choice.kind}${version}`, { projectId: choice.projectId, outcome: choice.kind });
      }
    }

    // A project halted on infrastructure resumes by itself once the substrate probe passes (one
    // probe per cycle while any is halted, no LLM call), before the reports, so its resumption is
    // told this cycle. Only a halt already told is resumed: one written late in the previous cycle
    // is reported below first, and resumes from the next cycle on.
    const resumed = await this.step("infrastructure-resume", () => resumeInfrastructureHalts(deps.loop.projectRepo, deps.dispatch.infrastructureProbe, deps.loop.containment, deps.loop.logger));
    if (resumed.kind === "stop") return this.haltAtCap(resumed.stop);
    // A project halted on client_wait resumes by itself once the client's answer to a question its held
    // tasks wait on is read (no LLM call); like an infrastructure halt, only once its halt is told.
    const answered = await this.step("client-wait-resume", () =>
      resumeClientWaitHalts({
        halts: deps.loop.projectRepo,
        workItemRepo: deps.loop.workItemRepo,
        clientQuestions: deps.dispatch.clientQuestions,
        containment: deps.loop.containment,
        logger: deps.loop.logger,
      }),
    );
    if (answered.kind === "stop") return this.haltAtCap(answered.stop);

    // Each stop and halt episode still owed one gets its terminal sweep on main (no LLM call), before
    // the stop's and the halt's terminal message, so each guarantee's evidence on the last commit is on
    // record when it is told.
    const terminal = await this.sweepTerminals();
    if (terminal !== null) return this.haltAtCap(terminal);
    // The stop and halt messages owed: a stop's taken above, a halt's recorded in an earlier cycle (or
    // before a restart), each after its terminal sweep. No LLM call, so before the spend-cap check: a
    // project the budget cap halted is told so. Every other kind is told where it can become due below,
    // and every kind as the cap halts the cycle.
    const terminalReports = await this.postTerminalReports(CARRIED_TERMINALS);
    if (terminalReports !== null) return this.haltAtCap(terminalReports);

    // A project's return to work, once its halt is told: one plain report each to the client.
    const blockReports = await this.postBlockReports();
    if (blockReports !== null) return this.haltAtCap(blockReports);
    // A project whose model requests run ahead of its finished work is warned once per zone and plan
    // revision, from the ledger's rows (no LLM call), so the warning reaches the client and the
    // operator before the budget halts the project.
    const warnings = await this.postBurnWarnings();
    if (warnings !== null) return this.haltAtCap(warnings);

    // Every step below makes LLM calls, each admitted by Finance's spend cap. A cycle at the cap
    // releases what the previous cycle's attempts held inside haltAtCap.
    const atCap = await deps.loop.spendCap.deploymentStop();
    if (atCap) return this.haltAtCap(atCap);
    const held = await this.releaseHeld();
    if (held.kind === "stop") return this.haltAtCap(held.stop);

    // Tenders first: a project's intake comes before any work on it.
    const intake = await this.stepThenCap("liaison-intake", () => deps.client.liaisonIntake.runPending());
    if (intake.kind === "stop") return this.haltAtCap(intake.stop);
    for (const outcome of intake.outcomes) logIntake(deps.loop.logger, outcome);

    // Then the client's answers, before planning: one read now appends the vision version
    // the first plan is made from. One that changes an assumption an existing plan was
    // built on is a correction: it holds the tasks citing that assumption or a guarantee resting on it
    // (correction_holds), which the gate below never dispatches, while the project's other tasks go on,
    // until the replanning step replaces them.
    const answers = await this.readAnswers();
    if (answers !== null) return this.haltAtCap(answers);
    // Then the client's changes of direction, each read into operations on the contract in force and
    // answered with its impact note this cycle: applied as the next vision version, holding the tasks
    // citing a key it affects as answers do, or held for the client's confirmation when the Liaison
    // pushes back.
    const changes = await this.stepThenCap("client-change", () => deps.client.clientChanges.runPending());
    if (changes.kind === "stop") return this.haltAtCap(changes.stop);
    for (const outcome of changes.outcomes) logChange(deps.loop.logger, outcome);

    // Then a roster for each project with vision v1 and none: first planning
    // requires one, since every planned task gets its owning role.
    const rosters = await this.stepThenCap("roster", () => deps.planning.rosterDerivation.runPending());
    if (rosters.kind === "stop") return this.haltAtCap(rosters.stop);
    for (const outcome of rosters.outcomes) {
      // Organization refuses a roster it cannot derive; the project's halt is Delivery's,
      // blamed by the refusal's cause chain: a ladder run out is the model's failure, an unreadable
      // vision Ashara's own.
      if (outcome.kind === "refused") await this.halt(outcome.projectId, projectBlockCause(outcome.refusal.error), "roster");
      logRoster(deps.loop.logger, outcome);
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
    const plans = await this.stepThenCap("first-plan", () => deps.planning.firstPlanning.runPending());
    if (plans.kind === "stop") return this.haltAtCap(plans.stop);
    for (const outcome of plans.outcomes) logFirstPlan(deps.loop.logger, outcome);
    // Answers posted while the first plan was being written are read before any of its tasks is
    // dispatched: one that changes an assumption the plan relied on holds the tasks citing it or a
    // guarantee resting on it, the
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
    const replans = await this.stepThenCap("replan", () => deps.planning.replanning.runPending());
    if (replans.kind === "stop") return this.haltAtCap(replans.stop);
    for (const outcome of replans.outcomes) logReplan(deps.loop.logger, outcome);
    const planReports = await this.postPlanReports();
    if (planReports !== null) return this.haltAtCap(planReports);
    // A first planning that stopped, and a contract version Ashara declines that intake, an answer or a
    // change wrote, are told now, with the guarantee table.
    const planningStopped = await this.postTerminalReports(PLANNED_TERMINALS);
    if (planningStopped !== null) return this.haltAtCap(planningStopped);

    // Every Blocked task takes its exit (Completed, Pending or given up) before the gate reads them.
    const released = await this.step("parked-exits", () =>
      releaseClearedBlocks({
        workItemRepo: deps.loop.workItemRepo,
        eventStore: deps.loop.eventStore,
        projects: deps.loop.projectRepo,
        clientQuestions: deps.dispatch.clientQuestions,
        workdirBase: deps.loop.config.workdirBase,
        containment: deps.loop.containment,
        logger: deps.loop.logger,
      }),
    );
    if (released.kind === "stop") return this.haltAtCap(released.stop);

    // A project with every task settled and a goal task done is swept on main (no LLM call): Accepted
    // and told so, or a defect whose repair the next cycle's replanning plans.
    const swept = await this.step("acceptance", () => runAcceptanceSweeps({ ...deps.sweeps, projectRepo: deps.loop.projectRepo, eventStore: deps.loop.eventStore, containment: deps.loop.containment, logger: deps.loop.logger }));
    if (swept.kind === "stop") return this.haltAtCap(swept.stop);
    const deliveredAfterSweep = await this.postTerminalReports(ACCEPTED_TERMINALS);
    if (deliveredAfterSweep !== null) return this.haltAtCap(deliveredAfterSweep);

    const gated = await this.step("gate", () => PlanningService.gate(deps.loop.workItemRepo, deps.loop.projectRepo, deps.loop.eventStore, deps.loop.containment, deps.loop.logger));
    if (gated.kind === "stop") return this.haltAtCap(gated.stop);
    if (gated.kind === "refused" || gated.value.available.length === 0) return { tasksProcessed: 0, results: [], stop: null };

    // Each task gets its own worktree (execution-infra's worktree.ts creates per-task branches),
    // so concurrent execution is safe at the process boundary. Every LLM call a
    // task makes is admitted by the spend cap; a refused call ends that task's
    // attempt and returns the item to Pending: a project refusal has already
    // blocked the project, and a deployment refusal stops the loop here.
    const lanes = await this.runLanes(gated.value);
    deps.loop.cycleLog.emit({
      event: "cycle_complete",
      eligible: gated.value.available.length,
      dispatched: lanes.results.length,
      lanes: deps.loop.config.laneCount,
      tasksProcessed: lanes.results.length,
      completed: lanes.results.filter((r) => r.status === "completed").length,
      failed: lanes.results.filter((r) => r.status === "failed").length,
      refused: lanes.results.filter((r) => r.status === "refused").length,
      interrupted: lanes.results.filter((r) => r.status === "interrupted").length,
    });

    const stop = lanes.refusedAtDeployment ?? (await deps.loop.spendCap.deploymentStop());
    if (stop) return { ...(await this.haltAtCap(stop)), tasksProcessed: lanes.results.length, results: lanes.results };
    return { tasksProcessed: lanes.results.length, results: lanes.results, stop: null };
  }

  /**
   * The cycle's dispatch: up to laneCount tasks at once, and a lane whose task settles takes the next
   * eligible one at once, re-gated after every settlement, so it never waits for another lane's task.
   * Every task is settled before the cycle ends, since the cycle's other steps run only while no
   * attempt is in flight (the client's stops, the release of what attempts held, the terminal
   * sweeps); so the lanes stop taking tasks only once those steps have work due (cycleWorkDue) or a
   * task settled Blocked, whose exit is a cycle step, and the cycle ends when its lanes settle. A
   * project's burn warning is posted between settlements, before its budget can halt it. A task runs
   * at most once per cycle. A refill stops at the deployment's cap, and a gate that fails while
   * refilling stops the refills, leaving that gate to the next cycle.
   */
  private async runLanes(first: GatedWork): Promise<{ readonly results: TaskResult[]; readonly refusedAtDeployment: LoopStop | null }> {
    const { deps } = this;
    const taken = new Set<string>();
    let settledCount = 0;
    let gatedAtSettled = 0;
    let eligible = first;
    let refusedAtDeployment: LoopStop | null = null;
    let drained = false;
    const atStart = await this.cycleWorkSnapshot();
    const drain = (reason: string) => {
      if (drained) return;
      drained = true;
      deps.loop.logger.info("delivery.lanes-drain", `no lane takes another task this cycle: ${reason}`, { reason, settled: settledCount });
    };

    const next = async (): Promise<WorkItem | null> => {
      if (refusedAtDeployment !== null || drained) return null;
      if (deps.loop.shutdownSignal.aborted) {
        drain("the process is shutting down");
        return null;
      }
      if (settledCount > 0 && gatedAtSettled !== settledCount) {
        const warned = await this.refillBurnWarnings();
        if (warned.kind === "stop") {
          refusedAtDeployment = warned.stop;
          return null;
        }
        if (warned.kind === "failed") {
          drain("the burn warnings failed while refilling a lane");
          return null;
        }
        const due = atStart === null ? "the cycle's work could not be read when its dispatch began" : await this.cycleWorkDue(atStart);
        if (due !== null) {
          drain(due);
          return null;
        }
        const regated = await this.regate();
        if (regated.kind === "stop") {
          refusedAtDeployment = regated.stop;
          return null;
        }
        if (regated.kind === "none") return null;
        eligible = regated.work;
        gatedAtSettled = settledCount;
      }
      const task = PlanningService.next(eligible.available, taken, eligible.unlockWeights);
      if (task === null) return null;
      taken.add(task.id);
      return task;
    };

    const run = async (task: WorkItem): Promise<TaskResult> => {
      try {
        const result = await this.settledTask(task);
        if (result.status === "refused" && result.refusal.kind === "deployment") {
          refusedAtDeployment ??= { reason: result.refusal.reason, spend: result.refusal.spend };
        }
        if (result.status === "blocked") drain(`task ${task.id} settled Blocked; its exit is a cycle step`);
        return result;
      } finally {
        settledCount += 1;
      }
    };

    const settled = await deps.loop.taskLanes(deps.loop.config.laneCount, next, run);
    const results: TaskResult[] = [];
    for (const { settled: each } of settled) {
      // A recovery that itself threw throws out of the cycle, as any step's own failure does, once every lane settled.
      if (each.status === "rejected") throw each.reason;
      results.push(each.value);
    }
    return { results, refusedAtDeployment };
  }

  /**
   * What the cycle's other steps act on, read when its dispatch begins: the messages owed a receipt
   * then (one whose receipt faulted stays owed) and the active projects. Null, logged at warn, when
   * either read failed; the lanes then take no task after the first settles.
   */
  private async cycleWorkSnapshot(): Promise<{ readonly messages: ReadonlySet<string>; readonly active: ReadonlySet<string> } | null> {
    try {
      const messages = await this.deps.client.clientReceipts.dueMessages();
      const active = new Set<string>(await this.deps.loop.projectRepo.listActiveIds());
      return { messages, active };
    } catch (err) {
      this.deps.loop.logger.warn("delivery.cycle-work-unread", "the cycle's due work could not be read: the lanes take no task after the first settles", {}, err);
      return null;
    }
  }

  /**
   * Why the cycle's other steps have work due since its dispatch began, or null: a message of the
   * client's arrived (a stop, an answer, a change or a tender, each read only between dispatches), or
   * a project left the active set (halted, stopped, accepted, or awaiting the repair of a given-up
   * task), whose report or repair is a cycle step. A read that fails is due work too, logged at warn.
   */
  private async cycleWorkDue(atStart: { readonly messages: ReadonlySet<string>; readonly active: ReadonlySet<string> }): Promise<string | null> {
    try {
      const messages = await this.deps.client.clientReceipts.dueMessages();
      const arrived = [...messages].find((subject) => !atStart.messages.has(subject));
      if (arrived !== undefined) return `a message of the client's arrived (${arrived})`;
      const active = new Set<string>(await this.deps.loop.projectRepo.listActiveIds());
      const left = [...atStart.active].find((id) => !active.has(id));
      if (left !== undefined) return `project ${left} left the active set`;
      return null;
    } catch (err) {
      this.deps.loop.logger.warn("delivery.cycle-work-unread", "the cycle's due work could not be read while refilling a lane", {}, err);
      return "the cycle's due work could not be read";
    }
  }

  /** The burn warnings posted between settlements; a failure is logged at warn and stops the refills. */
  private async refillBurnWarnings(): Promise<{ readonly kind: "posted" } | { readonly kind: "stop"; readonly stop: LoopStop } | { readonly kind: "failed" }> {
    try {
      const stop = await this.postBurnWarnings();
      return stop === null ? { kind: "posted" } : { kind: "stop", stop };
    } catch (err) {
      this.deps.loop.logger.warn("delivery.refill-burn-warning-failed", "the burn warnings failed while refilling a lane: no more tasks are dispatched this cycle", {}, err);
      return { kind: "failed" };
    }
  }

  /** The burn warnings due, each posted once (no LLM call); the deployment cap's stop when a refusal named it, else null. */
  private async postBurnWarnings(): Promise<LoopStop | null> {
    const warnings = await this.step("burn-warning", () => this.deps.reporting.burnWarnings.runPending());
    if (warnings.kind === "stop") return warnings.stop;
    for (const warning of warnings.kind === "ran" ? warnings.value : []) {
      if (warning.kind !== "step-faulted") {
        this.deps.loop.logger.info("delivery.burn-warning", `${warning.zone} warning ${warning.kind}`, { projectId: warning.projectId, zone: warning.zone, outcome: warning.kind });
      }
    }
    return null;
  }

  /** One task's lane: its processing, or the recovery of a processing that threw. */
  private async settledTask(task: WorkItem): Promise<TaskResult> {
    try {
      return await processTask(this.deps, task);
    } catch (err) {
      return handleProcessingError(this.deps, task, err);
    }
  }

  /**
   * The gate again for a refill, after a settlement: the deployment cap's stop, the work admitted
   * now, or none when the gate's step was refused for a project or the gate failed. A failed gate is
   * logged at warn and dispatches nothing more this cycle; the next cycle's gate reads every project again.
   */
  private async regate(): Promise<{ readonly kind: "work"; readonly work: GatedWork } | { readonly kind: "stop"; readonly stop: LoopStop } | { readonly kind: "none" }> {
    const { deps } = this;
    try {
      const atCap = await deps.loop.spendCap.deploymentStop();
      if (atCap) return { kind: "stop", stop: atCap };
      const gated = await this.step("gate", () => PlanningService.gate(deps.loop.workItemRepo, deps.loop.projectRepo, deps.loop.eventStore, deps.loop.containment, deps.loop.logger));
      if (gated.kind === "stop") return { kind: "stop", stop: gated.stop };
      if (gated.kind === "refused") return { kind: "none" };
      return { kind: "work", work: gated.value };
    } catch (err) {
      deps.loop.logger.warn("delivery.refill-gate-failed", "the gate failed while refilling a lane: no more tasks are dispatched this cycle", {}, err);
      return { kind: "none" };
    }
  }

  /**
   * What runs once a cycle has stopped the loop (the deployment's spend cap): only the client's
   * stops, each recorded and answered with no LLM call, so a stop sent while the loop is halted holds,
   * the receipt of every message the client sends meanwhile, the release of what attempts held, and
   * the terminal, resumption and plan reports still due. A project stopped here
   * stays stopped when the halt is lifted: the owner's unblock admits only a blocked project.
   */
  async runHaltedCycle(): Promise<void> {
    // The loop is already stopped at the cap: a stop any of these returns is that same stop.
    await this.takeClientStops();
    await this.postReceipts("stopped-at-cap");
    await this.releaseHeld();
    // A stop taken here, and a halt recorded at the cap, is owed its terminal sweep (no LLM call)
    // before its terminal message; no full cycle runs again in this process to sweep it.
    await this.sweepTerminals();
    // A report whose post faulted is contained to its project and retried after a backoff, and a plan
    // written in the cycle that reached the cap is reported after its halt's message; no full cycle
    // runs again in this process, so both are here. No report makes an LLM call.
    await this.postTerminalReports(TERMINAL_KINDS);
    await this.postBlockReports();
    await this.postPlanReports();
  }

  /**
   * What every attempt held on the host is released, whichever path ended it: the cells a failed
   * teardown left, then every settled task's branches. Called only where no attempt is in flight:
   * before a full cycle's dispatch (the previous cycle awaited every attempt it dispatched), in the
   * cycle that stops at the cap (haltAtCap, after its lanes settled), and on each halted cycle,
   * which dispatches nothing and retries a release the stopping cycle failed. No LLM call. The
   * branch release is a cycle step like any other: a stop it returns is the caller's to act on.
   */
  private async releaseHeld(): Promise<StepEnd<unknown>> {
    await this.deps.dispatch.heldCells.release();
    return this.step("settled-branches", () =>
      releaseBranchesOfSettledTasks({
        workItemRepo: this.deps.loop.workItemRepo,
        projects: this.deps.loop.projectRepo,
        workdirBase: this.deps.loop.config.workdirBase,
        logger: this.deps.loop.logger,
      }),
    );
  }

  /** The client's stops, each taken once; the deployment cap's stop when a refusal named it, else null. */
  private async takeClientStops(): Promise<LoopStop | null> {
    const stops = await this.step("client-stop", () => this.deps.client.clientStops.runPending());
    if (stops.kind === "stop") return stops.stop;
    for (const stop of stops.kind === "ran" ? stops.value : []) {
      if (stop.kind !== "step-faulted") this.deps.loop.logger.info("delivery.client-stop", `stop ${stop.stopId}: ${stop.kind}`, { projectId: stop.projectId, stopId: stop.stopId, outcome: stop.kind });
    }
    return null;
  }

  /**
   * The receipts due, each posted once; the deployment cap's stop when a refusal named it, else null.
   * Each states whether rounds of work still run: never once the loop is stopped at the cap, and in a
   * full cycle not when recorded spend is already at the cap, since that cycle stops before any reading.
   */
  private async postReceipts(work: "stopped-at-cap" | "read-cap"): Promise<LoopStop | null> {
    const stoppedAtCap = work === "stopped-at-cap" || (await this.deps.loop.spendCap.deploymentStop()) !== null;
    const receipts = await this.step("client-receipt", () => this.deps.client.clientReceipts.runPending({ kind: stoppedAtCap ? "stopped-at-cap" : "running" }));
    if (receipts.kind === "stop") return receipts.stop;
    for (const receipt of receipts.kind === "ran" ? receipts.value : []) {
      if (receipt.kind !== "step-faulted") {
        this.deps.loop.logger.info("delivery.client-receipt", `receipt for message ${receipt.messageId}: ${receipt.kind}`, { projectId: receipt.projectId, messageId: receipt.messageId, outcome: receipt.kind });
      }
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
      runTerminalSweeps({ terminalSweeps: deps.sweeps.terminalSweeps, terminalSweeper: deps.sweeps.terminalSweeper, containment: deps.loop.containment, logger: deps.loop.logger }),
    );
    return swept.kind === "stop" ? swept.stop : null;
  }

  /** The client's answers not yet read, each read once; the spend cap's stop when a call was refused, else null. */
  private async readAnswers(): Promise<LoopStop | null> {
    const answers = await this.stepThenCap("liaison-answers", () => this.deps.client.liaisonAnswers.runPending());
    if (answers.kind === "stop") return answers.stop;
    for (const outcome of answers.outcomes) logAnswer(this.deps.loop.logger, outcome);
    return null;
  }

  /**
   * Every terminal message of `kinds` owed, each posted once through the Liaison's one terminal step;
   * one whose post failed is logged at warn by the Liaison and retried, and the cycle goes on. The
   * deployment cap's stop when a refusal named it, else null.
   */
  private async postTerminalReports(kinds: readonly TerminalKind[]): Promise<LoopStop | null> {
    const reports = await this.step("terminal-report", () => this.deps.reporting.terminalReports.runPending(kinds));
    if (reports.kind === "stop") return reports.stop;
    for (const report of reports.kind === "ran" ? reports.value : []) {
      if (report.kind === "posted" || report.kind === "already-posted") {
        this.deps.loop.logger.info("delivery.terminal-report", `${report.terminal} message ${report.kind}`, { projectId: report.projectId, terminal: report.terminal, outcome: report.kind });
      }
    }
    return null;
  }

  /**
   * The planning outcomes not yet reported, each posted once; a project whose record is bad is
   * blocked by the Liaison. The deployment cap's stop when a refusal named it, else null.
   */
  private async postPlanReports(): Promise<LoopStop | null> {
    const reports = await this.step("plan-report", () => this.deps.reporting.planReports.runPending());
    if (reports.kind === "stop") return reports.stop;
    for (const report of reports.kind === "ran" ? reports.value : []) {
      if (report.kind !== "project-blocked" && report.kind !== "step-faulted") {
        this.deps.loop.logger.info("delivery.plan-report", `${report.subject} report ${report.kind}`, { projectId: report.projectId, subject: report.subject, outcome: report.kind });
      }
    }
    return null;
  }

  /** The block reports due, each posted once; the deployment cap's stop when a refusal named it, else null. */
  private async postBlockReports(): Promise<LoopStop | null> {
    const reports = await this.step("block-report", () => this.deps.reporting.blockReports.runPending());
    if (reports.kind === "stop") return reports.stop;
    for (const report of reports.kind === "ran" ? reports.value : []) {
      if (report.kind !== "step-faulted") {
        this.deps.loop.logger.info("delivery.block-report", `${report.subject} report ${report.kind}`, { projectId: report.projectId, subject: report.subject, outcome: report.kind });
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
    const halted = await this.deps.loop.projectRepo.blockAllActive(deploymentCapCause(stop));
    if (halted.length > 0) {
      this.deps.loop.logger.info("delivery.deployment-cap-halt", `${halted.length} project(s) halted at the deployment's spend cap: ${stop.reason}`, { projects: halted });
    }
    // The loop stops here on `stop`: a stop the sweeps' or the reports' step returns is the cap's too.
    await this.sweepTerminals();
    await this.postTerminalReports(TERMINAL_KINDS);
    await this.postBlockReports();
    await this.postReceipts("stopped-at-cap");
    return stopped(stop);
  }

  /**
   * Halts the project under `cause` through Delivery's guard, the one writer of a project halt,
   * in a trace of its own carrying the project, a child of whatever trace reached the halt.
   */
  private halt(projectId: ProjectId, cause: ProjectBlockCause, step: string): Promise<void> {
    return this.deps.loop.logger.scope({ projectId, trace: "new" }, async () => {
      const result = await this.deps.loop.projectRepo.block(projectId, cause);
      this.deps.loop.logger.info("delivery.project-blocked", `project ${projectId} ${result}: ${cause.errorClass}: ${cause.reason}`, {
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
  private async step<T>(name: CoreLoopStep, run: () => Promise<T>): Promise<StepEnd<T>> {
    // Every step boundary reads the shutdown, not only a lane's refill: the cycle ends before the
    // next step starts, and the runner, seeing its signal aborted, ends with it.
    const { shutdownSignal } = this.deps.loop;
    if (shutdownSignal.aborted) throw new CycleShutDown(name, shutdownSignal.reason);
    try {
      return { kind: "ran", value: await run() };
    } catch (err) {
      const refusal = this.deps.loop.spendCap.refusalOf(err);
      // A step's calls serve no task (only a dispatch's do), so a task's spent budget reaching a
      // step is no refusal a step can route: it throws out of the cycle like any other error.
      if (refusal === null || refusal.kind === "task_work") throw err;
      if (refusal.kind === "deployment") return { kind: "stop", stop: { reason: refusal.reason, spend: refusal.spend } };
      const projectId = parseProjectId(refusal.projectId, "spend refusal projectId");
      if (refusal.kind === "project_work") {
        await this.halt(projectId, projectWorkCause(refusal), `work_budget ${name}`);
        this.deps.loop.logger.info("delivery.step-refused", `${name}: the step's other projects run next cycle`, { step: name, projectId, category: "work_budget" });
        return { kind: "refused" };
      }
      await this.halt(projectId, projectCapCause(refusal), `budget_cap ${name}`);
      this.deps.loop.logger.info("delivery.step-refused", `${name}: the step's other projects run next cycle`, { step: name, projectId, category: "budget_cap" });
      return { kind: "refused" };
    }
  }

  /** Runs a step of model calls (step) and checks the deployment cap after it. */
  private async stepThenCap<T>(name: CoreLoopStep, run: () => Promise<readonly T[]>): Promise<StepRun<T>> {
    const ended = await this.step(name, run);
    if (ended.kind === "stop") return ended;
    const stop = await this.deps.loop.spendCap.deploymentStop();
    if (stop) return { kind: "stop", stop };
    return { kind: "ran", outcomes: ended.kind === "ran" ? ended.value : [] };
  }
}

/**
 * The policy default: every lane truly at once, each asking for its next item as soon as its own
 * settles; `next` is asked from this one loop only, so never twice at once.
 */
export const concurrentTaskLanes: TaskLanes = async <I extends { readonly id: string }, T>(
  lanes: number,
  next: () => Promise<I | null>,
  run: (item: I) => Promise<T>,
): Promise<Array<LaneSettlement<I, T>>> => {
  const settlements: Array<{ readonly item: I; settled: PromiseSettledResult<T> | null }> = [];
  const running = new Set<Promise<void>>();
  let failure: { readonly error: unknown } | null = null;
  for (;;) {
    while (running.size < lanes && failure === null) {
      const asked = await askedFor(next);
      if (asked.kind === "failed") {
        failure = { error: asked.error };
        break;
      }
      const item = asked.item;
      if (item === null) break;
      const entry: { readonly item: I; settled: PromiseSettledResult<T> | null } = { item, settled: null };
      settlements.push(entry);
      const lane: Promise<void> = Promise.resolve()
        .then(() => run(entry.item))
        .then(
          (value) => {
            entry.settled = { status: "fulfilled", value };
          },
          (reason: unknown) => {
            entry.settled = { status: "rejected", reason };
          },
        )
        .finally(() => running.delete(lane));
      running.add(lane);
    }
    if (running.size === 0) break;
    await Promise.race(running);
  }
  if (failure !== null) throw failure.error;
  return settlements.map((entry) => {
    if (entry.settled === null) throw new LaneNeverSettled(entry.item.id);
    return { item: entry.item, settled: entry.settled };
  });
};

/** What `next` answered: an item or null, or the error it threw, which ends the asking. */
async function askedFor<I>(next: () => Promise<I | null>): Promise<{ readonly kind: "answered"; readonly item: I | null } | { readonly kind: "failed"; readonly error: unknown }> {
  try {
    return { kind: "answered", item: await next() };
  } catch (error) {
    return { kind: "failed", error };
  }
}

/** The shutdown signal had aborted when step `step` was due: the cycle ends there, the step not run. */
class CycleShutDown extends Error {
  constructor(
    readonly step: string,
    readonly reason: unknown,
  ) {
    super(`the cycle ended before step ${step}: the process is shutting down (${describeErrorChain(reason)})`);
    this.name = "CycleShutDown";
  }
}

/** A lane the pool counted as settled that recorded no settlement: a defect of the pool itself. */
class LaneNeverSettled extends Error {
  constructor(readonly itemId: string) {
    super(`the lane of item ${itemId} left the pool without a settlement`);
    this.name = "LaneNeverSettled";
  }
}

function stopped(stop: LoopStop): CycleResult {
  return { tasksProcessed: 0, results: [], stop };
}
