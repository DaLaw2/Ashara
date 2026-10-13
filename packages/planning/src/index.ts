export type {
  WorkItem,
  WorkItemRepository,
} from "./domain/index.js";
export {
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
  WorkItemSpec,
  DecompositionResult,
} from "./decomposition-types.js";
export { DecompositionEngine, resetIdCounter } from "./decomposition.js";
export type { DecompositionLLM } from "./decomposition.js";

export { FailureRouter } from "./failure-router.js";
export type { RawFailureContext } from "./failure-router.js";

export { createGatewayDecompositionLLM } from "./gateway-adapters.js";

export { createBulkPlanWithContract, BulkReferenceError } from "./bulk-plan.js";
export type { BulkPlanItem, BulkPlanEdge, BulkPlanResult } from "./bulk-plan.js";

export {
  classifyFailure,
  shouldEscalate,
  tryParseEnvelope,
} from "./failure-classifier.js";

export type { FailureRecoveryDeps } from "./lifecycle/index.js";
export { recoverFailedItem } from "./lifecycle/index.js";
