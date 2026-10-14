import type { EventStoreRepository, FailedApproachRepository } from "@ashara/db";
import type { ProjectId } from "@ashara/shared";
import type { WorkItemRepository, FailureRecoveryDeps, FirstPlanning, PlanningService, Replanning } from "./acl/planning-acl.js";
import type { DevelopmentService } from "./acl/development-acl.js";
import type { WorkspacePathStore } from "./task-helpers.js";
import type {
  LiaisonAnswers,
  LiaisonBlockReports,
  LiaisonCheckDisputes,
  LiaisonClientStops,
  LiaisonIntake,
  LiaisonPlanReports,
  LiaisonStackChoices,
  LiaisonSuiteReviews,
} from "./acl/engagement-acl.js";
import type { ParkedExitChecks } from "./parked-exits.js";
import type { RosterDerivationStep } from "./acl/organization-acl.js";
import type { EventLogger } from "./event-logger.js";

export interface CoreLoopConfig {
  readonly workdirBase: string;
  readonly maxBatchSize: number;
  readonly maxRetries: number;
  readonly decompositionTimeoutMs: number;
  readonly verifyTimeoutMs: number;
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
  maxRetries: 1,
  decompositionTimeoutMs: 120_000,
  verifyTimeoutMs: 120_000,
};

/** Why the loop must stop for good; the runner ends on it instead of cycling again. */
export interface LoopStop {
  readonly reason: string;
}

export interface CycleResult {
  readonly tasksProcessed: number;
  readonly results: TaskResult[];
  /** Set when this cycle found the loop must stop. */
  readonly stop: LoopStop | null;
}

/** A spend cap refusing an LLM call, as the loop routes it. */
type SpendRefusal =
  | { readonly kind: "project"; readonly projectId: string; readonly reason: string }
  | { readonly kind: "deployment"; readonly reason: string };

/**
 * Finance's spend cap, as the loop reads it. A project refusal has already
 * blocked its project; a deployment refusal, or recorded spend at the
 * deployment cap, stops the loop.
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

export function completedResult(taskId: string): TaskResult {
  return { taskId, status: "completed", detail: "task completed and verified successfully" };
}

export function failedResult(taskId: string, detail: string): TaskResult {
  return { taskId, status: "failed", detail };
}

export function blockedResult(taskId: string, detail: string): TaskResult {
  return { taskId, status: "blocked", detail };
}

export interface CoreLoopDeps {
  readonly config: CoreLoopConfig;
  readonly workItemRepo: WorkItemRepository;
  readonly eventStore: Pick<EventStoreRepository, "publish">;
  readonly failedApproachRepo: Pick<FailedApproachRepository, "record">;
  /**
   * Holds each project's target workspace path (migration 024) and its status:
   * the gate admits only active projects' tasks and blocks a project with a bad
   * row (migration 025). ProjectRepository satisfies it.
   */
  readonly projectRepo: WorkspacePathStore & Parameters<typeof PlanningService.gate>[1];
  readonly developmentService: Pick<DevelopmentService, "execute">;
  readonly eventLogger?: EventLogger;
  readonly failureRouter: FailureRecoveryDeps["failureRouter"];
  /** The one spend cap, read from llm_calls: checked before every cycle's work and between its steps. */
  readonly spendCap: SpendCapPort;
  /**
   * The Liaison's handling of the client's stops, run first in every cycle,
   * before the spend-cap check: a stopped project is never intaken, planned or gated.
   */
  readonly clientStops: LiaisonClientStops;
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
  /** The Liaison's block of a project whose check disputes passed their bound; blockReports posts its one report. */
  readonly disputeReports: LiaisonCheckDisputes;
  /**
   * Quality's durable record of the reviews of plan revisions' suites (ADR-074 addendum 2 d71 c):
   * how many reviews named each check task bounds its reopens.
   */
  readonly suiteReviewFindings: SuiteReviewFindingRecord;
  /** The Liaison's block of a project whose suite review named a check task past its bound; blockReports posts its one report. */
  readonly suiteReviewReports: LiaisonSuiteReviews;
  /**
   * The Liaison's one report per project block, per resumption after an operator's unblock and
   * per task block; run every cycle, at the budget cap too (no LLM call).
   */
  readonly blockReports: LiaisonBlockReports;
  /** What the automatic exits of Blocked tasks read; re-checked every cycle before the gate. */
  readonly parkedExits: ParkedExitChecks;
  /**
   * The roster role doing a project's environment work, from its latest roster: the owner of the
   * environment task an implementation's request opens (ADR-074 addendum 2 d66 b). `none`, with
   * why, when the roster names no such role; a roster that cannot be read throws.
   */
  readonly environmentOwner: (projectId: ProjectId) => Promise<EnvironmentOwner>;
}

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
    readonly kind: "contradiction" | "outside-vision";
    readonly problem: string;
    readonly evidence: string;
  }>;
}

/** Appends the findings; resolves, per named check task, to how many reviews have named it, this one included. */
interface SuiteReviewFindingRecord {
  record(findings: SuiteReviewFindingsEntry): Promise<ReadonlyMap<string, number>>;
}
