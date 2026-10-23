import { z } from "zod";

/**
 * Quality's verdict on an attempt that did not pass, as Delivery routes it: whether another attempt can succeed, set where the failure is decided, never read
 * back out of its text. A retryable failure is retried within the task's attempts; a non-retryable
 * block is given up at once and spends no retry.
 * - `work`: the attempt's own work failed what judges it (its checks, its gate, a run that gave no
 *   verdict on it).
 * - `merge-conflict`: the branch met main's newer work; the next attempt starts on main merged in.
 * - `tree-regression`: the task's own tree passed its gate and the merge with main failed the same
 *   check (the post-merge discriminant): which side broke it is not known, so the next attempt
 *   starts on main merged in and is told the failure.
 * - `conflict-markers-left`: the attempt was handed its conflict with main and finished with
 *   conflict markers left in it; another attempt is handed the same conflict.
 * - `held-set-given-up`: a check set holding whole on its foundation was rejected for the same
 *   reason and items as often as the held-set rule bounds: its retry budget for that reason and
 *   those items is spent.
 */
export type FailureVerdict =
  | { readonly kind: "retryable"; readonly ground: "work" | "merge-conflict" | "tree-regression" }
  | { readonly kind: "non-retryable"; readonly ground: "conflict-markers-left" | "held-set-given-up" };

/**
 * The verdict as Delivery stores it with a Failed transition and reads it back (Zod at the database
 * boundary): exactly the variants of FailureVerdict, nothing else parses.
 */
export const failureVerdictSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("retryable"), ground: z.enum(["work", "merge-conflict", "tree-regression"]) }).strict(),
  z.object({ kind: z.literal("non-retryable"), ground: z.enum(["conflict-markers-left", "held-set-given-up"]) }).strict(),
]) satisfies z.ZodType<FailureVerdict>;

export const WORK_FAILED: FailureVerdict = { kind: "retryable", ground: "work" };
export const MERGE_CONFLICTED: FailureVerdict = { kind: "retryable", ground: "merge-conflict" };
export const TREE_REGRESSED: FailureVerdict = { kind: "retryable", ground: "tree-regression" };
export const CONFLICT_MARKERS_LEFT: FailureVerdict = { kind: "non-retryable", ground: "conflict-markers-left" };
export const HELD_SET_GIVEN_UP: FailureVerdict = { kind: "non-retryable", ground: "held-set-given-up" };
