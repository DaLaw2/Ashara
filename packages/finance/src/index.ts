export { GuardedModelAccess } from "./guarded-model-access.js";
export type { ContextualLlm, ContextualTurnLlm, CostedTurnResult } from "./guarded-model-access.js";
/** @testseam the integration attempt.podman.test.ts records a turn through its own recorder; LlmCallLedger is the production one */
export type { LlmCallRecorder, LlmProviderCall } from "./guarded-model-access.js";
export { LlmCallLedger } from "./llm-call-ledger.js";
export { SPEND_CAP_ERROR_CLASS, SpendCap } from "./spend-cap.js";
export type { SpendAtCap } from "./spend-cap.js";
export type { CostMeasurement } from "./cost.js";
export { PreCallRefusal } from "./errors.js";
export { modelCallFailureOf } from "./model-call-failure.js";
export type { ModelCallFailure } from "./model-call-failure.js";
/** @testseam the integration model-catalog.test.ts prices catalog models directly; LlmCallLedger.record is its production caller */
export { measureCost } from "./cost.js";
/** @testseam the integration spend-cap.test.ts checks the tiered worst-case estimate; SpendCap.admit is its production caller */
export { worstCaseCostUsd } from "./spend-cap.js";
/** @testseam a caller's test refuses a call with it, and the integration spend-cap.test.ts asserts it; SpendCap.admit throws it */
export { BudgetExceeded } from "./errors.js";
/** @testseam the integration llm-call-ledger.test.ts asserts the refusal class; LlmCallLedger throws it */
export { UnpricedModel } from "./errors.js";
// Finance is Model Access's only customer (ADR-075 context map): every other context reads the model
// language its calls through the guarded port speak (the structured-output ladder, the capability
// tier, a resolved model, the provider failures) here, never from model-access itself.
export { CapabilityLevelSchema, StructuredOutputExhausted, withStructuredLadder } from "@ashara/model-access";
export type {
  CapabilityLevel,
  LadderAttemptEvent,
  ResolvedModel,
  StructuredProvider,
  StructuredValidation,
  TokenUsage,
  TurnToolSchema,
} from "@ashara/model-access";
/** @testseam a scripted provider in a caller's test fails a call with it, naming the party at fault; modelCallFailureOf reads it */
export { ProviderError } from "@ashara/model-access";
/** @testseam a scripted model in a caller's test fails a ladder attempt with it, to count the caller's attempts */
export { SchemaValidationError } from "@ashara/model-access";
