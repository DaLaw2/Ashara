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
  exitStaleChecks,
  DependencyGraph,
  PlanningService,
} from "./domain/index.js";

export { FailureRouter } from "./failure-router.js";
export type { RawFailureContext } from "./failure-router.js";

export { createBulkPlanWithContract } from "./bulk-plan.js";

export { FirstPlanner } from "./first-plan.js";
export type { FirstPlanOutcome, FirstPlanStore, FirstPlanning } from "./first-plan.js";

export {
  classifyFailure,
  shouldEscalate,
  tryParseEnvelope,
} from "./failure-classifier.js";

export type { FailureRecoveryDeps } from "./lifecycle/index.js";
export { recoverFailedItem } from "./lifecycle/index.js";
