import { ProviderConfigurationRejected, ProviderError, StructuredOutputExhausted } from "@ashara/model-access";
import { LlmCallNotAdmitted, LlmCallNotRecorded, ModelAnswerUnfit, PreCallRefusal } from "./errors.js";

/**
 * Whose failure a failed call through the guarded model port was, read from its cause chain. The
 * one classification every context routes a failed model call by, so no caller writes its own:
 * - "model": the model answered and its structured output never validated (StructuredOutputExhausted),
 *   or validated and was unfit to act on (ModelAnswerUnfit).
 * - "provider": the provider failed the request (ProviderError.failure "provider": a 5xx, 408 or 429
 *   status, no answer, a body not in the API's shape), so no answer was read.
 * - "ashara": anything else. Ashara refused or broke around the call (a spend-cap or price refusal,
 *   a ledger read or write that failed, a provider rejecting Ashara's configuration or the request
 *   Ashara built, ProviderError.failure "ashara"), and every error not recognised as the model's or
 *   the provider's: what Ashara cannot name is Ashara's to look into, never the model's or the
 *   provider's, and never the input's the call was about.
 * An Ashara fault anywhere in the chain wins over the rest: a ProviderError wraps whatever its
 * request threw, Ashara's own faults included.
 */
export type ModelCallFailure = "model" | "provider" | "ashara";

export function modelCallFailureOf(err: unknown): ModelCallFailure {
  let failure: ModelCallFailure = "ashara";
  let named = false;
  for (let current: unknown = err; current instanceof Error; current = current.cause) {
    if (
      current instanceof PreCallRefusal ||
      current instanceof LlmCallNotAdmitted ||
      current instanceof LlmCallNotRecorded ||
      current instanceof ProviderConfigurationRejected ||
      (current instanceof ProviderError && current.failure === "ashara")
    ) {
      return "ashara";
    }
    if (named) continue;
    if (current instanceof StructuredOutputExhausted || current instanceof ModelAnswerUnfit) {
      failure = "model";
      named = true;
    } else if (current instanceof ProviderError) {
      failure = "provider";
      named = true;
    }
  }
  return failure;
}
