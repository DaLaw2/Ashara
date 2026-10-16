import type { CostMeasurement, PreCallRefusal } from "@ashara/finance";

/** A turn whose cost is not known, and why. */
interface UnmeasuredTurn {
  readonly turn: number;
  readonly reason: string;
}

/**
 * What the attempt's model calls cost. One unmeasured turn makes the whole attempt unmeasured:
 * `measuredUsd` is then only the sum of the turns that were priced, a lower bound, never the total.
 */
type AttemptCost =
  | { readonly measured: true; readonly totalUsd: number; readonly turns: number }
  | { readonly measured: false; readonly measuredUsd: number; readonly unmeasuredTurns: readonly UnmeasuredTurn[] };

export interface LastToolCall {
  readonly turn: number;
  readonly toolName: string;
  /** JSON of the call's input, truncated with an explicit marker. */
  readonly input: string;
}

interface OutcomeBase {
  /** Model calls started, the failed one included. */
  readonly turnsUsed: number;
  readonly cost: AttemptCost;
  readonly lastToolCall: LastToolCall | null;
  /** sha256 (hex) of the system prompt, messages and tools of the attempt's first model call (prompt-digest.ts). */
  readonly promptDigest: string;
  /** Why the attempt ended, readable on its own (Discipline C). */
  readonly detail: string;
}

/** The terminals of an attempt; there is no other way out of runAttempt except InvalidAssignment. */
export type Outcome =
  | (OutcomeBase & {
      readonly kind: "finished";
      readonly status: "done" | "blocked";
      readonly summary: string;
      /** Present exactly when status is "blocked". */
      readonly blockedReason: string | null;
      /** Environment work's stack statement: present exactly when environment work finished done. */
      readonly statement: string | null;
    })
  | (OutcomeBase & {
      /**
       * The implementer called dispute_check: it holds that a stored check cannot pass on correct
       * work (ADR-074 addendum 2 d65 c). Not a failure of the task: the caller routes it to the
       * check's author, never to the failure router.
       */
      readonly kind: "disputed";
      /** The disputed check: one of the task's stored check names, or of the merged task `ofTask`'s. */
      readonly checkName: string;
      /** The task already merged whose check is disputed; null for one of the task's own checks. */
      readonly ofTask: string | null;
      readonly reason: string;
      /** The output of the attempt's last run_checks, or null when it never ran them. */
      readonly evidence: string | null;
    })
  | (OutcomeBase & {
      readonly kind: "model_stopped_without_finish";
      readonly finishReason: string;
      readonly rawFinishReason: string | null;
      readonly finalText: string;
    })
  | (OutcomeBase & {
      /**
       * A turn's output was cut at the output token limit. None of its tool calls ran: a call
       * written in a cut response may itself be cut, so it is never executed (ADR-074 d92 c).
       */
      readonly kind: "output_truncated";
      readonly turn: number;
      readonly provider: string;
      readonly model: string;
      readonly finishReason: "truncated";
      readonly rawFinishReason: string | null;
      /** As the provider reported it; null when it reported no count. */
      readonly outputTokens: number | null;
      /** The tool calls the cut turn carried, none of them executed. */
      readonly droppedToolCalls: number;
    })
  | (OutcomeBase & { readonly kind: "turn_cap"; readonly maxTurns: number })
  | (OutcomeBase & { readonly kind: "wall_clock"; readonly wallClockMs: number; readonly elapsedMs: number })
  | (OutcomeBase & {
      readonly kind: "transport_exhausted";
      /** The generateTurn failure itself, typed context intact (no fallback inside an attempt, ADR-074 d44). */
      readonly error: unknown;
    })
  | (OutcomeBase & {
      readonly kind: "refused";
      /**
       * The recorder refused a turn's call before it was sent (Finance's spend cap or price list).
       * Not a failed approach: the caller routes it by the refusal, never as the attempt's failure.
       */
      readonly error: PreCallRefusal;
    })
  | (OutcomeBase & {
      readonly kind: "environment_failure";
      /** "cell": the substrate failed, not the command; "records": the records sink failed. */
      readonly source: "cell" | "records";
      readonly error: unknown;
    })
  | (OutcomeBase & { readonly kind: "cancelled"; readonly reason: unknown });

/** The fields every terminal shares; the loop supplies them when it concludes. */
export type Terminal = WithoutBase<Outcome>;
type WithoutBase<O> = O extends Outcome ? Omit<O, "turnsUsed" | "cost" | "lastToolCall" | "promptDigest"> : never;

export class CostTally {
  private measuredUsd = 0;
  private priced = 0;
  private readonly unmeasured: UnmeasuredTurn[] = [];

  add(turn: number, cost: CostMeasurement): void {
    if (cost.measured) {
      this.measuredUsd += cost.totalCost;
      this.priced += 1;
      return;
    }
    const missing = [
      ...cost.missingCounts.map((c) => `count of ${c} not reported`),
      ...cost.missingRates.map((c) => `no rate for ${c}`),
    ];
    this.unmeasured.push({ turn, reason: `the gateway could not price the call: ${missing.join(", ") || "no reason given"}` });
  }

  addUnknown(turn: number, reason: string): void {
    this.unmeasured.push({ turn, reason });
  }

  snapshot(): AttemptCost {
    if (this.unmeasured.length > 0) {
      return { measured: false, measuredUsd: this.measuredUsd, unmeasuredTurns: [...this.unmeasured] };
    }
    return { measured: true, totalUsd: this.measuredUsd, turns: this.priced };
  }
}
