import type { RunSummary, TerminationDecision } from "@ashara/planning";
import type {
  EventStoreRepository,
  BrainstormLogRepository,
  FailedApproachRepository,
  ContextBriefRepository,
  VisionRepository,
  CostRepository,
} from "@ashara/db";
import type { WorkItemRepository, ContractRepository } from "@ashara/planning";
import type { BrainstormEngine, NorthStarChecker, DecompositionEngine } from "@ashara/planning";
import type { ProposalEmbedder, SpecDerivationLLM } from "@ashara/planning";
import type { AcceptanceLLM } from "@ashara/planning";
import type { Router, FailureRouter } from "@ashara/planning";
import type { DevelopmentService } from "@ashara/development";
import type { ProductObservation } from "@ashara/shared";

import type { ContractRegistryLookup } from "@ashara/planning";
import type { EventLogger } from "./event-logger.js";

export interface CoreLoopConfig {
  readonly repoPath: string;
  readonly workdirBase: string;
  readonly baseBranch: string;
  readonly maxBatchSize: number;
  readonly budgetLimitUsd: number;
  readonly agentTimeoutMs: number;
  readonly maxRetries: number;
  readonly useRealAgent: boolean;
  readonly asharaSourceDir: string;
  readonly selfUrl: string;
  readonly apiToken: string;
  readonly brainstormCooldownThreshold: number;
  readonly maxPendingWorkItems: number;
  readonly maxBrainstormItems: number;
  readonly brainstormTimeoutMs: number;
  readonly northstarTimeoutMs: number;
  readonly decompositionTimeoutMs: number;
  readonly verifyTimeoutMs: number;
  /**
   * Coverage reconciliation mode (mig9-t2, ADR-032 §2). `true` (default) ENFORCES:
   * uncovered declared endpoints are proposed as tasks, the rollup holds over open
   * gaps, and completeness cannot fire with a gap open. `false` is the observe-only
   * rollback: gaps are logged and reported in the run summary but never block.
   */
  readonly coverageEnforcing: boolean;
  readonly maxAcceptanceAttempts: number;
}

export const DEFAULT_CONFIG: CoreLoopConfig = {
  repoPath: ".",
  workdirBase: "",
  baseBranch: "master",
  maxBatchSize: 2,
  budgetLimitUsd: 5.0,
  agentTimeoutMs: 300_000,
  maxRetries: 1,
  useRealAgent: false,
  asharaSourceDir: ".",
  selfUrl: "",
  apiToken: "",
  brainstormCooldownThreshold: 8,
  maxPendingWorkItems: 15,
  maxBrainstormItems: 3,
  brainstormTimeoutMs: 120_000,
  northstarTimeoutMs: 60_000,
  decompositionTimeoutMs: 120_000,
  verifyTimeoutMs: 120_000,
  coverageEnforcing: true,
  maxAcceptanceAttempts: 2,
};

export interface CycleResult {
  readonly tasksProcessed: number;
  readonly results: TaskResult[];
  /**
   * The run-termination verdict computed at this cycle's quiescent point (mig-phase-7).
   * Always set by CoreLoop.runCycle; optional on the type so lighter CycleResult
   * literals (and the runner's structural double) need not fabricate one — the runner
   * treats an absent verdict as "keep cycling".
   */
  readonly termination?: TerminationOutcome;
}

/**
 * The terminate-or-continue decision for a cycle, plus the human/machine-readable
 * RunSummary the runner emits when it actually stops (built only on a `stop`
 * decision — a summary presupposes a stop reason). Kept together so the runner
 * consumes one object: the decision drives the flag/wake-race logic; the summary
 * is what `emitRunSummary` publishes and prints.
 */
export interface TerminationOutcome {
  readonly decision: TerminationDecision;
  readonly summary: RunSummary | null;
}

export interface TaskResult {
  readonly taskId: string;
  readonly status: TaskResultStatus;
  readonly detail: string;
}

export type TaskResultStatus = "completed" | "failed" | "blocked" | "retrying";

export function completedResult(taskId: string): TaskResult {
  return { taskId, status: "completed", detail: "task completed and verified successfully" };
}

export function failedResult(taskId: string, detail: string): TaskResult {
  return { taskId, status: "failed", detail };
}

export function blockedResult(taskId: string, detail: string): TaskResult {
  return { taskId, status: "blocked", detail };
}

export interface BrainstormTriggerInfo {
  readonly reason: string;
  readonly level: string;
  readonly context: string;
  readonly relatedItemIds: string[];
}

export interface TaskCostInfo {
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly modelId: string | null;
  /** Which agent invocation (1 = original, 2 = the single retry) produced this cost. */
  readonly attempt: number;
}

export function zeroCost(): TaskCostInfo {
  return { costUsd: 0, inputTokens: 0, outputTokens: 0, modelId: null, attempt: 1 };
}

export function costFromOutput(output: Record<string, unknown>, attempt: number): TaskCostInfo {
  const costUsd = typeof output.total_cost === "number" ? output.total_cost : 0;
  const tokens = output.total_tokens as Record<string, unknown> | undefined;
  const inputTokens = typeof tokens?.input === "number" ? tokens.input : 0;
  const outputTokens = typeof tokens?.output === "number" ? tokens.output : 0;
  const errorDetail = output.error_detail as Record<string, unknown> | undefined;
  const modelId = typeof errorDetail?.model === "string" ? errorDetail.model : null;
  return { costUsd, inputTokens, outputTokens, modelId, attempt };
}

export interface CoreLoopDeps {
  readonly config: CoreLoopConfig;
  readonly workItemRepo: WorkItemRepository;
  readonly eventStore: EventStoreRepository;
  readonly costRepo: CostRepository;
  readonly brainstormLogRepo: BrainstormLogRepository;
  readonly failedApproachRepo: FailedApproachRepository;
  readonly contextBriefRepo: ContextBriefRepository;
  readonly visionRepo: VisionRepository;
  readonly brainstormEngine: BrainstormEngine;
  readonly northstarChecker: NorthStarChecker;
  readonly decompositionEngine: DecompositionEngine;
  readonly developmentService: DevelopmentService;
  readonly embedder?: ProposalEmbedder | null;
  readonly eventLogger?: EventLogger;
  readonly router?: Router;
  readonly failureRouter: FailureRouter;
  /**
   * Shares one DB transaction between decomposeLeafStories' work-item creation
   * and its derived ProjectContract write (ADR-028 + ADR-029, mig-phase-9).
   * Optional — the composition root wires a real one; tests that don't care
   * about the contract shadow-write may omit it.
   */
  readonly withPlanningTransaction?: <T>(
    fn: (repos: { workItemRepo: WorkItemRepository; contractRepo: ContractRepository }) => Promise<T>,
  ) => Promise<T>;
  /**
   * The INDEPENDENT vision-derived endpoint pass (ADR-032 §2, mig9-t1). Wired by
   * the composition root when a real gateway is present; absent (stub mode) the
   * derivation is skipped exactly like the shadow contract write.
   */
  readonly specDerivationLlm?: SpecDerivationLLM | null;
  /**
   * Resolves a failed item's ProjectContract so the FailureRouter can substitute
   * by the module/endpoint registry, not just by title (mig9-t4). Optional — the
   * composition root wires it; without it, recovery uses title equivalence.
   */
  readonly contractLookup?: ContractRegistryLookup;
  /**
   * The ProjectContract repository (read + amend), for coverage reconciliation
   * (mig9-t2): computing open coverage gaps, proposing coverage tasks, holding
   * rollups over open gaps, and counting gaps for the termination summary.
   * Optional — absent, reconciliation is skipped (no contract to reconcile).
   */
  readonly contractRepo?: ContractRepository;
  readonly acceptanceLlm?: AcceptanceLLM;
  readonly observeProduct?: (targetPath: string) => Promise<ProductObservation>;
  acceptanceAttempts: number;
}
