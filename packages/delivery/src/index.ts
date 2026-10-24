export { DELIVERY_MODEL_SCHEMAS } from "./model-schemas.js";
export type {
  CoreLoopConfig,
  CoreLoopDeps,
  CoreLoopOverrides,
  DispatchSteps,
  LoopCore,
  SweepSteps,
  TaskLanes,
} from "./types.js";
export { DEFAULT_CONFIG, withOverrides } from "./types.js";
export type { AcceptanceStore } from "./acceptance.js";
/** @testseam the integration acceptance.test.ts drives the sweep's records against Postgres through it; CoreLoop.runCycle is its production caller */
export { runAcceptanceSweeps } from "./acceptance.js";
export type { TerminalSweepStore } from "./terminal-sweep.js";

export { CoreLoop, concurrentTaskLanes } from "./core-loop.js";
/** @testseam the server replan-store.test.ts sweeps a Blocked owner_unresolved row against Postgres through it; CoreLoop.runCycle is its production caller */
export { releaseClearedBlocks } from "./parked-exits.js";
/** @testseam the integration task-helpers.test.ts resolves workspaces against Postgres through it; the execution path is its production caller */
export { resolveTargetProjectPath } from "./task-helpers.js";

export { ContinuousRunner } from "./runner.js";
export type { CycleRunner } from "./runner.js";

export { DispatchService } from "./dispatch/dispatch-service.js";
export type { AgentStaffing, DispatchServiceDeps } from "./dispatch/dispatch-types.js";
export type { DispatchVerification } from "./dispatch/verification-ports.js";
/** @testseam the integration execution tests dispatch a task descriptor against real cells; the core loop builds it in production */
export type { TaskDescriptor } from "./dispatch/dispatch-types.js";
export { createAgentStaffing, gradedCapability } from "./staffing.js";

export { reconcileWorkItemsOnStartup } from "./startup-reconciler.js";

export type { WorkItemRepository } from "./domain/index.js";
export { startWorkItem } from "./domain/index.js";
export {
  startUnlessHeld,
  TaskHeldForCorrection,
  failWorkItem,
  replanWorkItem,
  abandonWorkItem,
  takeEvents,
} from "./domain/index.js";
export { PlanningService } from "./domain/index.js";
/** @testseam the integration replan-store.test.ts gives a task up against Postgres; the dispatch path is its production caller */
export { giveUpWorkItem } from "./domain/index.js";
/** @testseam the integration suite-review-reopen.test.ts reopens check tasks on a real review's findings against Postgres; routeAsSuiteReview is its production caller */
export { exitSuiteReview } from "./domain/index.js";

export { FailureRouter } from "./failure-router.js";
/** @testseam the integration tests route a failed task against Postgres through it; the core loop is its production caller */
export { recoverFailedItem } from "./lifecycle/failure-recovery.js";

export { assignmentIntentOf } from "./acl/engagement-acl.js";
/** @testseam the integration attempt-profile.test.ts hands Workplace each kind of work's profile through it; the dispatch is its production caller */
export { attemptProfileOf } from "./acl/workplace-acl.js";

export type { StoredBlockedReason, WorkItemStatus } from "./work-item-language/index.js";
export {
  BLOCKED_REASON_SOURCES,
  BlockedReasonCorrupt,
  InvalidStatusTransition,
  OUTBOUND_TRANSITIONS,
  WORK_ITEM_STATUSES,
  parseStoredBlockedReason,
  parseStoredTaskSpec,
} from "./work-item-language/index.js";

export { FirstPlanner } from "./first-plan.js";
export type { FirstPlanStore } from "./first-plan.js";
export { Replanner } from "./replan.js";
/** @testseam the integration fault-classifiers.test.ts feeds it a last failure that names no party; Replanner.revise is its production caller */
export { exhaustedRevisionCause } from "./replan.js";
export type { ReplanStore } from "./replan-port.js";
export { createFirstPlanStore } from "./stores/first-plan-store.js";
export { createReplanStore } from "./stores/replan-store.js";

export { WorkItemRowRepository } from "./repositories/work-item.js";
export { adaptWorkItemRepo, rowToWorkItem, workItemSaveRow } from "./repositories/work-item-adapter.js";
export { ProjectHaltRepository, endHaltOnStop } from "./repositories/project-halt.js";
export { stepContainment } from "./repositories/step-containment.js";
export { listDuePlanReports } from "./repositories/plan-report.js";
export { holdCorrection, listDuePlanRevisionReports, planRevisionToTell } from "./repositories/replan.js";
