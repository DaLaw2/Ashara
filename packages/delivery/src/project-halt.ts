import { describeErrorChain } from "@ashara/shared";
import { SPEND_CAP_ERROR_CLASS, WORK_BUDGET_ERROR_CLASS, modelCallFailureOf } from "./acl/finance-acl.js";
import type { ModelCallFailure, SpendAtCap, WorkAtBudget } from "./acl/finance-acl.js";

// Delivery's published language for a project halt: Delivery owns the halt
// (an open episode in project_blocks); Engagement owns the engagement lifecycle
// (projects.lifecycle: active, stopped, accepted). Every context that asks for a halt, and Engagement's
// reports of one, read the cause in these words. This module imports nothing but the kernel and
// Finance's spend-cap class names and amounts and its classifier of a failed model call, none of
// which reads Delivery, so a context Delivery itself reads can read it back without a cycle at load
// time.

/**
 * What kind of cause blocked a project: the closed vocabulary the Liaison's plain
 * report to the client is chosen by. `budget_cap`: the project's spend cap refused a model call.
 * `configuration`: a model call was refused by anything but a spend cap (an unpriced model, a cost
 * that cannot be estimated). `fault`: one of Ashara's own records or steps for the project failed.
 * `check_dispute`: a task's implementer kept disputing one of its checks past the bound of disputes
 * which nothing in the team settles. `replan_bound`: the client's changes revised the
 * plan as many times as Delivery revises it before the operator reviews the project.
 * `suite_review`: the review of a plan revision's check suites kept naming one check task past the
 * bound of reopens, which nothing in the team settles; only legacy rows carry it, since past the
 * bound the review is given up instead. `check_dispute` likewise. `plan_repair`: tasks were given up and
 * the remaining work re-planned around them as many times as Delivery repairs the plan:
 * the project halts as undeliverable. `infrastructure`: the machines a task runs on kept
 * failing past its fault budget; the project resumes by itself once the substrate
 * probe passes. `replan_stopped`: every attempt to revise the plan failed, the last because the
 * planning model's structured output never validated: the model's failure.
 * `replan_provider_failed`: every attempt failed, the last because the planning model's provider
 * failed the request, an HTTP error or no answer, so no answer was read. A revision
 * exhausted by any other error is Ashara's own (`fault`). `model_failed`: any other step stopped on
 * the model's failure, its structured answer never validated or unfit to act on.
 * `provider_failed`: any other step stopped on its model provider failing the request, so no answer
 * was read. `work_budget`: the project's model requests are spent (the work
 * ledger); the owner's grant and then the operator's unblock end it.
 */
type ProjectBlockCategory =
  | "budget_cap"
  | "configuration"
  | "fault"
  | "check_dispute"
  | "replan_bound"
  | "suite_review"
  | "plan_repair"
  | "infrastructure"
  | "replan_stopped"
  | "replan_provider_failed"
  | "model_failed"
  | "provider_failed"
  | "work_budget";

/**
 * Why a project was blocked: the cause's category, the error's class and its full
 * chain; a budget_cap halt also carries the amounts its cap was judged on, so a report states them
 * rather than a limit "reached" that the recorded spend had not reached; a work_budget halt carries
 * the work ledger as it stood, so a report names the budget, what was drawn and which call sites drew it.
 */
export type ProjectBlockCause =
  | UnpricedBlockCause
  | { readonly category: "budget_cap"; readonly errorClass: string; readonly reason: string; readonly spend: SpendAtCap }
  | { readonly category: "work_budget"; readonly errorClass: string; readonly reason: string; readonly work: WorkAtBudget };

/** A halt whose cause carries no amounts: every category but budget_cap and work_budget. */
type UnpricedBlockCause = { readonly category: Exclude<ProjectBlockCategory, "budget_cap" | "work_budget">; readonly errorClass: string; readonly reason: string };

/** A project's model requests are spent (the work ledger's refusal): it halts until the owner grants more. */
export function projectWorkCause(refusal: { readonly reason: string; readonly work: WorkAtBudget }): ProjectBlockCause {
  return { category: "work_budget", errorClass: WORK_BUDGET_ERROR_CLASS, reason: refusal.reason, work: refusal.work };
}

/** A project's own spend cap refused one of its calls: the project halts at its cap until the owner raises it. */
export function projectCapCause(refusal: { readonly reason: string; readonly spend: SpendAtCap }): ProjectBlockCause {
  return { category: "budget_cap", errorClass: SPEND_CAP_ERROR_CLASS.project, reason: refusal.reason, spend: refusal.spend };
}

/** The deployment's spend cap stopped the loop: every project at work halts at it. */
export function deploymentCapCause(stop: { readonly reason: string; readonly spend: SpendAtCap }): ProjectBlockCause {
  return { category: "budget_cap", errorClass: SPEND_CAP_ERROR_CLASS.deployment, reason: stop.reason, spend: stop.spend };
}

/** The category a halt on a failed model call is recorded under, by whose failure it was (modelCallFailureOf). */
export function modelCallBlockCategory(failure: ModelCallFailure): "fault" | "model_failed" | "provider_failed" {
  switch (failure) {
    case "model":
      return "model_failed";
    case "provider":
      return "provider_failed";
    case "ashara":
      return "fault";
  }
}

/**
 * Whose failure a counted attempt was, as its record keeps it: the model's or its
 * provider's when the record names one; Ashara's otherwise. A record that names no party (counted
 * before the column existed) or a value nothing names is Ashara's to look into, never the model's or
 * the provider's.
 */
export function recordedFailureOf(stored: unknown): ModelCallFailure {
  return stored === "model" || stored === "provider" ? stored : "ashara";
}

/**
 * A project's record or step failed, blamed by its cause chain through the one classifier of a failed
 * model call: the model's failure or its provider's when the chain names one, Ashara's own (`fault`,
 * which the team must repair) otherwise, every error nothing names included.
 */
export function projectBlockCause(err: Error): UnpricedBlockCause {
  return { category: modelCallBlockCategory(modelCallFailureOf(err)), errorClass: err.name, reason: describeErrorChain(err) };
}
