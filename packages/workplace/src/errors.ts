import { ProviderError, modelCallFailureOf } from "@ashara/finance";

/** The caller handed runAttempt an assignment it cannot run; no model call and no cell call was made. */
export class InvalidAssignment extends Error {
  readonly taskId: string;
  readonly issues: readonly string[];

  constructor(taskId: string, issues: readonly string[]) {
    super(`Assignment for task ${taskId} is invalid: ${issues.join("; ")}`);
    this.name = "InvalidAssignment";
    this.taskId = taskId;
    this.issues = issues;
  }
}

/**
 * The provider returned a response but marked it with an error finish reason; the turn's output is not
 * trusted. The provider's failure, as a ProviderError of failure "provider" is, so the one classifier
 * (modelCallFailureOf) names it.
 */
export class ProviderErrorFinish extends ProviderError {
  readonly turn: number;
  readonly model: string;
  readonly rawFinishReason: string | null;

  constructor(turn: number, provider: string, model: string, rawFinishReason: string | null) {
    super(provider, `turn ${turn}: ${provider}/${model} ended the response with an error finish reason (raw: ${rawFinishReason ?? "none sent"})`, "provider");
    this.name = "ProviderErrorFinish";
    this.turn = turn;
    this.model = model;
    this.rawFinishReason = rawFinishReason;
  }
}

/** The abort reason handed to an in-flight model call when the attempt's wall clock runs out. */
export class AttemptWallClockExhausted extends Error {
  readonly turn: number;
  readonly wallClockMs: number;

  constructor(turn: number, wallClockMs: number) {
    super(`Attempt wall clock of ${wallClockMs} ms ran out during turn ${turn}'s model call`);
    this.name = "AttemptWallClockExhausted";
    this.turn = turn;
    this.wallClockMs = wallClockMs;
  }
}

/**
 * Whose failure the model call that ended an attempt as transport_exhausted was: the provider's when
 * it answered with an error finish reason or failed the request (modelCallFailureOf "provider");
 * Ashara's otherwise, its own request or code included. Never the agent's work: no answer of the
 * model was read.
 */
export function turnFailureOf(error: unknown): "provider" | "ashara" {
  const failure = modelCallFailureOf(error);
  switch (failure) {
    case "provider":
      return "provider";
    // A turn reads no structured answer, so no turn fails as the model's; one that did would be
    // Ashara's to look into, never charged to the provider.
    case "model":
    case "ashara":
      return "ashara";
  }
}
