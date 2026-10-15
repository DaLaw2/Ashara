import { z } from "zod";
import type { FailureCategory } from "./failure-classifier.js";

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
   * The router consults it before applying the replan bound: the merge
   * categories have routes of their own (categoryRoute). Required so that an
   * unparseable envelope cannot silently pick a route — the caller must supply a category, and the
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
 * decision (ADR-029 / migration Phase 6). Deterministic and rule-based — no LLM,
 * no I/O — so the same inputs always yield the same decision and it fails closed:
 * an undecidable input throws rather than silently leaving the item stuck.
 *
 * Rule ladder (first match wins):
 *   0. a category with a route of its own (categoryRoute): tree regressions and
 *      merge conflicts, each bounded.
 *   1. replan  — attempts remain under the bound; retry, carrying the raw
 *      failure context forward so the next attempt is informed (never identical).
 *   2. abandon — the bound is reached; terminate so the item's dependents stop
 *      waiting on a task that will not complete.
 *
 * An abandoned task is repaired around by the next plan revision: the
 * plan_repair_on_abandon trigger (migrations 045, 048) records it in plan_repairs.
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

    const routed = this.categoryRoute(input.category, failure, input.priorAttempts);
    if (routed) return routed;

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
   * is a compile error, not a silent fall-through. Returns the decision of a
   * category routed on its own; null means "proceed to the normal
   * replan-or-abandon ladder."
   */
  private categoryRoute(
    category: FailureCategory,
    failure: RawFailureContext,
    priorAttempts: number,
  ): FailureDecision | null {
    switch (category) {
      // The task's own tree passed its gate, and its merge with main failed the post-merge
      // verification: which side broke the merged tree is not yet known. Abandoning on the first
      // occurrence gave up work that may have been correct and left a broken tree with no repair
      // path (lessons digest P6). The next attempt starts with main merged into its branch
      // (development's mergeMainIntoBranch), so it works on the tree the failure was found on and is
      // told that failure: it attributes and repairs it there. Bounded by the replan bound; past it
      // the plan is repaired around the task.
      case "TREE_REGRESSION":
        if (priorAttempts < this.maxReplanAttempts) return { action: "replan", attempt: priorAttempts + 1, failure };
        return {
          action: "abandon",
          reason:
            `the task's merge with main still failed post-merge verification (tree regression) after ${priorAttempts} attempt(s), ` +
            "each started on main merged into its branch; the plan is repaired around it",
          attempts: priorAttempts,
          failure,
        };

      // The branch met main's newer work, first or again after a resolved conflict (main moved under
      // it): the next attempt starts with main merged into its branch and the conflict in its
      // worktree (development's conflictWithMain), so the replan is never the same attempt again.
      // Bounded by the replan bound.
      case "MERGE_CONFLICT":
        if (priorAttempts < this.maxReplanAttempts) return { action: "replan", attempt: priorAttempts + 1, failure };
        return {
          action: "abandon",
          reason: `the task's branch still conflicts with main after ${priorAttempts} attempt(s); the plan is repaired around it`,
          attempts: priorAttempts,
          failure,
        };

      // Bound: one attempt is handed the conflict. Its finishing done with markers left leaves the
      // overlap between the work and main to the plan to re-cut (w12b D2: the plan repair is what recovered).
      case "MERGE_CONFLICT_PERSISTS":
        return {
          action: "abandon",
          reason: "the attempt was handed its conflict with main and left conflict markers in it; the plan is repaired around it",
          attempts: priorAttempts,
          failure,
        };

      case "VERIFICATION_GAP":
      case "COMPILATION_ERROR":
      case "AGENT_STUCK":
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
