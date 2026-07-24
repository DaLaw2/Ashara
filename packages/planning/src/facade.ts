/**
 * PlanningFacade — Open Host Service for the Planning Bounded Context (ADR-044,
 * Phase 2). Consolidates all operations the Orchestrator calls into a single
 * entry point, hiding domain internals (WorkItem, DependencyGraph, GateKeeper,
 * LifecycleRouter, etc.) behind high-level methods.
 *
 * Design: thin coordinator — every method delegates to existing domain services
 * and lifecycle functions. The facade receives its dependencies via constructor
 * (repos, engines, routers) and returns Published Language types from
 * @ashara/shared where possible.
 */

import type {
  WorkItemId,
  WorkItemLevel,
  WorkItemStatus,
  DomainEvent,
  ContractRepository,
  ProjectContract,
  ProductObservation,
} from "@ashara/shared";

import type { WorkItem } from "./domain/work-item.js";
import type { WorkItemRepository } from "./domain/repository.js";
import type { CoverageHold } from "./domain/router.js";
import { PlanningService } from "./domain/service.js";
import { DependencyGraph } from "./domain/dependency.js";
import {
  canTransitionTo,
  failWorkItem,
  startWorkItem as startWorkItemDomain,
  requeueWorkItem as requeueWorkItemDomain,
  takeEvents,
  createPendingWorkItem,
} from "./domain/work-item.js";

import type { DecompositionEngine } from "./decomposition.js";
import { decomposeLeafStories } from "./story-decomposer.js";
import type { StoryDecomposerDeps } from "./story-decomposer.js";

import type { BrainstormOrchestrationDeps, BrainstormTriggerInfo } from "./brainstorm-orchestrator.js";
import {
  checkBrainstormTriggers as checkBrainstormTriggersImpl,
  executeBrainstorm as executeBrainstormImpl,
  executeGatedBrainstorm as executeGatedBrainstormImpl,
} from "./brainstorm-orchestrator.js";
import type { BrainstormEngine } from "./brainstorm.js";
import type { BrainstormLogSink, ContextBriefSource } from "./brainstorm-orchestrator.js";
import type { ProposalEmbedder } from "./proposal-dedup.js";

import type { NorthStarCheckDeps } from "./northstar-orchestrator.js";
import { checkNorthStarAlignment as checkNorthStarAlignmentImpl } from "./northstar-orchestrator.js";
import type { NorthStarChecker } from "./northstar.js";

import type { FailureRouter, RawFailureContext, FailureDecision } from "./failure-router.js";
import type { ContractRegistryLookup, FailureRecoveryDeps } from "./lifecycle/failure-recovery.js";
import { recoverFailedItem as recoverFailedItemImpl } from "./lifecycle/failure-recovery.js";
import type { TaskSplitDeps } from "./lifecycle/task-split.js";
import { shouldSplit as shouldSplitImpl, splitFailedTask as splitFailedTaskImpl } from "./lifecycle/task-split.js";
import type { EventPublisher, EventSink } from "./lifecycle/ports.js";

import type { SnapshotAssemblyDeps } from "./lifecycle/termination-snapshot.js";
import { assembleRunSummaryItems as assembleRunSummaryItemsImpl } from "./lifecycle/termination-snapshot.js";
import type { TerminationSnapshot } from "./lifecycle/termination.js";
import { evaluate as evaluateImpl } from "./lifecycle/termination.js";
import type { RunSummaryItem } from "./lifecycle/run-summary.js";
import { buildRunSummary as buildRunSummaryImpl, emitRunSummary as emitRunSummaryImpl } from "./lifecycle/run-summary.js";

import type { EndpointCoverageGap, RunSummary } from "./run-summary.js";
import type { TerminationDecision, TerminationStop, TerminationPlanExhausted } from "./termination.js";
import type { AcceptanceGap, AcceptanceVerdict, VisionGapResult } from "./acceptance.js";

import {
  reconcileCoverage as reconcileCoverageImpl,
  computeCoverageGaps as computeCoverageGapsImpl,
  isBlockingCoverageGap as isBlockingCoverageGapImpl,
  createCoverageRollupGuard as createCoverageRollupGuardImpl,
} from "./coverage-reconciliation.js";
import type { CoverageReconciliationDeps, CoverageRollupGuardDeps } from "./coverage-reconciliation.js";

import { recoverFromAbandoned as recoverFromAbandonedImpl } from "./liveness-recovery.js";
import type { LivenessRecoveryDeps, FailedApproachSource } from "./liveness-recovery.js";

import type { ReplanLLM } from "./replan-from-vision.js";
import {
  buildDeterministicGaps as buildDeterministicGapsImpl,
  buildVisionGaps as buildVisionGapsImpl,
  buildAcceptanceVerdict as buildAcceptanceVerdictImpl,
} from "./acceptance.js";

// ---------------------------------------------------------------------------
// Published types for facade consumers
// ---------------------------------------------------------------------------

/**
 * A task selected for dispatch — the Published Language projection of a WorkItem
 * that the orchestrator needs to build a TaskDescriptor and manage dispatch.
 * Deliberately carries only the fields orchestrator actually reads, so internal
 * domain fields (events, createdAt, updatedAt, successCriteria, northStar, etc.)
 * are not exposed.
 */
export interface SelectedTask {
  readonly id: WorkItemId;
  readonly title: string;
  readonly level: WorkItemLevel;
  readonly status: WorkItemStatus;
  readonly parentId: WorkItemId | undefined;
  readonly taskSpec: Record<string, unknown> | undefined;
  readonly blockedReason: Record<string, unknown> | undefined;
  readonly dispatchCount: number;
  readonly description: string | undefined;
}

/**
 * Dependencies for constructing a PlanningFacade. Injected at the composition
 * root; each field maps to one or more internal domain services the facade
 * delegates to.
 */
export interface PlanningFacadeDeps {
  readonly workItemRepo: WorkItemRepository;
  readonly decompositionEngine: DecompositionEngine;
  readonly brainstormEngine: BrainstormEngine;
  readonly brainstormLogSink: BrainstormLogSink;
  readonly contextBriefSource: ContextBriefSource;
  readonly northstarChecker: NorthStarChecker;
  readonly failureRouter: FailureRouter;
  readonly eventPublisher: EventPublisher;

  /** Optional: embedder for brainstorm deduplication. */
  readonly embedder?: ProposalEmbedder | null;

  /** Optional: contract repo for coverage reconciliation. */
  readonly contractRepo?: ContractRepository;

  /** Optional: contract lookup for failure recovery substitution. */
  readonly contractLookup?: ContractRegistryLookup;

  /** Optional: LLM for liveness recovery (replan from vision). */
  readonly replanLlm?: ReplanLLM;

  /** Optional: shares a DB transaction between work-item creation and contract write. */
  readonly withPlanningTransaction?: <T>(
    fn: (repos: { workItemRepo: WorkItemRepository; contractRepo: ContractRepository }) => Promise<T>,
  ) => Promise<T>;

  /** Optional: failed-approach persistence for liveness recovery. */
  readonly failedApproachRepo?: FailedApproachSource;

  /** Optional: event sink for run summary emission. */
  readonly eventSink?: EventSink;

  // Brainstorm configuration
  readonly brainstormCooldownThreshold: number;
  readonly maxPendingWorkItems: number;
  readonly maxBrainstormItems: number;

  // Decomposition configuration
  readonly repoPath: string;
  readonly detectTechStack?: (dir: string) => Promise<string[]>;
  readonly readManifestContext?: (dir: string) => Promise<string | undefined>;

  // Coverage configuration
  readonly coverageEnforcing: boolean;
}

// ---------------------------------------------------------------------------
// Facade
// ---------------------------------------------------------------------------

export class PlanningFacade {
  private readonly deps: PlanningFacadeDeps;

  constructor(deps: PlanningFacadeDeps) {
    this.deps = deps;
  }

  // -----------------------------------------------------------------------
  // Gate + Select (orchestrator core-loop step 6)
  // -----------------------------------------------------------------------

  /**
   * Filters eligible work items through the gate, computes unlock weights via the
   * dependency graph, and selects up to `maxBatchSize` tasks for dispatch. Returns
   * SelectedTask projections — the Published Language view of the internal WorkItem.
   */
  async gateAndSelect(maxBatchSize: number): Promise<SelectedTask[]> {
    const eligible = await PlanningService.gate(this.deps.workItemRepo);
    if (eligible.length === 0) return [];

    const graph = await DependencyGraph.load(this.deps.workItemRepo);
    const unlockWeights = graph.computeUnlockWeights();
    const selected = PlanningService.select(eligible, maxBatchSize, unlockWeights);

    return selected.map(toSelectedTask);
  }

  /**
   * Gate only — returns eligible work items without selecting. Used when the
   * orchestrator needs to check whether dispatchable work exists (e.g. after
   * liveness recovery) before running its own select.
   */
  async gate(): Promise<SelectedTask[]> {
    const eligible = await PlanningService.gate(this.deps.workItemRepo);
    return eligible.map(toSelectedTask);
  }

  // -----------------------------------------------------------------------
  // Lifecycle routing (orchestrator execution.ts)
  // -----------------------------------------------------------------------

  /**
   * Routes a task completion through the LifecycleRouter, cascading parent
   * completion as appropriate. Returns domain events for audit publishing.
   */
  async routeSuccess(taskId: WorkItemId, coverageHold?: CoverageHold): Promise<DomainEvent[]> {
    return PlanningService.route(this.deps.workItemRepo, taskId, true, coverageHold);
  }

  /**
   * Routes a task failure through the LifecycleRouter. If the router throws, falls
   * back to a direct domain-level failWorkItem call (fail-closed: the item must
   * NOT stay InProgress when the agent has stopped). Returns domain events for
   * audit publishing.
   */
  async routeFailure(taskId: WorkItemId): Promise<DomainEvent[]> {
    try {
      return await PlanningService.route(this.deps.workItemRepo, taskId, false);
    } catch (e) {
      console.warn(`[${taskId}] lifecycle route failed, falling back to domain method:`, e);
      const item = await PlanningService.findWorkItem(this.deps.workItemRepo, taskId);
      if (!item || !canTransitionTo(item.status, "Failed")) {
        return [];
      }
      const previousStatus = item.status;
      failWorkItem(item, { reason: "orchestrator error" });
      await PlanningService.saveWorkItem(this.deps.workItemRepo, item, previousStatus);
      return takeEvents(item);
    }
  }

  // -----------------------------------------------------------------------
  // Work item state transitions (orchestrator execution.ts)
  // -----------------------------------------------------------------------

  /**
   * Starts a work item (Pending -> InProgress) and returns domain events.
   * Validates the transition via the domain method; throws InvalidStatusTransition
   * if the item is not in Pending.
   */
  // TODO(ADR-044): replace WorkItem with Published Language type
  async startWorkItem(item: WorkItem): Promise<DomainEvent[]> {
    const previousStatus = item.status;
    startWorkItemDomain(item);
    await PlanningService.saveWorkItem(this.deps.workItemRepo, item, previousStatus);
    return takeEvents(item);
  }

  /**
   * Activates ancestor work items when a child starts (cascading InProgress up
   * the tree). Returns domain events for audit publishing.
   */
  async activateAncestors(parentId: WorkItemId | undefined): Promise<DomainEvent[]> {
    return PlanningService.activateAncestors(this.deps.workItemRepo, parentId);
  }

  /**
   * Atomically increments the dispatch counter for a work item (migration 018,
   * r9f-t1). Must be called at the dispatch seam BEFORE the agent runs.
   */
  async incrementDispatchCount(itemId: WorkItemId): Promise<void> {
    await this.deps.workItemRepo.incrementDispatchCount(itemId);
  }

  /**
   * Requeues a crash-orphaned InProgress item back to Pending (startup
   * reconciliation). Returns domain events for audit publishing.
   */
  // TODO(ADR-044): replace WorkItem with Published Language type
  async requeueWorkItem(item: WorkItem): Promise<DomainEvent[]> {
    const previousStatus = item.status;
    requeueWorkItemDomain(item);
    await this.deps.workItemRepo.save(item, previousStatus);
    return takeEvents(item);
  }

  // -----------------------------------------------------------------------
  // Work item CRUD (orchestrator execution.ts, bug-fix.ts)
  // -----------------------------------------------------------------------

  /**
   * Finds a work item by ID. Returns null if not found.
   */
  // TODO(ADR-044): replace WorkItem return with Published Language type
  async findWorkItem(id: WorkItemId): Promise<WorkItem | null> {
    return PlanningService.findWorkItem(this.deps.workItemRepo, id);
  }

  /**
   * Persists a work item mutation. `expectedPreviousStatus` is the pre-image
   * the caller loaded the item with; the repository validates the transition.
   */
  // TODO(ADR-044): replace WorkItem with Published Language type
  async saveWorkItem(item: WorkItem, expectedPreviousStatus: WorkItemStatus): Promise<void> {
    return PlanningService.saveWorkItem(this.deps.workItemRepo, item, expectedPreviousStatus);
  }

  /**
   * Creates a new pending work item and persists it. Returns the persisted item.
   */
  // TODO(ADR-044): replace WorkItem return with Published Language type
  async createWorkItem(
    level: WorkItemLevel,
    title: string,
    parentId: WorkItemId | undefined,
    description?: string,
    taskSpec?: Record<string, unknown>,
  ): Promise<WorkItem> {
    const item = createPendingWorkItem(level, title, parentId, description, taskSpec);
    return PlanningService.createWorkItem(this.deps.workItemRepo, item);
  }

  /**
   * Lists all work items. Used by termination snapshot, coverage, and liveness.
   */
  // TODO(ADR-044): replace WorkItem[] return with Published Language type
  async listAll(): Promise<WorkItem[]> {
    return this.deps.workItemRepo.listAll();
  }

  /**
   * Finds work items by status. Used by startup reconciler and brainstorm gate.
   */
  // TODO(ADR-044): replace WorkItem[] return with Published Language type
  async findByStatus(status: WorkItemStatus): Promise<WorkItem[]> {
    return PlanningService.findByStatus(this.deps.workItemRepo, status);
  }

  /**
   * Finds children of a parent work item.
   */
  // TODO(ADR-044): replace WorkItem[] return with Published Language type
  async findChildren(parentId: WorkItemId): Promise<WorkItem[]> {
    return this.deps.workItemRepo.findChildren(parentId);
  }

  // -----------------------------------------------------------------------
  // Decomposition (orchestrator core-loop step 4)
  // -----------------------------------------------------------------------

  /**
   * Decomposes leaf stories that have no children into tasks. Returns the count
   * of stories decomposed.
   */
  async decomposeLeafStories(): Promise<number> {
    const decomposerDeps: StoryDecomposerDeps = {
      workItemRepo: this.deps.workItemRepo,
      decompositionEngine: this.deps.decompositionEngine,
      repoPath: this.deps.repoPath,
      detectTechStack: this.deps.detectTechStack,
      readManifestContext: this.deps.readManifestContext,
      withPlanningTransaction: this.deps.withPlanningTransaction,
    };
    return decomposeLeafStories(decomposerDeps);
  }

  // -----------------------------------------------------------------------
  // Failure recovery (orchestrator execution.ts, startup-reconciler.ts)
  // -----------------------------------------------------------------------

  /**
   * Routes a Failed work item through the FailureRouter for recovery (replan,
   * substitute, or abandon). Returns the decision action taken.
   */
  // TODO(ADR-044): replace WorkItem with Published Language type
  async recoverFailedItem(
    item: WorkItem,
    failure: RawFailureContext,
  ): Promise<FailureDecision["action"]> {
    const recoveryDeps: FailureRecoveryDeps = {
      workItemRepo: this.deps.workItemRepo,
      eventPublisher: this.deps.eventPublisher,
      failureRouter: this.deps.failureRouter,
      contractLookup: this.deps.contractLookup,
    };
    return recoverFailedItemImpl(recoveryDeps, item, failure);
  }

  // -----------------------------------------------------------------------
  // Task split (orchestrator execution.ts)
  // -----------------------------------------------------------------------

  /**
   * Determines whether a failed task should be split (turn limit hit with
   * partial file progress and no prior split).
   */
  // TODO(ADR-044): replace task parameter with Published Language type
  shouldSplit(finishReason: string, filesChanged: number, task: Pick<WorkItem, "taskSpec">): boolean {
    return shouldSplitImpl(finishReason, filesChanged, task);
  }

  /**
   * Splits a failed task into two sequential subtasks and abandons the original.
   */
  // TODO(ADR-044): replace WorkItem with Published Language type
  async splitFailedTask(task: WorkItem, failure: RawFailureContext): Promise<void> {
    const splitDeps: TaskSplitDeps = {
      workItemRepo: this.deps.workItemRepo,
      eventPublisher: this.deps.eventPublisher,
    };
    return splitFailedTaskImpl(splitDeps, task, failure);
  }

  // -----------------------------------------------------------------------
  // Brainstorm (orchestrator post-cycle.ts)
  // -----------------------------------------------------------------------

  /**
   * Checks whether brainstorm triggers should fire based on the cycle result.
   * Returns the trigger info if fired, null otherwise.
   */
  async checkBrainstormTriggers(cycleResult: {
    readonly results: ReadonlyArray<{ readonly taskId: string; readonly status: string }>;
  }): Promise<BrainstormTriggerInfo | null> {
    return checkBrainstormTriggersImpl(this.buildBrainstormDeps(), cycleResult);
  }

  /**
   * Executes a brainstorm unconditionally (no gate check).
   */
  async executeBrainstorm(trigger: BrainstormTriggerInfo): Promise<void> {
    return executeBrainstormImpl(this.buildBrainstormDeps(), trigger);
  }

  /**
   * Executes a brainstorm only if the gate allows it (cooldown + pending cap).
   * Returns true if brainstorm ran, false if suppressed.
   */
  async executeGatedBrainstorm(trigger: BrainstormTriggerInfo): Promise<boolean> {
    return executeGatedBrainstormImpl(this.buildBrainstormDeps(), trigger);
  }

  private buildBrainstormDeps(): BrainstormOrchestrationDeps {
    return {
      workItemRepo: this.deps.workItemRepo,
      brainstormEngine: this.deps.brainstormEngine,
      brainstormLogSink: this.deps.brainstormLogSink,
      contextBriefSource: this.deps.contextBriefSource,
      embedder: this.deps.embedder ?? null,
      brainstormCooldownThreshold: this.deps.brainstormCooldownThreshold,
      maxPendingWorkItems: this.deps.maxPendingWorkItems,
      maxBrainstormItems: this.deps.maxBrainstormItems,
    };
  }

  // -----------------------------------------------------------------------
  // NorthStar alignment (orchestrator post-cycle.ts)
  // -----------------------------------------------------------------------

  /**
   * Checks whether completed tasks in the batch align with their story/epic
   * NorthStar. Returns true if drift was detected.
   */
  // TODO(ADR-044): replace WorkItem[] batch with Published Language type
  async checkNorthStarAlignment(
    batch: ReadonlyArray<WorkItem>,
    completedTaskIds: ReadonlyArray<string>,
  ): Promise<boolean> {
    const checkDeps: NorthStarCheckDeps = {
      workItemRepo: this.deps.workItemRepo,
      northstarChecker: this.deps.northstarChecker,
    };
    return checkNorthStarAlignmentImpl(checkDeps, batch, completedTaskIds);
  }

  // -----------------------------------------------------------------------
  // Coverage reconciliation (orchestrator post-cycle.ts, execution.ts)
  // -----------------------------------------------------------------------

  /**
   * Runs per-cycle coverage reconciliation: computes open coverage gaps from the
   * ProjectContract, and in enforcing mode proposes tasks for unplanned endpoints.
   * Returns the list of open gaps (both modes) for logging and run summary.
   */
  async reconcileCoverage(): Promise<EndpointCoverageGap[]> {
    if (!this.deps.contractRepo) return [];
    const reconDeps: CoverageReconciliationDeps = {
      workItemRepo: this.deps.workItemRepo,
      contractRepo: this.deps.contractRepo,
      withPlanningTransaction: this.deps.withPlanningTransaction,
      enforcing: this.deps.coverageEnforcing,
    };
    return reconcileCoverageImpl(reconDeps);
  }

  /**
   * Computes endpoint coverage gaps for a given contract and set of work items.
   * Pure function — no side effects, no task creation.
   */
  computeCoverageGaps(
    contract: ProjectContract | null,
    workItems: ReadonlyArray<Pick<WorkItem, "id" | "status">>,
  ): EndpointCoverageGap[] {
    return computeCoverageGapsImpl(contract, workItems);
  }

  /**
   * Whether a coverage gap is blocking (unplanned or planned-unbuilt, not
   * out-of-scope). Shared by the rollup guard and the termination completeness
   * check.
   */
  isBlockingCoverageGap(gap: EndpointCoverageGap): boolean {
    return isBlockingCoverageGapImpl(gap);
  }

  /**
   * Builds the rollup HOLD predicate: a parent must not settle Completed while
   * its project has an open blocking coverage gap. Returns undefined in
   * observe-only mode (no hold).
   */
  createCoverageRollupGuard(): CoverageHold | undefined {
    if (!this.deps.contractRepo) return undefined;
    const guardDeps: CoverageRollupGuardDeps = {
      workItemRepo: this.deps.workItemRepo,
      contractRepo: this.deps.contractRepo,
      enforcing: this.deps.coverageEnforcing,
    };
    return createCoverageRollupGuardImpl(guardDeps);
  }

  // -----------------------------------------------------------------------
  // Termination evaluation (orchestrator termination-snapshot.ts)
  // -----------------------------------------------------------------------

  /**
   * Assembles the run summary items from the current plan state. Each item
   * carries resolution, blocked-by, and recoverability for the termination
   * snapshot.
   */
  async assembleRunSummaryItems(): Promise<RunSummaryItem[]> {
    const snapshotDeps: SnapshotAssemblyDeps = {
      workItemRepo: this.deps.workItemRepo,
      replanBound: this.deps.failureRouter.replanBound,
    };
    return assembleRunSummaryItemsImpl(snapshotDeps);
  }

  /**
   * Evaluates a termination snapshot and returns the decision (continue, stop,
   * or plan_exhausted). Pure function over the snapshot.
   */
  evaluate(snapshot: TerminationSnapshot): TerminationDecision {
    return evaluateImpl(snapshot);
  }

  /**
   * Builds the run summary from items, endpoint gaps, and the termination
   * decision. The summary is a self-sufficient report of why the run stopped
   * and what remains undone.
   */
  buildRunSummary(
    input: {
      readonly items: readonly RunSummaryItem[];
      readonly endpointGaps?: readonly EndpointCoverageGap[];
      readonly acceptance?: AcceptanceVerdict;
    },
    decision: TerminationStop | TerminationPlanExhausted,
  ): RunSummary {
    return buildRunSummaryImpl(input, decision);
  }

  /**
   * Emits the run summary via the event sink and returns it.
   */
  emitRunSummary(summary: RunSummary): RunSummary {
    if (!this.deps.eventSink) return summary;
    return emitRunSummaryImpl(this.deps.eventSink, summary);
  }

  // -----------------------------------------------------------------------
  // Acceptance checking (orchestrator termination-snapshot.ts)
  // -----------------------------------------------------------------------

  /**
   * Builds deterministic acceptance gaps from a product observation and optional
   * contract. These are boot failures, unreachable routes, etc.
   */
  buildDeterministicGaps(
    observation: ProductObservation,
    contract: ProjectContract | null,
  ): AcceptanceGap[] {
    return buildDeterministicGapsImpl(observation, contract);
  }

  /**
   * Builds vision-derived acceptance gaps from an LLM gap check result.
   */
  buildVisionGaps(
    gapResult: VisionGapResult,
    visionText: string,
  ): AcceptanceGap[] {
    return buildVisionGapsImpl(gapResult, visionText);
  }

  /**
   * Builds the acceptance verdict from a list of gaps and the attempt counts.
   */
  buildAcceptanceVerdict(
    gaps: AcceptanceGap[],
    attempt: number,
    maxAttempts: number,
  ): AcceptanceVerdict {
    return buildAcceptanceVerdictImpl(gaps, attempt, maxAttempts);
  }

  // -----------------------------------------------------------------------
  // Liveness recovery (orchestrator liveness-handler.ts)
  // -----------------------------------------------------------------------

  /**
   * Attempts to recover from abandoned work items by using the replan LLM to
   * propose substitute tasks. Returns the number of substitute tasks created.
   * Requires replanLlm and failedApproachRepo to be wired; returns 0 if absent.
   */
  async recoverFromAbandoned(visionText: string): Promise<number> {
    if (!this.deps.replanLlm || !this.deps.failedApproachRepo) return 0;
    const recoveryDeps: LivenessRecoveryDeps = {
      workItemRepo: this.deps.workItemRepo,
      failedApproachRepo: this.deps.failedApproachRepo,
      replanLlm: this.deps.replanLlm,
      visionText,
    };
    return recoverFromAbandonedImpl(recoveryDeps);
  }

  // -----------------------------------------------------------------------
  // Accessors for dependency configuration
  // -----------------------------------------------------------------------

  /**
   * The replan bound from the wired FailureRouter — exposed so the termination
   * seam shares the same bound.
   */
  get replanBound(): number {
    return this.deps.failureRouter.replanBound;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toSelectedTask(item: WorkItem): SelectedTask {
  return {
    id: item.id,
    title: item.title,
    level: item.level,
    status: item.status,
    parentId: item.parentId,
    taskSpec: item.taskSpec,
    blockedReason: item.blockedReason,
    dispatchCount: item.dispatchCount,
    description: item.description,
  };
}
