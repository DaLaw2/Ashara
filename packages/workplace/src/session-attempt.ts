import type { AttemptCellImage } from "@ashara/execution-infra";
import type { AttemptTerminal } from "@ashara/shared";
import type { Outcome } from "./outcome.js";
import { toRecordedOutcome } from "./records.js";

/**
 * How the attempt ended, in one line: a finished attempt's own summary (with its blocked reason),
 * every other terminal named with its detail. A claim of the agent's, never a verdict.
 */
export function attemptSummary(outcome: Outcome): string {
  if (outcome.kind !== "finished") return `attempt ended as ${outcome.kind}: ${outcome.detail}`;
  return outcome.status === "blocked" ? `${outcome.summary} (blocked: ${outcome.blockedReason ?? "no reason given"})` : outcome.summary;
}

/** The Outcome as plain data for an error envelope, its error (or cancellation reason) serialized with its chain. */
export function outcomeRecord(outcome: Outcome): Record<string, unknown> {
  return { ...toRecordedOutcome(outcome) };
}

/** An attempt as the session's terminal write records it (migration 046). */
export interface SessionAttempt {
  readonly promptDigest: string;
  /** The Outcome kind, with a finished attempt's status: "finished:done", "finished:blocked", "turn_cap", ... */
  readonly terminal: AttemptTerminal;
  readonly turns: number;
  readonly provider: string;
  readonly model: string;
  readonly cell: AttemptCellImage["kind"];
}

export function toSessionAttempt(
  outcome: Outcome,
  model: { readonly provider: string; readonly modelId: string },
  cellImage: AttemptCellImage,
): SessionAttempt {
  return {
    promptDigest: outcome.promptDigest,
    terminal: attemptTerminal(outcome),
    turns: outcome.turnsUsed,
    provider: model.provider,
    model: model.modelId,
    cell: cellImage.kind,
  };
}

/** Typed against the one list the DB CHECK mirrors: an Outcome kind the list lacks fails the build. */
function attemptTerminal(outcome: Outcome): AttemptTerminal {
  return outcome.kind === "finished" ? `finished:${outcome.status}` : outcome.kind;
}
