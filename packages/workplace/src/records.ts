import type { AttemptCellImage } from "@ashara/execution-infra";
import type { TokenUsage } from "@ashara/finance";
import { cutText, keepEnds, renderElided, serializeError } from "@ashara/shared";
import type { ElidedText, SerializedError } from "@ashara/shared";
import type { Outcome } from "./outcome.js";

/** Longest tool output, input or model text kept, in the conversation and in the records alike. */
const MAX_TEXT_CHARS = 30_000;

/** `text` cut to MAX_TEXT_CHARS, both ends kept, the characters cut counted in the text itself. */
export function truncateText(text: string): string {
  return cutText(text, MAX_TEXT_CHARS);
}

/** A text the output caps may already have cut, cut to MAX_TEXT_CHARS: its earlier cuts and this one are counted together. */
export function truncateElided(text: ElidedText): string {
  return renderElided(keepEnds(text, MAX_TEXT_CHARS));
}

export function describeInput(input: unknown): string {
  const json = JSON.stringify(input);
  return truncateText(json === undefined ? String(input) : json);
}

/**
 * One entry of an attempt's conversation record. Written Z0-side through the sink, never into the
 * worktree; every text field is truncated with an explicit marker.
 */
export type AttemptRecord =
  | {
      readonly kind: "attempt_started";
      readonly at: number;
      readonly projectId: string;
      readonly taskId: string;
      /** The roster role the attempt worked as: its id and its name. */
      readonly role: { readonly id: string; readonly name: string };
      readonly provider: string;
      readonly modelId: string;
      readonly cellImage: AttemptCellImage;
      readonly limits: { readonly maxTurns: number; readonly wallClockMs: number; readonly perCommandTimeoutSeconds: number };
      readonly system: string;
      readonly firstMessage: string;
      /** sha256 (hex) of the first call's system prompt, messages and tools; the outcome carries the same. */
      readonly promptDigest: string;
    }
  | {
      readonly kind: "turn";
      readonly at: number;
      readonly turn: number;
      readonly text: string;
      readonly toolCalls: readonly { readonly toolCallId: string; readonly toolName: string; readonly input: string; readonly valid: boolean }[];
      readonly finishReason: string;
      readonly rawFinishReason: string | null;
      readonly usage: TokenUsage;
      readonly costUsd: number | null;
    }
  | { readonly kind: "turn_failed"; readonly at: number; readonly turn: number; readonly error: SerializedError }
  | {
      readonly kind: "tool_result";
      readonly at: number;
      readonly turn: number;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly isError: boolean;
      readonly output: string;
    }
  | { readonly kind: "outcome"; readonly at: number; readonly outcome: RecordedOutcome };

/** The outcome as recorded: an error (or a cancellation reason) becomes its serialized chain, so the record stays plain data. */
type RecordedOutcome = Plain<Outcome>;
type Plain<O> = O extends Outcome
  ? Omit<O, "error" | "reason"> & { readonly error?: SerializedError }
  : never;

/**
 * Where an attempt's record goes. The caller points it outside the worktree (t-isolated-switchover:
 * workdirBase/records/<task>/). A write that fails ends the attempt as environment_failure.
 */
export interface AttemptRecordSink {
  append(record: AttemptRecord): Promise<void>;
}

export function toRecordedOutcome(outcome: Outcome): RecordedOutcome {
  const { kind } = outcome;
  if (kind === "transport_exhausted" || kind === "environment_failure" || kind === "refused" || kind === "context_budget_exceeded") {
    const { error, ...rest } = outcome;
    return { ...rest, error: serializeError(error) };
  }
  if (kind === "cancelled") {
    const { reason, ...rest } = outcome;
    return { ...rest, error: serializeError(reason) };
  }
  return outcome;
}
