import type { EventStoreRepository, FailedApproachRepository, ProjectRepository } from "@ashara/db";
import type { WorkItemRepository, FailureRouter, FirstPlanning } from "./acl/planning-acl.js";
import type { DevelopmentService } from "./acl/development-acl.js";
import type { LiaisonClientStops, LiaisonIntake, LiaisonPlanReports, LiaisonStackChoices } from "./acl/engagement-acl.js";
import type { RosterDerivationStep } from "./acl/organization-acl.js";
import type { EventLogger } from "./event-logger.js";

export interface CoreLoopConfig {
  readonly workdirBase: string;
  readonly baseBranch: string;
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
  baseBranch: "master",
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

export interface TaskResult {
  readonly taskId: string;
  readonly status: TaskResultStatus;
  readonly detail: string;
}

type TaskResultStatus = "completed" | "failed" | "blocked" | "retrying";

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
  readonly eventStore: EventStoreRepository;
  readonly failedApproachRepo: FailedApproachRepository;
  /**
   * Holds each project's target workspace path (migration 024) and its status:
   * the gate admits only active projects' tasks and blocks a project with a bad
   * row (migration 025).
   */
  readonly projectRepo: ProjectRepository;
  readonly developmentService: DevelopmentService;
  readonly eventLogger?: EventLogger;
  readonly failureRouter: FailureRouter;
  /** The one spend cap, read from llm_calls: checked before every cycle's work and between its steps. */
  readonly spendCap: SpendCapPort;
  /**
   * The Liaison's handling of the client's stops, run first in every cycle,
   * before the spend-cap check: a stopped project is never intaken, planned or gated.
   */
  readonly clientStops: LiaisonClientStops;
  /** The Liaison's tender intake, run each cycle before work-item gating. */
  readonly liaisonIntake: LiaisonIntake;
  /** Organization's roster for each project with vision v1 and none, run after intake. */
  readonly rosterDerivation: RosterDerivationStep;
  /** Delivery's first plan of each project awaiting one (and holding a roster), run after the roster step. */
  readonly firstPlanning: FirstPlanning;
  /** The Liaison's reports on recorded planning outcomes, run after planning. */
  readonly planReports: LiaisonPlanReports;
  /**
   * The stack each merged Sprint 0 task chose, made an Inferred assumption in a new vision
   * version and reported to the client once; run every cycle, at the budget cap too (no LLM call).
   */
  readonly stackChoices: LiaisonStackChoices;
}
