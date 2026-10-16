/**
 * Anti-Corruption Layer: Finance (ADR-075).
 *
 * Outside dispatch/, Delivery reads Finance only here: the guarded model port its planning calls go
 * through, and the refusals a call can meet before it is sent, a spend cap's among them.
 */

export type { ContextualLlm } from "@ashara/finance";
export { BudgetExceeded } from "@ashara/finance";
// Whose failure a failed model call was, the model's, its provider's or Ashara's: an exhausted plan
// revision's halt is recorded by it (replan.ts).
export { modelCallFailureOf } from "@ashara/finance";
export type { ModelCallFailure } from "@ashara/finance";
export { SPEND_CAP_ERROR_CLASS } from "@ashara/finance";
export type { SpendAtCap } from "@ashara/finance";

// The model language Delivery's planning calls speak, published by Finance in front of Model Access.
export { CapabilityLevelSchema, withStructuredLadder } from "@ashara/finance";
export type {
  CapabilityLevel,
  LadderAttemptEvent,
  ResolvedModel,
  StructuredProvider,
  StructuredValidation,
} from "@ashara/finance";
/** @testseam a scripted model in a planning test fails a ladder attempt with it, to count the planner's attempts */
export { SchemaValidationError } from "@ashara/finance";
