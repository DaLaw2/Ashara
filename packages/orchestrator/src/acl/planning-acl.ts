/**
 * Anti-Corruption Layer: Planning (ADR-044).
 *
 * This is the ONLY file in @ashara/orchestrator that imports from @ashara/planning.
 * All orchestrator source files import planning types and functions through this
 * module, keeping the boundary explicit and the coupling surface auditable.
 *
 * TODO(ADR-044): Many re-exports here are raw pass-throughs of planning-internal
 * types (WorkItem, WorkItemRepository, etc.). A future phase will introduce
 * orchestrator-local equivalents mapped through this ACL, so the orchestrator
 * never depends on planning's internal type shapes.
 */

// --- Types (re-exported as type-only) ---

// Domain types
export type { WorkItem } from "@ashara/planning";
export type { WorkItemRepository } from "@ashara/planning";
export type { ContractRepository } from "@ashara/planning";
export type { CoverageHold } from "@ashara/planning";

// Termination & run-summary types
export type { RunSummary } from "@ashara/planning";
export type { TerminationDecision, TerminationPlanExhausted, StopReason } from "@ashara/planning";
export type { EndpointCoverageGap } from "@ashara/planning";

// Engine / LLM port types
export type { BrainstormEngine } from "@ashara/planning";
export type { NorthStarChecker } from "@ashara/planning";
export type { DecompositionEngine } from "@ashara/planning";
export type { ProposalEmbedder } from "@ashara/planning";
export type { AcceptanceLLM, AcceptanceVerdict, AcceptanceGap } from "@ashara/planning";
export type { ReplanLLM } from "@ashara/planning";

// Failure / recovery types
export type { FailureRouter, RawFailureContext } from "@ashara/planning";
export type { ContractRegistryLookup, FailureRecoveryDeps } from "@ashara/planning";

// Brainstorm orchestration types
export type { BrainstormOrchestrationDeps } from "@ashara/planning";

// --- Values (re-exported) ---

// Domain service & graph
export { PlanningService, DependencyGraph } from "@ashara/planning";

// Work-item domain methods
export {
  canTransitionTo,
  createPendingWorkItem,
  startWorkItem,
  failWorkItem,
  requeueWorkItem,
  takeEvents,
} from "@ashara/planning";

// Story decomposition
export { decomposeLeafStories } from "@ashara/planning";

// Coverage reconciliation
export { createCoverageRollupGuard, reconcileCoverage } from "@ashara/planning";
export { computeCoverageGaps, isBlockingCoverageGap } from "@ashara/planning";

// Failure recovery & task split
export { recoverFailedItem } from "@ashara/planning";
export { shouldSplit, splitFailedTask } from "@ashara/planning";

// Brainstorm & NorthStar orchestration
export {
  checkNorthStarAlignment,
  checkBrainstormTriggers,
  executeBrainstorm,
  executeGatedBrainstorm,
} from "@ashara/planning";

// Termination snapshot & evaluation
export { assembleRunSummaryItems, evaluate } from "@ashara/planning";
export { buildRunSummary, emitRunSummary } from "@ashara/planning";

// Acceptance
export { assessProductObservation, buildVisionGaps, buildAcceptanceVerdict, buildUnverifiedVerdict } from "@ashara/planning";

// Liveness recovery
export { recoverFromAbandoned } from "@ashara/planning";
