export * from "./domain/index.js";
export * from "./termination.js";
export * from "./run-summary.js";

export { BrainstormEngine, StubBrainstormLLM } from "./brainstorm.js";

export type {
  BrainstormConfig,
  BrainstormLevel,
  BrainstormLLM,
  BrainstormOutput,
  BrainstormTrigger,
  Recommendation,
  RecommendationAction,
  TriggerContext,
  TriggerReason,
} from "./brainstorm-types.js";

export * from "./decomposition-types.js";
export { DecompositionEngine, resetIdCounter, inferCapability } from "./decomposition.js";
export type { DecompositionLLM } from "./decomposition.js";
export { StubDecompositionLLM } from "./__stubs__/decomposition-llm.js";
export { deriveEndpointRef, deriveCompletionEndpoint, deriveCompletionModule } from "./contract-derivation.js";

export { NorthStarChecker, StubNorthStarLLM } from "./northstar.js";
export type { AlignmentResult, NorthStarCheckInput, NorthStarLLM } from "./northstar.js";

export { Router } from "./route.js";

export type { RouteDecision, RouteInput } from "./route-types.js";

export {
  FailureRouter,
  FailureRouterError,
  FailureRouterConfigError,
  FailureContextError,
  rawFailureContextSchema,
} from "./failure-router.js";
export type {
  FailureDecision,
  FailureRouteInput,
  FailurePlanState,
  FailureRouterItem,
  RawFailureContext,
} from "./failure-router.js";

export { decomposeLeafStories } from "./story-decomposer.js";
export type { StoryDecomposerDeps } from "./story-decomposer.js";

export { checkNorthStarAlignment } from "./northstar-orchestrator.js";
export type { NorthStarCheckDeps } from "./northstar-orchestrator.js";

export type { ProposalEmbedder } from "./proposal-dedup.js";

export { checkBrainstormTriggers, executeBrainstorm, executeGatedBrainstorm } from "./brainstorm-orchestrator.js";
export type {
  BrainstormOrchestrationDeps,
  BrainstormLogSink,
  ContextBriefSource,
  BrainstormTriggerInfo,
} from "./brainstorm-orchestrator.js";

export {
  createGatewayBrainstormLLM,
  createGatewayNorthStarLLM,
  createGatewayDecompositionLLM,
} from "./gateway-adapters.js";
export type { StructuredLLMProvider } from "./gateway-adapters.js";

export {
  createGatewaySpecDerivationLLM,
  deriveSpecEndpoints,
  buildSpecDerivationPrompt,
  SpecDerivationSchema,
  SpecDerivationError,
} from "./spec-derivation.js";
export type { SpecDerivationLLM, SpecDerivation, SpecVisionInput } from "./spec-derivation.js";

export {
  computeCoverageGaps,
  reconcileCoverage,
  createCoverageRollupGuard,
  isBlockingCoverageGap,
} from "./coverage-reconciliation.js";
export type {
  CoverageRollupGuardDeps,
  CoverageReconciliationDeps,
} from "./coverage-reconciliation.js";

export { createBulkPlanWithContract, BulkReferenceError } from "./bulk-plan.js";
export type { BulkPlanItem, BulkPlanEdge, BulkPlanResult, CreateBulkPlanDeps } from "./bulk-plan.js";

export {
  buildDeterministicGaps,
  buildVisionGaps,
  buildAcceptanceVerdict,
  createGatewayAcceptanceLLM,
  VisionGapResultSchema,
} from "./acceptance.js";
export type {
  AcceptanceOutcome,
  AcceptanceGap,
  AcceptanceVerdict,
  AcceptanceLLM,
  WorkItemSummary,
  VisionGapResult,
} from "./acceptance.js";

export {
  createGatewayReplanLLM,
  ReplanProposalSchema,
  ReplanResultSchema,
} from "./replan-from-vision.js";
export type {
  ReplanLLM,
  ReplanInput,
  ReplanResult,
  ReplanProposal,
  AbandonedItemContext,
} from "./replan-from-vision.js";

export { recoverFromAbandoned } from "./liveness-recovery.js";
export type { LivenessRecoveryDeps, FailedApproachSource } from "./liveness-recovery.js";

export * from "./lifecycle/index.js";
