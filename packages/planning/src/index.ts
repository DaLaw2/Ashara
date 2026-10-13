export type {
  WorkItem,
  WorkItemRepository,
  CoverageHold,
} from "./domain/index.js";
export {
  createPendingWorkItem,
  startWorkItem,
  completeWorkItem,
  failWorkItem,
  blockWorkItem,
  unblockWorkItem,
  replanWorkItem,
  abandonWorkItem,
  requeueWorkItem,
  takeEvents,
  DependencyGraph,
  PlanningService,
} from "./domain/index.js";

export type {
  StopReason,
  TerminationPlanExhausted,
  TerminationDecision,
} from "./termination.js";

export type {
  EndpointCoverageGap,
  RunSummary,
} from "./run-summary.js";

export type {
  WorkItemSpec,
  DecompositionResult,
} from "./decomposition-types.js";
export { loadDecompositionConfig } from "./decomposition-types.js";
export { DecompositionEngine, resetIdCounter } from "./decomposition.js";
export type { DecompositionLLM } from "./decomposition.js";
export { deriveCompletionEndpoint, deriveCompletionModule } from "./contract-derivation.js";

export { FailureRouter } from "./failure-router.js";
export type { RawFailureContext } from "./failure-router.js";

export { decomposeLeafStories } from "./story-decomposer.js";

export { createGatewayDecompositionLLM } from "./gateway-adapters.js";

export {
  computeCoverageGaps,
  reconcileCoverage,
  createCoverageRollupGuard,
  isBlockingCoverageGap,
} from "./coverage-reconciliation.js";

export { createBulkPlanWithContract, BulkReferenceError } from "./bulk-plan.js";
export type { BulkPlanItem, BulkPlanEdge, BulkPlanResult } from "./bulk-plan.js";

export {
  assessProductObservation,
  buildVisionGaps,
  buildAcceptanceVerdict,
  buildUnverifiedVerdict,
  createGatewayAcceptanceLLM,
} from "./acceptance.js";
export type {
  AcceptanceGap,
  AcceptanceVerdict,
  AcceptanceLLM,
} from "./acceptance.js";

export { createGatewayReplanLLM } from "./replan-from-vision.js";
export type { ReplanLLM } from "./replan-from-vision.js";

export { recoverFromAbandoned } from "./liveness-recovery.js";

export {
  classifyFailure,
  shouldEscalate,
  tryParseEnvelope,
} from "./failure-classifier.js";

export type {
  ContractRegistryLookup,
  FailureRecoveryDeps,
} from "./lifecycle/index.js";
export {
  recoverFailedItem,
  evaluate,
  assembleRunSummaryItems,
  buildRunSummary,
  emitRunSummary,
} from "./lifecycle/index.js";

export { computeCompletionFigure } from "./completion-figure.js";
export type { CompletionFigure } from "./completion-figure.js";
