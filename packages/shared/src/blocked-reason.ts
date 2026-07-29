import { z } from "zod";

/**
 * Published Language: the persisted blockedReason payload on work items.
 * Discriminated on `source` — Ashara's own producers form a closed set;
 * a consumer switch that omits a variant is a compile error.
 *
 * `substitutedBy` is optional on ALL variants: liveness-recovery augments
 * any existing blockedReason with a substitute pointer after the fact,
 * regardless of which producer wrote the original.
 *
 * Open-text fields (reason, detail) stay open strings — they carry
 * LLM-authored or human-authored content, not a closed vocabulary.
 */

// Shared optional field: liveness-recovery can augment any variant.
const substitutedByField = { substitutedBy: z.string().optional() };

/** PlanningService.route marks a task as failed (no recovery path). */
const taskFailedSchema = z.object({
  source: z.literal("task_failed"),
  reason: z.string(),
  ...substitutedByField,
});

/** Orchestrator fallback when lifecycle route itself throws. */
const orchestratorErrorSchema = z.object({
  source: z.literal("orchestrator_error"),
  reason: z.string(),
  ...substitutedByField,
});

/**
 * Failure-recovery replan path: context for the next attempt, set on a
 * Pending item AFTER replanWorkItem clears blockedReason, so the next
 * execution knows why the prior attempt failed.
 */
const replanSchema = z.object({
  source: z.literal("replan"),
  replanContext: z.object({
    attempt: z.number(),
    detail: z.string(),
    raw: z.unknown(),
  }),
  ...substitutedByField,
});

/** FailureRouter abandon/substitute decisions (failure-recovery.ts). */
const failureRouterSchema = z.object({
  source: z.literal("failure_router"),
  reason: z.string(),
  attempts: z.number().optional(),
  lastFailure: z.unknown().optional(),
  detail: z.string().optional(),
  ...substitutedByField,
});

/** Shutdown-reconciler run-end sweep (shutdown-reconciler.ts). */
const shutdownReconcilerSchema = z.object({
  source: z.literal("shutdown-reconciler"),
  reason: z.string(),
  previousStatus: z.string(),
  ...substitutedByField,
});

/** Startup-reconciler orphan cleanup (startup-reconciler.ts). */
const startupReconcilerSchema = z.object({
  source: z.literal("startup-reconciler"),
  reason: z.string(),
  previousScope: z.string(),
  ...substitutedByField,
});

/** Task-split abandon: the original task is abandoned in favor of two subtasks. */
const splitOnFailureSchema = z.object({
  source: z.literal("split_on_failure"),
  reason: z.string(),
  attempts: z.number().optional(),
  lastFailure: z.unknown().optional(),
  ...substitutedByField,
});

/**
 * HTTP API (PATCH /work-items/:id/status). Passthrough preserves
 * caller-supplied fields — the user content is open-world.
 */
const apiSchema = z
  .object({
    source: z.literal("api"),
    ...substitutedByField,
  })
  .passthrough();

export const storedBlockedReasonSchema = z.discriminatedUnion("source", [
  taskFailedSchema,
  orchestratorErrorSchema,
  replanSchema,
  failureRouterSchema,
  splitOnFailureSchema,
  shutdownReconcilerSchema,
  startupReconcilerSchema,
  apiSchema,
]);

export type StoredBlockedReason = z.infer<typeof storedBlockedReasonSchema>;

/** Typed failure for a blocked_reason jsonb value that is present but unreadable. */
export class BlockedReasonCorrupt extends Error {
  constructor(
    public readonly raw: unknown,
    public readonly detail: string,
  ) {
    super(`stored blocked_reason is not a valid object (${detail})`);
    this.name = "BlockedReasonCorrupt";
  }
}

/**
 * Augments any StoredBlockedReason variant with `substitutedBy`. Used by
 * liveness-recovery when an Abandoned item's work is picked up by a
 * substitute. The spread preserves the original variant's `source`
 * discriminator; the type assertion bridges TypeScript's inability to
 * narrow through object spread on discriminated unions.
 */
export function withSubstitutedBy(
  reason: StoredBlockedReason,
  substitutedBy: string,
): StoredBlockedReason {
  return { ...reason, substitutedBy } as StoredBlockedReason;
}

/**
 * Parses a jsonb value from the `blocked_reason` column. Returns `undefined`
 * for null/undefined — absent blockedReason is a policy default (items in
 * Pending/InProgress/Completed legitimately carry none; unblockWorkItem and
 * replanWorkItem explicitly clear it). THROWS on a non-null value that
 * cannot be validated: a corrupt record must not masquerade as absent
 * (Discipline A).
 */
/**
 * Deliberately widens a typed StoredBlockedReason to Record<string, unknown>.
 * The original shape IS known (StoredBlockedReason), but three consumers need
 * the wide form (AbandonedItem.raw, RawFailureContext.raw). The exhaustive
 * switch ensures a new `source` variant is a compile error HERE, not a silent
 * pass-through.
 */
export function blockedReasonToRecord(reason: StoredBlockedReason): Record<string, unknown> { // contract-erasing
  switch (reason.source) {
    case "task_failed":
    case "orchestrator_error":
    case "replan":
    case "failure_router":
    case "split_on_failure":
    case "shutdown-reconciler":
    case "startup-reconciler":
    case "api":
      return { ...reason };
  }
  const _: never = reason;
  return _;
}

export function parseStoredBlockedReason(raw: unknown): StoredBlockedReason | undefined {
  if (raw === null || raw === undefined) return undefined;
  const result = storedBlockedReasonSchema.safeParse(raw);
  if (!result.success) {
    throw new BlockedReasonCorrupt(
      raw,
      result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  }
  return result.data;
}
