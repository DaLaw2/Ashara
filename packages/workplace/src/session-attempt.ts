import type { AttemptCellImage } from "@ashara/execution-infra";
import type { AttemptTerminal } from "./session-vocabulary.js";
import type { BlockedOn, Outcome } from "./outcome.js";
import { toRecordedOutcome } from "./records.js";

/**
 * How the attempt ended, in one line: a finished attempt's own summary (with its blocked reason),
 * every other terminal named with its detail. A claim of the agent's, never a verdict.
 */
export function attemptSummary(outcome: Outcome): string {
  if (outcome.kind !== "finished") return `attempt ended as ${outcome.kind}: ${outcome.detail}`;
  return outcome.status === "blocked"
    ? `${outcome.summary} (blocked: ${outcome.blockedReason ?? "no reason given"}${blockedOnText(outcome.blockedOn)})`
    : outcome.summary;
}

/** Whose the block is to clear, as the finish named it; empty for a block it attributed to nothing outside the task. */
function blockedOnText(blockedOn: BlockedOn | null): string {
  if (blockedOn === null) return "; on nothing named";
  switch (blockedOn.kind) {
    case "needs-work":
      return `; needs work on interface entries ${blockedOn.interfaceEntries.join(", ")}`;
    case "needs-client-decision":
      return `; needs the client's decision: ${blockedOn.question}`;
    case "other":
      return "";
  }
}

/** The Outcome as plain data for an error envelope, its error (or cancellation reason) serialized with its chain. */
export function outcomeRecord(outcome: Outcome): Record<string, unknown> {
  return { ...toRecordedOutcome(outcome) };
}

/**
 * An attempt as the session's terminal write records it, with its terminal phase; `cell` says
 * whether it ran on the BaseCell or on the session's environment version.
 */
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
