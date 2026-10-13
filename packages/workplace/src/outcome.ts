import type { CostMeasurement, PreCallRefusal } from "@ashara/llm-gateway";

/** A turn whose cost is not known, and why. */
export interface UnmeasuredTurn {
  readonly turn: number;
  readonly reason: string;
}

/**
 * What the attempt's model calls cost. One unmeasured turn makes the whole attempt unmeasured:
 * `measuredUsd` is then only the sum of the turns that were priced, a lower bound, never the total.
 */
export type AttemptCost =
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
    })
  | (OutcomeBase & {
      readonly kind: "model_stopped_without_finish";
      readonly finishReason: string;
      readonly rawFinishReason: string | null;
      readonly finalText: string;
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
type WithoutBase<O> = O extends Outcome ? Omit<O, "turnsUsed" | "cost" | "lastToolCall"> : never;

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
