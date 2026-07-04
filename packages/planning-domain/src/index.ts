export type { WorkItem } from "./work-item.js";
export {
  createPendingWorkItem,
  createTask,
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
} from "./work-item.js";

export type { WorkItemRepository } from "./repository.js";

export {
  PlanningError,
  InvalidStatusTransition,
  WorkItemNotFound,
  InvalidLevel,
  CycleDetected,
  RepositoryError,
  ContractConflict,
  ContractAlreadyExists,
  ContractNotFound,
  ContractVersionConflict,
} from "./errors.js";
export type { ContractConflictKind } from "./errors.js";

export type { ContractRepository } from "./contract-repository.js";
export { applyContractDelta } from "./contract-merge.js";

export { DependencyGraph } from "./dependency.js";
export type { DependencyResolution, DependencyResolutionResult } from "./dependency.js";
export { GateKeeper, resolvePlanDependencies } from "./gate.js";
export { TaskSelector, COVERAGE_TASK_ORIGIN } from "./select.js";
export { LifecycleRouter } from "./router.js";
export type { CoverageHold } from "./router.js";
export { PlanningService } from "./service.js";
export { extractSubstitutedBy } from "./substitution.js";
