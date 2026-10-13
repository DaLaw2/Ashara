import type { IntakeOutcome } from "./acl/engagement-acl.js";
import type { RosterOutcome } from "./acl/organization-acl.js";
import type { FirstPlanOutcome, WorkItem } from "./acl/planning-acl.js";
import { PlanningService, DependencyGraph } from "./acl/planning-acl.js";
import type { CoreLoopDeps, CycleResult, LoopStop, TaskResult } from "./types.js";
import { processTask, handleProcessingError } from "./execution.js";

/** Failures are logged at warn by the Liaison itself, with their attempt count. */
function logIntake(outcome: IntakeOutcome): void {
  if (outcome.kind === "recorded") {
    console.log(
      `[liaison-intake] tender ${outcome.tenderId}: vision v1 written for project ${outcome.projectId}, ` +
        `${outcome.questions} question(s) posted`,
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
    for (const stop of await deps.clientStops.runPending()) {
      console.log(`[liaison-stop] stop ${stop.stopId}: project ${stop.projectId} ${stop.kind}`);
    }

    // The stack a Sprint 0 task merged in an earlier cycle (or before a restart) chose: an
    // Inferred assumption in a new vision version and one report to the client. No LLM call,
    // so before the spend-cap check.
    for (const choice of await deps.stackChoices.runPending()) {
      if (choice.kind !== "project-blocked") {
        const version = choice.kind === "recorded" ? ` as vision v${choice.visionVersion}` : "";
        console.log(`[liaison-stack-choice] project ${choice.projectId}: ${choice.kind}${version}`);
      }
    }

    // Every step below makes LLM calls, each admitted by Finance's spend cap.
    const atCap = await deps.spendCap.deploymentStop();
    if (atCap) return stopped(atCap);

    // Tenders first: a project's intake comes before any work on it.
    const intake = await this.step("liaison-intake", () => deps.liaisonIntake.runPending());
    if (intake.kind === "stop") return stopped(intake.stop);
    for (const outcome of intake.outcomes) logIntake(outcome);

    // Then a roster for each project with vision v1 and none: first planning
    // requires one, since every planned task gets its owning role.
    const rosters = await this.step("roster", () => deps.rosterDerivation.runPending());
    if (rosters.kind === "stop") return stopped(rosters.stop);
    for (const outcome of rosters.outcomes) logRoster(outcome);

    // Then a first plan for each project that has a vision, a roster and no work items,
    // and the Liaison's report on each recorded planning outcome. Both before
    // gating, so a plan written this cycle can be dispatched this cycle.
    // A project whose own record is bad is blocked inside each step, logged at
    // warn there, and skipped; any other failure throws out of the cycle.
    const plans = await this.step("first-plan", () => deps.firstPlanning.runPending());
    if (plans.kind === "stop") return stopped(plans.stop);
    for (const outcome of plans.outcomes) logFirstPlan(outcome);
    for (const report of await deps.planReports.runPending()) {
      if (report.kind !== "project-blocked") {
        console.log(`[liaison-report] project ${report.projectId}: ${report.subject} report ${report.kind}`);
      }
    }

    const eligible = await PlanningService.gate(deps.workItemRepo, deps.projectRepo);
    if (eligible.length === 0) return { tasksProcessed: 0, results: [], stop: null };

    const graph = await DependencyGraph.load(deps.workItemRepo);
    const batch = PlanningService.select(eligible, deps.config.maxBatchSize, graph.computeUnlockWeights());

    // Each task gets its own worktree (workspace.ts creates per-task branches),
    // so concurrent execution is safe at the process boundary. Every LLM call a
    // task makes is admitted by the spend cap; a refused call ends that task's
    // attempt and returns the item to Pending: a project refusal has already
    // blocked the project, and a deployment refusal stops the loop here.
    const settled = await Promise.allSettled(batch.map((task) => processTask(deps, task)));
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

    return { tasksProcessed: batch.length, results, stop: refusedAtDeployment ?? (await deps.spendCap.deploymentStop()) };
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

function stopped(stop: LoopStop): CycleResult {
  return { tasksProcessed: 0, results: [], stop };
}
