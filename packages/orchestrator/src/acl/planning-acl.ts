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

// Failure / recovery types
export type { FailureRouter, RawFailureContext } from "@ashara/planning";
export type { FailureRecoveryDeps } from "@ashara/planning";

// First plan of a project (Delivery, story s-liaison-intake-m1)
export type { FirstPlanOutcome, FirstPlanning } from "@ashara/planning";

// Revision of a plan under way for a client's change (Delivery, t-replan-on-change)
export type { ReplanOutcome, Replanning } from "@ashara/planning";

// --- Values (re-exported) ---

// Domain service
export { PlanningService } from "@ashara/planning";

// Work-item domain methods
export {
  startWorkItem,
  failWorkItem,
  blockWorkItem,
  requeueWorkItem,
  unblockWorkItem,
  takeEvents,
  exitStaleChecks,
  exitDisputedCheck,
} from "@ashara/planning";

// Failure recovery
export { recoverFailedItem } from "@ashara/planning";
