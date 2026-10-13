import type {
  EventStoreRepository,
  FailedApproachRepository,
  VisionRepository,
  CostRepository,
} from "@ashara/db";
import type { ContractRepository } from "@ashara/shared";
import type { AgentOutputJson } from "@ashara/shared/agent-output";
import type {
  WorkItemRepository,
  FailureRouter,
  ContractRegistryLookup,
} from "./acl/planning-acl.js";
import type { DevelopmentService } from "./acl/development-acl.js";
import type { EventLogger } from "./event-logger.js";
import type { RunStateStore } from "./run-state.js";

export interface CoreLoopConfig {
  readonly workdirBase: string;
  readonly baseBranch: string;
  readonly maxBatchSize: number;
  readonly budgetLimitUsd: number;
  readonly agentTimeoutMs: number;
  readonly maxRetries: number;
  readonly asharaSourceDir: string;
  readonly decompositionTimeoutMs: number;
  readonly verifyTimeoutMs: number;
  /**
   * Coverage reconciliation mode (mig9-t2, ADR-032 §2). `true` (default) ENFORCES:
   * uncovered declared endpoints are proposed as tasks and the rollup holds over open
   * gaps. `false` is the observe-only rollback: gaps are logged but never block.
   */
  readonly coverageEnforcing: boolean;
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
  budgetLimitUsd: 5.0,
  agentTimeoutMs: 300_000,
  maxRetries: 1,
  asharaSourceDir: ".",
  decompositionTimeoutMs: 120_000,
  verifyTimeoutMs: 120_000,
  coverageEnforcing: true,
};

export interface CycleResult {
  readonly tasksProcessed: number;
  readonly results: TaskResult[];
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
  output: AgentOutputJson | null,
  attempt: number,
  agentInvoked: boolean,
): TaskCostInfo {
  if (!output) {
    // No output means no agent ran (early exit) or the output was unavailable.
    // agentInvoked distinguishes "genuinely $0" from "unknown cost."
    return { costUsd: agentInvoked ? null : 0, inputTokens: 0, outputTokens: 0, modelId: null, attempt };
  }
  // An unmeasured run's total_cost is understated (at least one gateway call
  // contributed $0 because its provider reported no token counts). Treat the
  // entire run's cost as unknown so the budget's unknownCostCharge fires
  // rather than the ledger recording a number known to be wrong.
  if (!output.cost_measured) {
    return { costUsd: null, inputTokens: output.total_tokens.input, outputTokens: output.total_tokens.output, modelId: output.error_detail?.model ?? null, attempt };
  }
  const costUsd =
    Number.isFinite(output.total_cost) && output.total_cost >= 0
      ? output.total_cost
      : agentInvoked
        ? null
        : 0;
  return {
    costUsd,
    inputTokens: output.total_tokens.input,
    outputTokens: output.total_tokens.output,
    modelId: output.error_detail?.model ?? null,
    attempt,
  };
}

export interface CoreLoopDeps {
  readonly config: CoreLoopConfig;
  readonly workItemRepo: WorkItemRepository;
  readonly eventStore: EventStoreRepository;
  readonly costRepo: CostRepository;
  readonly failedApproachRepo: FailedApproachRepository;
  readonly visionRepo: VisionRepository;
  readonly developmentService: DevelopmentService;
  readonly eventLogger?: EventLogger;
  readonly failureRouter: FailureRouter;
  /**
   * Shares one DB transaction between coverage reconciliation's work-item
   * creation and its ProjectContract amend (ADR-028 + ADR-029, mig-phase-9).
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
   * (mig9-t2): computing open coverage gaps, proposing coverage tasks, and holding
   * rollups over open gaps.
   * Optional — absent, reconciliation is skipped (no contract to reconcile).
   */
  readonly contractRepo?: ContractRepository;
  /** Durable home of the budget's spend. */
  readonly runStateStore: RunStateStore;
}
