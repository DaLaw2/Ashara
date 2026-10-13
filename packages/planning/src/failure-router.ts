import { z } from "zod";
import type { FailureCategory } from "./failure-classifier.js";

/**
 * Raw failure context handed to the FailureRouter. Carries the unabridged
 * failure signal (agent/gate output object + the failure detail string) with no
 * lossy summarisation, so a re-planned attempt can be told exactly WHY the last
 * one failed (Discipline C — error reproducibility).
 */
export const rawFailureContextSchema = z.object({
  detail: z.string(),
  raw: z.record(z.string(), z.unknown()),
});

export type RawFailureContext = z.infer<typeof rawFailureContextSchema>;

export interface FailureRouterItem {
  readonly id: string;
}

export interface FailureRouteInput {
  readonly item: FailureRouterItem;
  readonly failure: RawFailureContext;
  /**
   * How many dispatch attempts have been made for this item so far. The orchestrator
   * sources this from the WorkItem's dispatch counter (migration 018), which is
   * incremented at the dispatch seam — so by recovery time it already includes the
   * attempt that just failed. The router replans while this is under the bound, so a
   * bound of N caps the item at N dispatches before it must switch or abandon.
   */
  readonly priorAttempts: number;
  /**
   * Classified failure category from the ErrorEnvelope (failure-classifier.ts).
   * The router consults it before applying the replan bound: TREE_REGRESSION
   * terminates on first occurrence regardless of remaining attempts. Required
   * so that an unparseable envelope cannot silently restore the replan ladder
   * for a tree regression — the caller must supply a category, and the
   * fail-closed default for an unclassifiable failure is VERIFICATION_GAP
   * (the same default classifyFailure itself uses for unknown operations).
   */
  readonly category: FailureCategory;
}

/**
 * A typed recovery decision. Every branch carries the raw failure context so the
 * orchestrator can attach it to the mutated record (replan) or the terminal
 * reason (abandon) — the context never gets dropped at the boundary.
 */
export type FailureDecision =
  | { readonly action: "replan"; readonly attempt: number; readonly failure: RawFailureContext }
  | {
      readonly action: "abandon";
      readonly reason: string;
      readonly attempts: number;
      readonly failure: RawFailureContext;
    };

export class FailureRouterError extends Error {
  // open-by-design: diagnostic context varies per error site (config, item state, etc.)
  readonly context: Record<string, unknown>;

  constructor(message: string, context: Record<string, unknown>) { // open-by-design
    super(message);
    this.name = "FailureRouterError";
    this.context = context;
  }
}

export class FailureRouterConfigError extends FailureRouterError {
  constructor(maxReplanAttempts: number) {
    super(`FailureRouter.maxReplanAttempts must be a non-negative integer, got ${maxReplanAttempts}`, {
      maxReplanAttempts,
    });
    this.name = "FailureRouterConfigError";
  }
}

export class FailureContextError extends FailureRouterError {
  constructor(itemId: string, issues: z.ZodIssue[]) {
    super(`FailureRouter received invalid raw failure context for work item ${itemId}`, {
      itemId,
      issues,
    });
    this.name = "FailureContextError";
  }
}

/**
 * Planning-BC service that turns a permanent task failure into a typed recovery
 * decision (ADR-029 / migration Phase 6). Deterministic and rule-based — no LLM,
 * no I/O — so the same inputs always yield the same decision and it fails closed:
 * an undecidable input throws rather than silently leaving the item stuck.
 *
 * Rule ladder (first match wins):
 *   1. replan  — attempts remain under the bound; retry, carrying the raw
 *      failure context forward so the next attempt is informed (never identical).
 *   2. abandon — the bound is reached; terminate so the item's dependents stop
 *      waiting on a task that will not complete.
 *
 * After `maxReplanAttempts` the router abandons — it can never emit an unbounded
 * run of identical replans.
 */
export class FailureRouter {
  private readonly maxReplanAttempts: number;

  constructor(maxReplanAttempts = 2) {
    if (!Number.isInteger(maxReplanAttempts) || maxReplanAttempts < 0) {
      throw new FailureRouterConfigError(maxReplanAttempts);
    }
    this.maxReplanAttempts = maxReplanAttempts;
  }

  route(input: FailureRouteInput): FailureDecision {
    const parsed = rawFailureContextSchema.safeParse(input.failure);
    if (!parsed.success) {
      throw new FailureContextError(input.item.id, parsed.error.issues);
    }
    const failure = parsed.data;

    // Zero-replan bound for tree regressions: the post-merge verification
    // failed against the merged tree, not against the task's own changes.
    // Replanning would dispatch an agent into the same broken tree with the
    // instruction "fix the failing checks" — checks it did not break and
    // cannot fix. Terminalizing on first occurrence prevents burning the
    // replan bound against an external regression.
    //
    // Honest cost: the task's own code may have been correct, so early
    // termination gives up work that could have succeeded once the tree was
    // fixed. That is not a regression from the prior behavior — before this
    // change the task reached the same terminal state after paying for two
    // more failed dispatches — but it is a real trade-off: we save the cost
    // of doomed retries at the price of not automatically resuming when the
    // tree heals.
    const abandon = this.categoryRequiresImmediateTermination(input.category, failure, input.priorAttempts);
    if (abandon) return abandon;

    if (input.priorAttempts < this.maxReplanAttempts) {
      return { action: "replan", attempt: input.priorAttempts + 1, failure };
    }

    return {
      action: "abandon",
      reason: `exhausted ${this.maxReplanAttempts} replan attempt(s) without success`,
      attempts: input.priorAttempts,
      failure,
    };
  }

  /**
   * Exhaustive switch over FailureCategory: a new member without a case here
   * is a compile error, not a silent fall-through. Returns an abandon decision
   * for categories that must not consume the replan bound; null means "proceed
   * to the normal replan-or-abandon ladder."
   */
  private categoryRequiresImmediateTermination(
    category: FailureCategory,
    failure: RawFailureContext,
    priorAttempts: number,
  ): FailureDecision | null {
    switch (category) {
      case "TREE_REGRESSION":
        return {
          action: "abandon",
          reason:
            "post-merge verification failed against the merged tree (tree regression); " +
            "the task's own changes did not cause this failure and replanning would " +
            "dispatch into the same broken tree",
          attempts: priorAttempts,
          failure,
        };

      case "VERIFICATION_GAP":
      case "COMPILATION_ERROR":
      case "AGENT_STUCK":
      case "SPAWN_FAILURE":
      case "MERGE_CONFLICT":
        return null;

      default: {
        const _exhaustive: never = category;
        throw new Error(
          `Unhandled FailureCategory in FailureRouter: ${String(_exhaustive)}`,
        );
      }
    }
  }
}
