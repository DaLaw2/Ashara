import type { TokenUsage } from "@ashara/llm-gateway";
import type { Outcome } from "./outcome.js";

/** Longest tool output, input or model text kept, in the conversation and in the records alike. */
const MAX_TEXT_CHARS = 30_000;

/** Cuts `text` to `limit` characters and says so in the text itself, so a reader never mistakes a cut for the whole. */
export function truncateText(text: string, limit: number = MAX_TEXT_CHARS): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[truncated by Ashara: ${limit} of ${text.length} characters shown]`;
}

export function describeInput(input: unknown): string {
  const json = JSON.stringify(input);
  return truncateText(json === undefined ? String(input) : json);
}

/**
 * What the attempt's cell was started from: the BaseCell (only the task that defines the
 * environment runs on it) or the image of the project's environment version.
 */
export type AttemptCellImage =
  | { readonly kind: "base-cell"; readonly image: string; readonly digest: string }
  | {
      readonly kind: "environment";
      readonly version: string;
      readonly commit: string;
      readonly imageId: string;
      readonly imageRef: string;
    };

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
  | { readonly kind: "turn_failed"; readonly at: number; readonly turn: number; readonly errorName: string; readonly errorMessage: string }
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

/** The outcome as recorded: an error object becomes its name and message, so the record stays plain data. */
export type RecordedOutcome = Plain<Outcome>;
type Plain<O> = O extends Outcome
  ? Omit<O, "error" | "reason"> & { readonly errorName?: string; readonly errorMessage?: string }
  : never;

/**
 * Where an attempt's record goes. The caller points it outside the worktree (t-isolated-switchover:
 * workdirBase/records/<task>/). A write that fails ends the attempt as environment_failure.
 */
export interface AttemptRecordSink {
  append(record: AttemptRecord): Promise<void>;
}

export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  const json = JSON.stringify(error);
  return json === undefined ? String(error) : json;
}

export function toRecordedOutcome(outcome: Outcome): RecordedOutcome {
  const { kind } = outcome;
  if (kind === "transport_exhausted" || kind === "environment_failure" || kind === "refused") {
    const { error, ...rest } = outcome;
    return { ...rest, errorName: errorName(error), errorMessage: errorMessage(error) };
  }
  if (kind === "cancelled") {
    const { reason, ...rest } = outcome;
    return { ...rest, errorName: errorName(reason), errorMessage: errorMessage(reason) };
  }
  return outcome;
}
