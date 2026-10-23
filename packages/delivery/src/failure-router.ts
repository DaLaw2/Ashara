import { z } from "zod";
import type { FailureVerdict } from "./acl/quality-acl.js";

/**
 * Raw failure context handed to the FailureRouter. Carries the unabridged
 * failure signal (agent/gate output object + the failure detail string) with no
 * lossy summarisation, so a re-planned attempt can be told exactly WHY the last
 * one failed (Discipline C — error reproducibility).
 */
const rawFailureContextSchema = z.object({
  detail: z.string(),
  raw: z.record(z.string(), z.unknown()),
});

export type RawFailureContext = z.infer<typeof rawFailureContextSchema>;

interface FailureRouterItem {
  readonly id: string;
}

interface FailureRouteCommon {
  readonly item: FailureRouterItem;
  readonly failure: RawFailureContext;
  /**
   * How many dispatch attempts have been made for this item so far. The orchestrator
   * sources this from the WorkItem's dispatch counter, which is
   * incremented at the dispatch seam — so by recovery time it already includes the
   * attempt that just failed. The router replans while this is under the bound, so a
   * bound of N caps the item at N dispatches before it must switch or abandon.
   */
  readonly priorAttempts: number;
}

/**
 * A failed attempt and Quality's verdict on it: a retryable failure is routed against the
 * replan bound; a non-retryable one is given up at once and spends no retry. The verdict is set
 * where the failure is decided, never read back out of the failure's text.
 */
type FailureRouteInput = FailureRouteCommon & { readonly verdict: FailureVerdict };

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

class FailureRouterError extends Error {
  // open-by-design: diagnostic context varies per error site (config, item state, etc.)
  readonly context: Record<string, unknown>;

  constructor(message: string, context: Record<string, unknown>) { // open-by-design
    super(message);
    this.name = "FailureRouterError";
    this.context = context;
  }
}

class FailureRouterConfigError extends FailureRouterError {
  constructor(maxReplanAttempts: number) {
    super(`FailureRouter.maxReplanAttempts must be a non-negative integer, got ${maxReplanAttempts}`, {
      maxReplanAttempts,
    });
    this.name = "FailureRouterConfigError";
  }
}

class FailureContextError extends FailureRouterError {
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
 * decision. Deterministic and rule-based — no LLM,
 * no I/O — so the same inputs always yield the same decision and it fails closed:
 * an undecidable input throws rather than silently leaving the item stuck.
 *
 * Rule ladder (first match wins):
 *   0. abandon — a non-retryable verdict: another attempt would be handed the same failure.
 *   1. replan  — attempts remain under the bound; retry, carrying the raw
 *      failure context forward so the next attempt is informed (never identical).
 *   2. abandon — the bound is reached; terminate so the item's dependents stop
 *      waiting on a task that will not complete. The reason names the verdict's ground.
 *
 * An abandoned task is repaired around by the next plan revision: the
 * plan_repair_on_abandon trigger records it in plan_repairs.
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
    const { verdict, priorAttempts } = input;

    if (verdict.kind === "non-retryable") {
      return { action: "abandon", reason: nonRetryableReason(verdict.ground), attempts: priorAttempts, failure };
    }
    if (priorAttempts < this.maxReplanAttempts) {
      return { action: "replan", attempt: priorAttempts + 1, failure };
    }
    return { action: "abandon", reason: this.exhaustedReason(verdict.ground, priorAttempts), attempts: priorAttempts, failure };
  }

  /** Why a retryable failure is abandoned at the replan bound, by the verdict's ground. */
  private exhaustedReason(ground: Extract<FailureVerdict, { kind: "retryable" }>["ground"], priorAttempts: number): string {
    switch (ground) {
      // The task's own tree passed its gate, and its merge with main failed the post-merge
      // verification: which side broke the merged tree is not known. Each attempt started with main
      // merged into its branch (Quality's mainMergedForRetry), so it worked on the tree the failure
      // was found on and was told that failure.
      case "tree-regression":
        return (
          `the task's merge with main still failed post-merge verification (tree regression) after ${priorAttempts} attempt(s), ` +
          "each started on main merged into its branch; the plan is repaired around it"
        );
      // The branch met main's newer work: each attempt started with main merged into its branch and
      // the conflict in its worktree (Quality's conflictWithMain), so no replan was the same attempt.
      case "merge-conflict":
        return `the task's branch still conflicts with main after ${priorAttempts} attempt(s); the plan is repaired around it`;
      case "work":
        return `exhausted ${this.maxReplanAttempts} replan attempt(s) without success`;
    }
  }
}

/** Why a non-retryable failure is abandoned at once, by the verdict's ground. */
function nonRetryableReason(ground: Extract<FailureVerdict, { kind: "non-retryable" }>["ground"]): string {
  switch (ground) {
    // One attempt is handed the conflict. Its finishing done with markers left leaves the overlap
    // between the work and main to the plan to re-cut.
    case "conflict-markers-left":
      return "the attempt was handed its conflict with main and left conflict markers in it; the plan is repaired around it";
    // The held-set rule's retry budget is spent: the set was handed its reason on every attempt it allows.
    case "held-set-given-up":
      return (
        "its check set holds whole on the plan's foundation and was rejected for the same reason and items as often as " +
        "the held-set rule allows; the task is given up and the plan is repaired around it"
      );
  }
}
