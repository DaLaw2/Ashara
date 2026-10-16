import type { EventStoreRepository } from "@ashara/db";
import type { ProjectId, StepContainment } from "@ashara/shared";
import type { ProjectBlockCause } from "./project-halt.js";
import type { WorkItemRepository, PlanningService } from "./domain/index.js";
import type { FailureRecoveryDeps } from "./lifecycle/failure-recovery.js";
import type { FirstPlanning } from "./first-plan.js";
import type { Replanning } from "./replan.js";
import type { FailedApproachRepository } from "./acl/knowledge-acl.js";
import type { TaskVerification } from "./acl/quality-acl.js";
import type { DispatchService } from "./dispatch/dispatch-service.js";
import type { WorkspacePathStore } from "./task-helpers.js";
import type { SettledTargets } from "./settled-branches.js";
import type {
  LiaisonAnswers,
  LiaisonBlockReports,
  LiaisonClientChanges,
  LiaisonClientStops,
  LiaisonDeliveredReports,
  LiaisonIntake,
  LiaisonPlanReports,
  LiaisonStackChoices,
} from "./acl/engagement-acl.js";
import type { AcceptanceStore } from "./acceptance.js";
import type { InfrastructureHalts, InfrastructureProbe } from "./infrastructure-halts.js";
import type { RosterDerivationStep } from "./acl/organization-acl.js";
import type { SpendAtCap } from "./acl/finance-acl.js";

export interface CoreLoopConfig {
  readonly workdirBase: string;
  readonly maxBatchSize: number;
}

/**
 * Defaults for every CoreLoopConfig field EXCEPT `workdirBase`, which has no
 * safe default — `""` was falsy and let every use-site fallback fire with a
 * different guess (tmpdir, cwd, bare relative path). The server's
 * `loadServerConfig()` is the single parse site for the value; making it
 * absent here forces every spread to supply it.
 */
export const DEFAULT_CONFIG: Omit<CoreLoopConfig, "workdirBase"> = {
  maxBatchSize: 2,
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

/** A spend cap refusing an LLM call, as the loop routes it. */
type SpendRefusal =
  | { readonly kind: "project"; readonly projectId: string; readonly reason: string; readonly spend: SpendAtCap }
  | { readonly kind: "deployment"; readonly reason: string; readonly spend: SpendAtCap };

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
 * reached (design P14). Returns the projects it halted.
 */
interface SpendCapHalts {
  blockAllActive(cause: ProjectBlockCause): Promise<ProjectId[]>;
}

/** A cycle's tally of its batch's outcomes, as the server log records it. */
interface CycleComplete {
  readonly event: "cycle_complete";
  readonly tasksProcessed: number;
  readonly completed: number;
  readonly failed: number;
  readonly refused: number;
  readonly interrupted: number;
}

export interface CoreLoopDeps {
  readonly config: CoreLoopConfig;
  /** Where each cycle's tally is written: the server log's event writer. */
  readonly cycleLog: { emit(event: CycleComplete): void };
  readonly workItemRepo: WorkItemRepository;
  readonly eventStore: Pick<EventStoreRepository, "publish">;
  readonly failedApproachRepo: Pick<FailedApproachRepository, "record">;
  /**
   * Holds each project's target workspace path (migration 024) and its status:
   * the gate admits only active projects' tasks and blocks a project with a bad
   * row (migration 025); the infrastructure halts and the deployment cap's halt
   * (migration 048); every target, whose settled tasks' branches each cycle releases.
   * ProjectHaltRepository satisfies it.
   */
  readonly projectRepo: WorkspacePathStore & Parameters<typeof PlanningService.gate>[1] & InfrastructureHalts & SpendCapHalts & SettledTargets;
  readonly dispatchService: Pick<DispatchService, "execute">;
  /** Z0's acceptance sweep of a project on main HEAD (Quality; no model is called). */
  readonly acceptanceSweeper: Pick<TaskVerification, "sweepForAcceptance">;
  /** The acceptance sweeps recorded on main (migration 049): which projects are ready, and their verdicts. */
  readonly acceptance: AcceptanceStore;
  /** The Liaison's one delivered report per accepted project; run every cycle (no LLM call). */
  readonly deliveredReports: LiaisonDeliveredReports;
  readonly failureRouter: FailureRecoveryDeps["failureRouter"];
  /** The one spend cap, read from llm_calls: checked before every cycle's work and between its steps. */
  readonly spendCap: SpendCapPort;
  /**
   * Where each step keeps the faults it contains to one subject (containEach), and which errors
   * escape to the cycle instead: a spend-cap refusal, which halts at the cap.
   */
  readonly containment: StepContainment;
  /**
   * The Liaison's handling of the client's stops, run first in every cycle,
   * before the spend-cap check: a stopped project is never intaken, planned or gated.
   */
  readonly clientStops: LiaisonClientStops;
  /**
   * The Liaison's reply to each of the client's changes of direction, which are not yet applied
   * (M3 X5): run right after the stops, before the spend-cap check (no LLM call), so no change is
   * left unanswered.
   */
  readonly clientChanges: LiaisonClientChanges;
  /** The Liaison's tender intake, run each cycle before work-item gating. */
  readonly liaisonIntake: LiaisonIntake;
  /**
   * The Liaison's reading of the client's answers, run after intake and before planning, so
   * an answer read before the first plan is planned on.
   */
  readonly liaisonAnswers: LiaisonAnswers;
  /** Organization's roster for each project with vision v1 and none, run after intake. */
  readonly rosterDerivation: RosterDerivationStep;
  /** Delivery's first plan of each project awaiting one (and holding a roster), run after the roster step. */
  readonly firstPlanning: FirstPlanning;
  /**
   * Delivery's revision of each plan a client's answer flagged, once none of the project's
   * tasks is in progress; run after the first plans, before the planning reports.
   */
  readonly replanning: Replanning;
  /** The Liaison's reports on recorded planning outcomes and plan revisions, run after planning. */
  readonly planReports: LiaisonPlanReports;
  /**
   * The stack each merged Sprint 0 task chose, made an Inferred assumption in a new vision
   * version and reported to the client once; run every cycle, at the budget cap too (no LLM call).
   */
  readonly stackChoices: LiaisonStackChoices;
  /** Quality's durable record of check disputes: their count per check task bounds the reopens. */
  readonly checkDisputes: CheckDisputeRecord;
  /**
   * Quality's durable record of the reviews of plan revisions' suites (ADR-074 addendum 2 d71 c):
   * how many reviews named each check task bounds its reopens.
   */
  readonly suiteReviewFindings: SuiteReviewFindingRecord;
  /**
   * The Liaison's one report per project halt and per resumption; run every cycle, at the budget
   * cap too (no LLM call), and once more when the deployment cap stops the loop.
   */
  readonly blockReports: LiaisonBlockReports;
  /** The substrate probe an infrastructure halt waits on; run each cycle while a project is so halted. */
  readonly infrastructureProbe: InfrastructureProbe;
  /**
   * The roster role doing a project's environment work, from its latest roster: the owner of the
   * environment task an implementation's request opens (ADR-074 addendum 2 d66 b). `none`, with
   * why, when the roster names no such role; a roster that cannot be read throws.
   */
  readonly environmentOwner: (projectId: ProjectId) => Promise<EnvironmentOwner>;
  /** How a cycle's batch runs: production's concurrentTaskLanes runs every task at once. */
  readonly taskLanes: TaskLanes;
}

/**
 * Runs `run` on every item at once and settles each on its own, in the items' order. The
 * composition root chooses it, so whatever drives the process can also decide how the tasks of
 * one batch interleave (the lifecycle simulator serialises them by its seed).
 */
export type TaskLanes = <I extends { readonly id: string }, T>(
  items: readonly I[],
  run: (item: I) => Promise<T>,
) => Promise<Array<PromiseSettledResult<T>>>;

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
    readonly kind: "contradiction" | "outside-vision" | "undecided-item";
    readonly problem: string;
    readonly evidence: string;
  }>;
}

/**
 * Appends the findings; resolves, per named check task, to how many reviews have named it, this one
 * included, and to every problem the earlier reviews found in its checks, oldest first (ADR-074
 * addendum 2 d89 F).
 */
interface SuiteReviewFindingRecord {
  record(findings: SuiteReviewFindingsEntry): Promise<{
    readonly timesNamed: ReadonlyMap<string, number>;
    readonly earlierFindings: ReadonlyMap<
      string,
      ReadonlyArray<{ readonly kind: "contradiction" | "outside-vision" | "undecided-item"; readonly problem: string; readonly evidence: string }>
    >;
  }>;
}
