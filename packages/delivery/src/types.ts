import type { EventStoreRepository } from "@ashara/db";
import type { Logger, ProjectId, StepContainment } from "@ashara/shared";
import type { ProjectBlockCause } from "./project-halt.js";
import type { WorkItemRepository, PlanningService } from "./domain/index.js";
import type { FailureRecoveryDeps } from "./lifecycle/failure-recovery.js";
import type { FirstPlanning } from "./first-plan.js";
import type { Replanning } from "./replan-port.js";
import type { FailedApproachRepository } from "./acl/knowledge-acl.js";
import type { AcceptanceSweeper, TerminalSweeper } from "./acl/quality-acl.js";
import type { DispatchService } from "./dispatch/dispatch-service.js";
import type { WorkspacePathStore } from "./task-helpers.js";
import type { SettledTargets } from "./settled-branches.js";
import type {
  LiaisonAnswers,
  LiaisonBlockReports,
  LiaisonBurnWarnings,
  LiaisonClientChanges,
  LiaisonClientReceipts,
  LiaisonClientStops,
  LiaisonDeliveredReports,
  LiaisonIntake,
  LiaisonPlanReports,
  LiaisonStackChoices,
  TaskQuestion,
  TaskQuestionPosting,
} from "./acl/engagement-acl.js";
import type { AcceptanceStore } from "./acceptance.js";
import type { TerminalSweepStore } from "./terminal-sweep.js";
import type { ClientWaitHalts } from "./client-wait-halts.js";
import type { InfrastructureHalts, InfrastructureProbe } from "./infrastructure-halts.js";
import type { RosterDerivationStep } from "./acl/organization-acl.js";
import type { SpendAtCap, WorkAtBudget } from "./acl/finance-acl.js";

export interface CoreLoopConfig {
  readonly workdirBase: string;
  /** How many tasks run at once: each lane takes the next eligible task as soon as its own settles. */
  readonly laneCount: number;
}

/**
 * Defaults for every CoreLoopConfig field EXCEPT `workdirBase`, which has no
 * safe default — `""` was falsy and let every use-site fallback fire with a
 * different guess (tmpdir, cwd, bare relative path). The server's
 * `loadServerConfig()` is the single parse site for the value; making it
 * absent here forces every spread to supply it.
 */
export const DEFAULT_CONFIG: Omit<CoreLoopConfig, "workdirBase"> = {
  laneCount: 2,
};

/** Why the loop must stop for good, the deployment's spend cap; the runner ends on it instead of cycling again. */
export interface LoopStop {
  readonly reason: string;
  readonly spend: SpendAtCap;
}

export interface CycleResult {
  readonly tasksProcessed: number;
  readonly results: TaskResult[];
  /** Set when this cycle found the loop must stop. */
  readonly stop: LoopStop | null;
}

/**
 * Finance's admission refusing an LLM call, as the loop routes it: a spend cap's (`project`,
 * `deployment`), or the work ledger's, a task's model requests spent
 * (`task_work`: the task is given up) or its project's (`project_work`: the project halts).
 */
type SpendRefusal =
  | { readonly kind: "project"; readonly projectId: string; readonly reason: string; readonly spend: SpendAtCap }
  | { readonly kind: "deployment"; readonly reason: string; readonly spend: SpendAtCap }
  | { readonly kind: "task_work"; readonly projectId: string; readonly taskId: string; readonly reason: string; readonly work: WorkAtBudget }
  | { readonly kind: "project_work"; readonly projectId: string; readonly reason: string; readonly work: WorkAtBudget };

/**
 * Finance's spend cap, as the loop reads it. Finance only refuses: the loop halts a project its
 * refusal names at its cap; a deployment refusal, or recorded spend at the deployment cap, halts
 * every active project at the cap and stops the loop.
 */
interface SpendCapPort {
  deploymentStop(): Promise<LoopStop | null>;
  refusalOf(error: unknown): SpendRefusal | null;
}

/**
 * A model call refused before it was sent by anything but a spend cap (an unpriced model, a cost
 * that cannot be estimated): a configuration fault the owner fixes, so the project is blocked
 * with the refusal's class. A re-dispatch would meet the same configuration.
 */
interface ConfigurationRefusal {
  readonly kind: "configuration";
  readonly projectId: string;
  readonly errorClass: string;
  readonly reason: string;
}

export type TaskRefusal = SpendRefusal | ConfigurationRefusal;

export type TaskResult =
  | { readonly taskId: string; readonly status: "completed" | "failed" | "blocked"; readonly detail: string }
  /**
   * A model call of the dispatch was refused before it was sent: the item is back at Pending with
   * its dispatch refunded, no lesson and no failure router. A deployment refusal stops the loop with
   * its reason; a configuration refusal has blocked the project.
   */
  | { readonly taskId: string; readonly status: "refused"; readonly detail: string; readonly refusal: TaskRefusal }
  /** The process's shutdown interrupted the attempt: the item is back at Pending with its dispatch refunded. */
  | { readonly taskId: string; readonly status: "interrupted"; readonly detail: string };

/** `detail` is the dispatch's own account of what it delivered, which claims no verification it did not run. */
export function completedResult(taskId: string, detail: string): TaskResult {
  return { taskId, status: "completed", detail };
}

export function failedResult(taskId: string, detail: string): TaskResult {
  return { taskId, status: "failed", detail };
}

export function blockedResult(taskId: string, detail: string): TaskResult {
  return { taskId, status: "blocked", detail };
}

/**
 * Halts every active project at once: the deployment's spend cap, which binds them all, was
 * reached. Returns the projects it halted.
 */
interface SpendCapHalts {
  blockAllActive(cause: ProjectBlockCause): Promise<ProjectId[]>;
}

/** A cycle's tally of its lanes' outcomes, as the server log records it. */
interface CycleComplete {
  readonly event: "cycle_complete";
  /** The tasks the cycle's gate admitted before its first dispatch. */
  readonly eligible: number;
  /** The tasks its lanes took, the first ones and every refill. */
  readonly dispatched: number;
  readonly lanes: number;
  readonly tasksProcessed: number;
  readonly completed: number;
  readonly failed: number;
  readonly refused: number;
  readonly interrupted: number;
}

/**
 * The loop's own runtime and the board every step group reads: its config, logs, work items, events,
 * projects, the spend cap and the containment of each step's faults.
 */
export interface LoopCore {
  readonly config: CoreLoopConfig;
  /** Where each cycle's tally is written: the server log's event writer. */
  readonly cycleLog: { emit(event: CycleComplete): void };
  /** Each dispatched attempt runs in its own trace on it, carrying its task and attempt number. */
  readonly logger: Logger;
  readonly workItemRepo: WorkItemRepository;
  readonly eventStore: Pick<EventStoreRepository, "publish">;
  /**
   * Holds each project's target workspace path and its status:
   * the gate admits only active projects' tasks and blocks a project with a bad
   * row; the infrastructure halts and the deployment cap's halt;
   * every target, whose settled tasks' branches each cycle releases.
   * ProjectHaltRepository satisfies it.
   */
  readonly projectRepo: WorkspacePathStore & Parameters<typeof PlanningService.gate>[1] & InfrastructureHalts & ClientWaitHalts & SpendCapHalts & SettledTargets;
  /** The one spend cap, read from llm_calls: checked before every cycle's work and between its steps. */
  readonly spendCap: SpendCapPort;
  /**
   * Where each step keeps the faults it contains to one subject (containEach), and which errors
   * escape to the cycle instead: a spend-cap refusal, which halts at the cap.
   */
  readonly containment: StepContainment;
  /** How a cycle's lanes run their tasks: production's concurrentTaskLanes runs them truly at once. */
  readonly taskLanes: TaskLanes;
  /** Aborted on shutdown: no lane takes another task, and the cycle ends once its lanes settle. */
  readonly shutdownSignal: AbortSignal;
}

/** Engagement's Liaison reading the client's inbound messages: stops, receipts, changes, the tender and answers. */
interface ClientIntakeSteps {
  /**
   * The Liaison's handling of the client's stops, run first in every cycle,
   * before the spend-cap check: a stopped project is never intaken, planned or gated.
   * Their reports are posted after the cycle's terminal sweeps, each with its stop's table.
   */
  readonly clientStops: LiaisonClientStops;
  /**
   * The Liaison's receipt for each of the client's messages, in every project state: run right after
   * the stops, at the end of every full cycle, and in every halted cycle (no LLM call), so no message
   * waits a cycle unanswered.
   */
  readonly clientReceipts: LiaisonClientReceipts;
  /**
   * The Liaison's reading of each of the client's changes of direction into a correction of the
   * contract, answered with its impact note; a halted project's changes are read too.
   */
  readonly clientChanges: LiaisonClientChanges;
  /** The Liaison's tender intake, run each cycle before work-item gating. */
  readonly liaisonIntake: LiaisonIntake;
  /**
   * The Liaison's reading of the client's answers, run after intake and before planning, so
   * an answer read before the first plan is planned on.
   */
  readonly liaisonAnswers: LiaisonAnswers;
}

/** Organization's roster and Delivery's plans: the first plan of each project and each revision. */
interface PlanningSteps {
  /** Organization's roster for each project with vision v1 and none, run after intake. */
  readonly rosterDerivation: RosterDerivationStep;
  /** Delivery's first plan of each project awaiting one (and holding a roster), run after the roster step. */
  readonly firstPlanning: FirstPlanning;
  /**
   * Delivery's revision of each plan a client's answer flagged, once none of the project's
   * tasks is in progress; run after the first plans, before the planning reports.
   */
  readonly replanning: Replanning;
}

/**
 * The client's channel for a decision only the client can make, which Engagement keeps: `ask` posts a
 * task's question to the client, as intake's questions are posted, and `answered` says whether the
 * client's answer to one has been read.
 */
export interface ClientQuestions {
  ask(question: TaskQuestion): Promise<TaskQuestionPosting>;
  answered(questionId: string): Promise<boolean>;
}

/** A task's dispatch, the routing of its result, and the cells and substrate its attempts run on. */
export interface DispatchSteps {
  readonly dispatchService: Pick<DispatchService, "execute">;
  readonly failedApproachRepo: Pick<FailedApproachRepository, "record">;
  readonly failureRouter: FailureRecoveryDeps["failureRouter"];
  /** Quality's durable record of check disputes: their count per check task bounds the reopens. */
  readonly checkDisputes: CheckDisputeRecord;
  /**
   * Quality's durable record of the reviews of plan revisions' suites:
   * how many reviews named each check task bounds its reopens.
   */
  readonly suiteReviewFindings: SuiteReviewFindingRecord;
  /**
   * Quality's freeze of a plan revision's check set, run at every dispatch before it is counted: the
   * first implementation dispatched on a review's check set freezes it, so no later review of that
   * set reopens anything.
   */
  readonly checkSetFreeze: CheckSetFreeze;
  /**
   * The roster role doing a project's environment work, from its latest roster: the owner of the
   * environment task an implementation's request opens. `none`, with
   * why, when the roster names no such role; a roster that cannot be read throws.
   */
  readonly environmentOwner: (projectId: ProjectId) => Promise<EnvironmentOwner>;
  /** Where a task blocked on a decision only the client can make has its question posted, and its answer read. */
  readonly clientQuestions: ClientQuestions;
  /**
   * Removes every cell this process still holds, run each cycle before anything is dispatched: no
   * attempt is in flight then, so each one held is a cell whose teardown failed. Never throws.
   */
  readonly heldCells: { release(): Promise<void> };
  /** The substrate probe an infrastructure halt waits on; run each cycle while a project is so halted. */
  readonly infrastructureProbe: InfrastructureProbe;
}

/** Quality's sweeps of main (no model is called) and the records of each. */
export interface SweepSteps {
  /** Z0's acceptance sweep of a project on main HEAD. */
  readonly acceptanceSweeper: Pick<AcceptanceSweeper, "sweepForAcceptance">;
  /** The acceptance sweeps recorded on main: which projects are ready, and their verdicts. */
  readonly acceptance: AcceptanceStore;
  /** Z0's terminal sweep of a stopped or halted project on main HEAD. */
  readonly terminalSweeper: Pick<TerminalSweeper, "sweepForTerminal">;
  /** The terminal sweeps recorded: which stops and halt episodes are owed one, and each one's record. */
  readonly terminalSweeps: TerminalSweepStore;
}

/** Engagement's Liaison reporting to the client; none makes an LLM call. */
interface ReportingSteps {
  /** The Liaison's one delivered report per accepted project; run every cycle. */
  readonly deliveredReports: LiaisonDeliveredReports;
  /** The Liaison's reports on recorded planning outcomes and plan revisions, run after planning. */
  readonly planReports: LiaisonPlanReports;
  /**
   * The stack each merged Sprint 0 task chose, made an Inferred assumption in a new vision
   * version and reported to the client once; run every cycle, at the budget cap too.
   */
  readonly stackChoices: LiaisonStackChoices;
  /**
   * The Liaison's one report per project halt and per resumption; run every cycle, at the budget
   * cap too, and once more when the deployment cap stops the loop.
   */
  readonly blockReports: LiaisonBlockReports;
  /**
   * The Liaison's early warning on each project's work ledger: one
   * report per zone and plan revision, the red zone's to the operator too; run every cycle after the
   * block reports, before the spend-cap check.
   */
  readonly burnWarnings: LiaisonBurnWarnings;
}

/** What the core loop runs on, one port per step group; each group's owner context implements it. */
export interface CoreLoopDeps {
  readonly loop: LoopCore;
  readonly client: ClientIntakeSteps;
  readonly planning: PlanningSteps;
  readonly dispatch: DispatchSteps;
  readonly sweeps: SweepSteps;
  readonly reporting: ReportingSteps;
}

/** What one task's dispatch and the routing of its result run on: the loop's own board and the dispatch steps. */
export type DispatchRunDeps = Pick<CoreLoopDeps, "loop" | "dispatch">;

/** The members of each step group a caller supplies in place of what a builder of CoreLoopDeps makes. */
export type CoreLoopOverrides = { readonly [Group in keyof CoreLoopDeps]?: Partial<CoreLoopDeps[Group]> };

/** `base` with each group's overridden members replaced: the one merge every builder of CoreLoopDeps applies. */
export function withOverrides(base: CoreLoopDeps, overrides: CoreLoopOverrides): CoreLoopDeps {
  // eslint-disable-next-line no-restricted-syntax -- the merge both builders apply, every group read from `base`
  return {
    loop: { ...base.loop, ...overrides.loop },
    client: { ...base.client, ...overrides.client },
    planning: { ...base.planning, ...overrides.planning },
    dispatch: { ...base.dispatch, ...overrides.dispatch },
    sweeps: { ...base.sweeps, ...overrides.sweeps },
    reporting: { ...base.reporting, ...overrides.reporting },
  };
}

/** One item a lane ran, and how its run settled. */
export interface LaneSettlement<I, T> {
  readonly item: I;
  readonly settled: PromiseSettledResult<T>;
}

/**
 * Runs `run` on the items `next` hands out, at most `lanes` at once. A lane asks `next` for its next
 * item as soon as its own settles, never waiting for another lane; `next` is never asked twice at once,
 * and answers null when nothing is eligible now, which is asked again after the next settlement.
 * Resolves once no item is in flight and `next` answered null: each item's settlement, in the order
 * the items started. A `next` that throws ends the asking; the items in flight still settle, and then
 * the pool rejects with that error. The composition root chooses it, so whatever drives the process
 * can also decide how the lanes interleave (the lifecycle simulator serialises them by its seed).
 */
export type TaskLanes = <I extends { readonly id: string }, T>(
  lanes: number,
  next: () => Promise<I | null>,
  run: (item: I) => Promise<T>,
) => Promise<Array<LaneSettlement<I, T>>>;

/** Who does a project's environment work, as the latest roster says. */
type EnvironmentOwner = { readonly kind: "role"; readonly roleId: string } | { readonly kind: "none"; readonly why: string };

/** One dispute of a stored check, as an implementer's attempt ended with it. */
interface CheckDisputeEntry {
  readonly projectId: string;
  readonly taskId: string;
  readonly checkTaskId: string;
  readonly revision: number;
  readonly checkName: string;
  readonly reason: string;
  readonly evidence: string | null;
}

/** Appends a dispute; resolves to the disputes its check task has drawn, this one included. */
interface CheckDisputeRecord {
  record(dispute: CheckDisputeEntry): Promise<number>;
}

/** One review of a plan revision's suites that found problems, as its dispatch ended with it. */
interface SuiteReviewFindingsEntry {
  readonly projectId: string;
  readonly reviewTaskId: string;
  readonly problems: ReadonlyArray<{
    readonly checkTaskIds: readonly string[];
    readonly kind: "contradiction" | "outside-vision" | "undecided-item" | "breaks-contract";
    readonly problem: string;
    readonly evidence: string;
  }>;
}

/** Appends the findings; resolves, per named check task, to how many reviews have named it, this one included. */
interface SuiteReviewFindingRecord {
  record(findings: SuiteReviewFindingsEntry): Promise<{ readonly timesNamed: ReadonlyMap<string, number> }>;
}

/**
 * Quality's freeze of a plan revision's check set: freezes the check set of
 * every review task the dispatched task depends on that is not frozen yet, and resolves to the review
 * tasks it froze. A task that depends on no review freezes nothing.
 */
interface CheckSetFreeze {
  freezeFor(taskId: string): Promise<readonly string[]>;
}
