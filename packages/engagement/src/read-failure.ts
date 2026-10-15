import {
  GatewayError,
  LlmCallNotAdmitted,
  LlmCallNotRecorded,
  PreCallRefusal,
  ProviderConfigurationRejected,
  ProviderError,
  StructuredOutputExhausted,
} from "@ashara/llm-gateway";

/**
 * Whose failure a failed model read of client input is (task t-intake-failure-classes, ADR-080 d5).
 * - "reading": the read itself failed: the model's output never validated, or the provider failed
 *   a request it accepted. It is counted against the input read, up to its attempt cap.
 * - "ashara-fault": Ashara's own machinery refused or broke around the read: a spend-cap or price
 *   refusal, a ledger read or write that failed, a provider rejecting Ashara's own configuration
 *   (credentials, account, endpoint, model id), or a gateway that cannot route the call. The
 *   client's input is not at fault, so it is never counted against it; the error throws through
 *   with its class.
 */
type ReadFailureClass = "reading" | "ashara-fault";

function chainHasAsharaFault(err: unknown): boolean {
  for (let current: unknown = err; current instanceof Error; current = current.cause) {
    if (
      current instanceof PreCallRefusal ||
      current instanceof LlmCallNotAdmitted ||
      current instanceof LlmCallNotRecorded ||
      current instanceof ProviderConfigurationRejected
    ) {
      return true;
    }
  }
  return false;
}

export function classifyReadFailure(err: unknown): ReadFailureClass {
  // Checked first: a ProviderError wraps whatever its request threw, Ashara's own faults included.
  if (chainHasAsharaFault(err)) return "ashara-fault";
  // Every other gateway error is raised before a request reaches a model (routing, the ladder's own
  // configuration); only these two report a read that was made and failed.
  if (err instanceof GatewayError && !(err instanceof StructuredOutputExhausted || err instanceof ProviderError)) {
    return "ashara-fault";
  }
  return "reading";
}
