export { GuardedModelAccess } from "./guarded-model-access.js";
export type { ContextualLlm, ContextualTurnLlm, CostedTurnResult } from "./guarded-model-access.js";
/** @testseam the integration attempt.podman.test.ts records a turn through its own recorder; LlmCallLedger is the production one */
export type { LlmCallRecorder, LlmProviderCall } from "./guarded-model-access.js";
export { LlmCallLedger } from "./llm-call-ledger.js";
export { LlmCallRepository } from "./llm-call-repository.js";
export { WorkGrantRepository } from "./work-grant-repository.js";
export { SPEND_CAP_ERROR_CLASS, SpendCap, WORK_BUDGET_ERROR_CLASS } from "./spend-cap.js";
export type { SpendAtCap, SpendRefusal } from "./spend-cap.js";
export { DEFAULT_WORK_BUDGETS, projectWorkBudget } from "./work-ledger.js";
export type { WorkBudgets } from "./work-ledger.js";
export { burnZoneOf } from "./work-burn.js";
export { attemptGrade } from "./attempt-grade.js";
export { projectWork, tasksWorkDrawn } from "./work-drawn.js";
export { callTotalsByTaskAndProvider, siteCostOf, taskCallsOf } from "./ledger-reads.js";
export type { BurnZone } from "./work-burn.js";
export type { WorkAtBudget } from "./errors.js";
export { WorkBudgetSpent } from "./errors.js";
export type { CostMeasurement } from "./cost.js";
export { ModelAnswerUnfit, PreCallRefusal } from "./errors.js";
export { modelCallAbortedOf, modelCallFailureOf } from "./model-call-failure.js";
export type { ModelCallFailure } from "./model-call-failure.js";
/** @testseam the integration model-catalog.test.ts prices catalog models directly; LlmCallLedger.record is its production caller */
export { measureCost } from "./cost.js";
/** @testseam the integration spend-cap.test.ts checks the tiered worst-case estimate; SpendCap.admit is its production caller */
export { worstCaseCostUsd } from "./spend-cap.js";
export { BudgetExceeded } from "./errors.js";
/** @testseam the integration llm-call-ledger.test.ts asserts the refusal class; LlmCallLedger throws it */
export { UnpricedModel } from "./errors.js";
// Finance is Model Access's only customer: every other context reads the model
// language its calls through the guarded port speak (the structured-output ladder, the capability
// tier, a resolved model, the provider failures) here, never from model-access itself.
export { CAPABILITY_RANK, CapabilityLevelSchema, judgeRelation, SECOND_OPINION_STRENGTHS, StructuredOutputExhausted, higherCapability, withStructuredLadder } from "@ashara/model-access";
export type {
  CapabilityLevel,
  JudgeRelation,
  GradedModel,
  LadderAttemptEvent,
  PassedOver,
  ResolvedModel,
  SecondOpinion,
  SecondOpinionStrength,
  StructuredProvider,
  StructuredProviderResult,
  StructuredValidation,
  TokenUsage,
  TurnToolSchema,
} from "@ashara/model-access";
// A provider's failure, naming the party at fault, as modelCallFailureOf reads it: a caller's own class
// for a provider failure it detects in an answer extends it (Workplace's ProviderErrorFinish).
export { ProviderError } from "@ashara/model-access";
// An agent turn that would not fit, or did not fit, its model's context window: its attempt ends on it.
export { ContextBudgetExceeded } from "@ashara/model-access";
// A second opinion the catalog cannot serve at a strength, or that got no answer at it: its caller
// moves to the next strength or reports it as failed.
export { SecondOpinionUnanswered, SecondOpinionUnavailable } from "@ashara/model-access";
/** @testseam a scripted gateway in a caller's test builds those refusals with the rules the gateway routes by */
export { ROUTING_RULES } from "@ashara/model-access";
/** @testseam a scripted model in a caller's test fails a ladder attempt with it, to count the caller's attempts */
export { SchemaValidationError } from "@ashara/model-access";
/** @testseam a caller's test ends a model call with it, as the shutdown does; modelCallAbortedOf is its production reader */
export { ModelCallAborted } from "@ashara/model-access";
