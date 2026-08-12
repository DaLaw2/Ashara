export type {
  WorkItem,
  WorkItemRepository,
  ContractRepository,
  CoverageHold,
} from "./domain/index.js";
export {
  createPendingWorkItem,
  canTransitionTo,
  startWorkItem,
  completeWorkItem,
  failWorkItem,
  blockWorkItem,
  unblockWorkItem,
  replanWorkItem,
  abandonWorkItem,
  requeueWorkItem,
  takeEvents,
  InvalidStatusTransition,
  ContractVersionConflict,
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

export { BrainstormEngine, StubBrainstormLLM } from "./brainstorm.js";

export type {
  BrainstormLLM,
  TriggerContext,
} from "./brainstorm-types.js";

export type {
  WorkItemSpec,
  TaskSpec,
  DecompositionResult,
} from "./decomposition-types.js";
export { loadDecompositionConfig } from "./decomposition-types.js";
export { DecompositionEngine, resetIdCounter } from "./decomposition.js";
export type { DecompositionLLM } from "./decomposition.js";
export { deriveCompletionEndpoint, deriveCompletionModule } from "./contract-derivation.js";

export { NorthStarChecker, StubNorthStarLLM } from "./northstar.js";
export type { NorthStarLLM } from "./northstar.js";

export { FailureRouter } from "./failure-router.js";
export type { RawFailureContext } from "./failure-router.js";

export { decomposeLeafStories } from "./story-decomposer.js";

export { checkNorthStarAlignment } from "./northstar-orchestrator.js";

export type { ProposalEmbedder } from "./proposal-dedup.js";

export { checkBrainstormTriggers, executeBrainstorm, executeGatedBrainstorm } from "./brainstorm-orchestrator.js";
export type { BrainstormOrchestrationDeps } from "./brainstorm-orchestrator.js";

export {
  createGatewayBrainstormLLM,
  createGatewayNorthStarLLM,
  createGatewayDecompositionLLM,
} from "./gateway-adapters.js";

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
export type { FailureCategory } from "./failure-classifier.js";

export type {
  ContractRegistryLookup,
  FailureRecoveryDeps,
} from "./lifecycle/index.js";
export {
  recoverFailedItem,
  shouldSplit,
  splitFailedTask,
  evaluate,
  assembleRunSummaryItems,
  buildRunSummary,
  emitRunSummary,
} from "./lifecycle/index.js";
