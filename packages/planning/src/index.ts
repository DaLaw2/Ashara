export type {
  WorkItem,
  WorkItemRepository,
} from "./domain/index.js";
export {
  startWorkItem,
  failWorkItem,
  blockWorkItem,
  unblockWorkItem,
  replanWorkItem,
  abandonWorkItem,
  requeueWorkItem,
  giveUpWorkItem,
  takeEvents,
  exitStaleChecks,
  exitDisputedCheck,
  exitSuiteReview,
  requestEnvironmentChange,
  openAcceptanceDefect,
  giveUpAcceptanceDefect,
  PlanningService,
} from "./domain/index.js";

export { FailureRouter } from "./failure-router.js";
export type { RawFailureContext } from "./failure-router.js";

export { createBulkPlan } from "./bulk-plan.js";

export { assignmentIntentOf } from "./acl/engagement-acl.js";

export { FirstPlanner } from "./first-plan.js";
export type { FirstPlanOutcome, FirstPlanStore, FirstPlanning } from "./first-plan.js";

export { Replanner } from "./replan.js";
export type { ReplanOutcome, ReplanStore, Replanning } from "./replan.js";

export {
  classifyFailure,
  shouldEscalate,
  tryParseEnvelope,
} from "./failure-classifier.js";

export type { FailureRecoveryDeps } from "./lifecycle/index.js";
export { recoverFailedItem } from "./lifecycle/index.js";
