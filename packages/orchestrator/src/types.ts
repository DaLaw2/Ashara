import type {
  EventStoreRepository,
  BrainstormLogRepository,
  FailedApproachRepository,
  ContextBriefRepository,
  VisionRepository,
  CostRepository,
} from "@ashara/db";
import type { ProductObservation, ProjectContract } from "@ashara/shared";
import type {
  RunSummary,
  TerminationDecision,
  ReplanLLM,
  WorkItemRepository,
  ContractRepository,
  BrainstormEngine,
  NorthStarChecker,
  DecompositionEngine,
  ProposalEmbedder,
  AcceptanceLLM,
  AcceptanceVerdict,
  FailureRouter,
  ContractRegistryLookup,
} from "./acl/planning-acl.js";
import type { DevelopmentService } from "./acl/development-acl.js";
import type { EventLogger } from "./event-logger.js";
import type { RunStateStore } from "./run-state.js";

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
  readonly maxReplanRounds?: number;
  readonly maxGapAttempts?: number;
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
  brainstormCooldownThreshold: 3,
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
  /**
   * What this dispatch cost, or `null` for "an agent ran and we cannot tell".
   * The identity element is deliberately unavailable here (Discipline A): a
   * crashed, timed-out or malformed agent run used to read as `0`, and a `0`
   * that flows into the cap gating a runaway is not a measurement, it is an
   * assumption the caller never knew it was making. `null` forces the budget to
   * decide what an unbounded run costs; see BudgetTracker.accumulateCost.
   */
  readonly costUsd: number | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly modelId: string | null;
  /** Which agent invocation (1 = original, 2 = the single retry) produced this cost. */
  readonly attempt: number;
}

/** No agent was dispatched, so $0 is MEASURED, not assumed. */
export function zeroCost(): TaskCostInfo {
  return { costUsd: 0, inputTokens: 0, outputTokens: 0, modelId: null, attempt: 1 };
}

export function costFromOutput(
  output: Record<string, unknown>,
  attempt: number,
  agentInvoked: boolean,
): TaskCostInfo {
  const rawCost = output.total_cost;
  // No total_cost AND the agent was launched => tokens were burned and the
  // amount is unrecoverable. No total_cost and no launch => genuinely nothing.
  const costUsd =
    typeof rawCost === "number" && Number.isFinite(rawCost) && rawCost >= 0
      ? rawCost
      : agentInvoked
        ? null
        : 0;
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
  readonly failureRouter: FailureRouter;
  /**
   * Shares one DB transaction between decomposeLeafStories' work-item creation
   * and its derived ProjectContract write (ADR-028 + ADR-029, mig-phase-9).
   *
   * Required (ADR-052). "Tests that don't care about the contract shadow-write
   * may omit it" stopped being true when decomposeLeafStories began READING the
   * project's knowledge graph from the contract; omitting it now means planning
   * against no stated stack.
   */
  readonly withPlanningTransaction: <T>(
    fn: (repos: { workItemRepo: WorkItemRepository; contractRepo: ContractRepository }) => Promise<T>,
  ) => Promise<T>;
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
  /**
   * The contract is a required part of the request, not an optional extra: it is
   * what names the endpoints to probe and the entry point to launch. A defaulted
   * positional made `observeProduct(path)` typecheck while observing nothing, so
   * the caller must state the contract even when it is `null`.
   */
  readonly observeProduct?: (input: {
    readonly targetPath: string;
    readonly contract: ProjectContract | null;
  }) => Promise<ProductObservation>;
  /**
   * Per-run cap counters. Mutated in-process by the components that enforce them
   * (termination-snapshot, liveness-handler) and written through to the durable
   * run record by CoreLoop after every accrual — a cap that only exists in
   * process memory is not a cap (Discipline B), which is what let this one and
   * the budget reset to zero on every restart.
   */
  acceptanceAttempts: number;
  /**
   * The last acceptance evaluation that actually ran this process. Loop-internal
   * memo written by termination-snapshot, not a wired dependency: a termination can
   * be superseded by a NOTIFY and re-entered (runner.ts), and the re-entry may find
   * the attempt cap spent. Run 39 recomputed from scratch there and published
   * `accepted` over a verdict that had just listed five open gaps.
   */
  lastAcceptanceVerdict?: AcceptanceVerdict;
  readonly replanLlm?: ReplanLLM;
  replanRounds: number;
  /** Durable home of every per-run cap counter above, plus the budget's spend. */
  readonly runStateStore: RunStateStore;
}
