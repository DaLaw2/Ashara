/**
 * Anti-Corruption Layer: Finance.
 *
 * Outside dispatch/, Delivery reads Finance only here: the guarded model port its planning calls go
 * through, and the refusals a call can meet before it is sent, a spend cap's among them.
 */

export type { ContextualLlm } from "@ashara/finance";
/** @testseam a planning test refuses a call with it, to show a refusal is never counted against the plan; the spend cap throws it */
export { BudgetExceeded } from "@ashara/finance";
// Whose failure a failed model call was, the model's, its provider's or Ashara's: every halt is blamed
// by it (project-halt.ts), and planning counts an attempt only on the model's or the provider's.
export { modelCallFailureOf } from "@ashara/finance";
export type { ModelCallFailure } from "@ashara/finance";
export { SPEND_CAP_ERROR_CLASS, WORK_BUDGET_ERROR_CLASS } from "@ashara/finance";
export type { SpendAtCap, WorkAtBudget } from "@ashara/finance";

// The model language Delivery's planning calls speak, published by Finance in front of Model Access.
export { CapabilityLevelSchema, withStructuredLadder } from "@ashara/finance";
export type {
  CapabilityLevel,
  LadderAttemptEvent,
  ResolvedModel,
  StructuredProvider,
  StructuredValidation,
} from "@ashara/finance";
/** @testseam an execution test ends an attempt on it, to route a turn that did not fit its window; Workplace's attempt reads it */
export { ContextBudgetExceeded } from "@ashara/finance";
/** @testseam a scripted model in a planning test fails a ladder attempt with it, to count the planner's attempts */
export { SchemaValidationError } from "@ashara/finance";
