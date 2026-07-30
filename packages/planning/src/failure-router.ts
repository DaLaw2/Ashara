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
  readonly title: string;
  readonly parentId?: string;
  /**
   * Contract-registry keys this item PROMISED (mig9-t4): the module paths and
   * endpoint refs the ProjectContract attributes to it (providerWorkItem /
   * declaredBy). The caller derives them from the contract; a contract-less item
   * carries none and the router falls back to title equivalence.
   */
  readonly registryKeys?: readonly string[];
}

/**
 * The slice of plan state the router reasons over. `candidates` are the failed
 * item's siblings (same parent). A completed one is an equivalent when it delivers
 * the SAME contract-registry key the failed item promised (mig9-t4, the primary
 * signal) or — for contract-less plans — carries an equivalent title (Run-8 F3
 * fallback). `registryKeys` is what each candidate delivered, same derivation as
 * the item's.
 */
export interface FailurePlanState {
  readonly candidates: ReadonlyArray<{
    id: string;
    title: string;
    status: string;
    registryKeys?: readonly string[];
  }>;
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
  readonly planState: FailurePlanState;
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
 * reason (abandon/substitute) — the context never gets dropped at the boundary.
 */
export type FailureDecision =
  | { readonly action: "replan"; readonly attempt: number; readonly failure: RawFailureContext }
  | {
      readonly action: "substitute";
      readonly equivalentId: string;
      readonly reason: string;
      readonly failure: RawFailureContext;
    }
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
 *   1. substitute — a completed sibling with an equivalent title already delivers
 *      this work; the failed item is a duplicate, so no attempt is worth spending.
 *   2. replan    — attempts remain under the bound; retry, carrying the raw
 *      failure context forward so the next attempt is informed (never identical).
 *   3. abandon   — the bound is reached with no equivalent; terminate so the
 *      item's dependents stop waiting on a task that will not complete.
 *
 * The bound guarantees "bounded retries then switch": after `maxReplanAttempts`
 * the router must pick a different strategy (substitute) or abandon — it can
 * never emit an unbounded run of identical replans.
 */
export class FailureRouter {
  private readonly maxReplanAttempts: number;

  constructor(maxReplanAttempts = 2) {
    if (!Number.isInteger(maxReplanAttempts) || maxReplanAttempts < 0) {
      throw new FailureRouterConfigError(maxReplanAttempts);
    }
    this.maxReplanAttempts = maxReplanAttempts;
  }

  /**
   * The replan bound this router enforces (`priorAttempts < replanBound` ⇒ replan).
   * Exposed so the termination seam can share the SAME bound value the router was
   * constructed with (mig7-t3): isRecoverableFailed reads it to decide whether a
   * parked Failed item still has a route out, so the two never drift from a
   * separately hardcoded constant.
   */
  get replanBound(): number {
    return this.maxReplanAttempts;
  }

  route(input: FailureRouteInput): FailureDecision {
    const parsed = rawFailureContextSchema.safeParse(input.failure);
    if (!parsed.success) {
      throw new FailureContextError(input.item.id, parsed.error.issues);
    }
    const failure = parsed.data;

    const equivalent = this.findEquivalent(input);
    if (equivalent) {
      return {
        action: "substitute",
        equivalentId: equivalent.id,
        reason: equivalent.reason,
        failure,
      };
    }

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

  /**
   * Finds a completed sibling that already delivers this failed item's work, in
   * two ordered passes — both fail-closed (a candidate must be Completed):
   *   1. registry equivalence (primary): a completed candidate whose registry keys
   *      (module paths / endpoint refs) are a SUPERSET of everything this failed
   *      item promised. Requiring FULL coverage — not just one shared key — is what
   *      distinguishes a genuine duplicate (its twin delivers all of it) from a mere
   *      co-editor of shared wiring (e.g. two routes both touching src/routes/index.ts):
   *      the co-editor covers the shared aggregator but NOT the failed item's own
   *      unique deliverable, so it is not a superset and never substitutes. Without
   *      this, a completed loginTask would falsely satisfy a failed registerTask and
   *      the register endpoint would silently never exist — the Run-9 class this guards.
   *   2. title equivalence (fallback): same normalized title — retained so
   *      contract-less plans (no registry keys) keep their Run-8 behavior.
   */
  private findEquivalent(
    input: FailureRouteInput,
  ): { id: string; title: string; reason: string } | null {
    const completed = input.planState.candidates.filter(
      (candidate) => candidate.id !== input.item.id && candidate.status === "Completed",
    );

    const targetKeys = [...new Set(input.item.registryKeys ?? [])];
    if (targetKeys.length > 0) {
      for (const candidate of completed) {
        const candidateKeys = new Set(candidate.registryKeys ?? []);
        if (targetKeys.every((key) => candidateKeys.has(key))) {
          return {
            id: candidate.id,
            title: candidate.title,
            reason: `completed item ${candidate.id} ("${candidate.title}") already delivers every registry entry this item promised (${targetKeys.join(", ")})`,
          };
        }
      }
    }

    const targetTitle = normalizeTitle(input.item.title);
    for (const candidate of completed) {
      if (normalizeTitle(candidate.title) === targetTitle) {
        return {
          id: candidate.id,
          title: candidate.title,
          reason: `equivalent completed item ${candidate.id} ("${candidate.title}") already satisfies this deliverable`,
        };
      }
    }
    return null;
  }
}

function normalizeTitle(title: string): string {
  return title.trim().toLowerCase();
}
