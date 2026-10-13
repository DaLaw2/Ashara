export type { WorkItem } from "./work-item.js";
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
} from "./work-item.js";

export type { WorkItemRepository } from "./repository.js";

export { ContractAlreadyExists } from "./errors.js";

export { DependencyGraph } from "./dependency.js";
export type { DependencyResolution } from "./dependency.js";
export { resolvePlanDependencies } from "./gate.js";
export { COVERAGE_TASK_ORIGIN } from "./select.js";
export type { CoverageHold } from "./router.js";
export { PlanningService } from "./service.js";
