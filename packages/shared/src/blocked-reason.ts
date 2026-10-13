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

// Shared optional fields: liveness-recovery and result salvage can augment
// any variant after the fact, regardless of which producer wrote the original.
// `substitutedBy` — liveness-recovery's substitute pointer.
// `salvagedOutcome/salvagedDetail/salvagedAt` — a result that returned for an
// Abandoned item, persisted so cascade-completion and liveness-recovery can see
// the work was done (or what the failure was) without reopening the terminal status.
const augmentationFields = {
  substitutedBy: z.string().optional(),
  salvagedOutcome: z.enum(["completed", "failed", "blocked"]).optional(),
  salvagedDetail: z.string().optional(),
  salvagedAt: z.string().optional(),
};

/** PlanningService.route marks a task as failed (no recovery path). */
const taskFailedSchema = z.object({
  source: z.literal("task_failed"),
  reason: z.string(),
  ...augmentationFields,
});

/** Orchestrator fallback when lifecycle route itself throws. */
const orchestratorErrorSchema = z.object({
  source: z.literal("orchestrator_error"),
  reason: z.string(),
  ...augmentationFields,
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
  ...augmentationFields,
});

/** FailureRouter abandon/substitute decisions (failure-recovery.ts). */
const failureRouterSchema = z.object({
  source: z.literal("failure_router"),
  reason: z.string(),
  attempts: z.number().optional(),
  lastFailure: z.unknown().optional(),
  detail: z.string().optional(),
  ...augmentationFields,
});

/** Shutdown-reconciler run-end sweep (shutdown-reconciler.ts). */
const shutdownReconcilerSchema = z.object({
  source: z.literal("shutdown-reconciler"),
  reason: z.string(),
  previousStatus: z.string(),
  ...augmentationFields,
});

/** Startup-reconciler orphan cleanup (startup-reconciler.ts). */
const startupReconcilerSchema = z.object({
  source: z.literal("startup-reconciler"),
  reason: z.string(),
  previousScope: z.string(),
  ...augmentationFields,
});

/**
 * HTTP API (PATCH /work-items/:id/status). Passthrough preserves
 * caller-supplied fields — the user content is open-world.
 */
const apiSchema = z
  .object({
    source: z.literal("api"),
    ...augmentationFields,
  })
  .passthrough();

export const storedBlockedReasonSchema = z.discriminatedUnion("source", [
  taskFailedSchema,
  orchestratorErrorSchema,
  replanSchema,
  failureRouterSchema,
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
 * Augments any StoredBlockedReason variant with salvaged-result fields. Used by
 * the orchestrator when an agent returns a result for an item that was preempted
 * to Abandoned during execution. The result (outcome + detail) is persisted on
 * the existing blockedReason so cascade-completion and liveness-recovery can see
 * it without reopening the terminal status. Same spread + assertion pattern as
 * withSubstitutedBy.
 */
export function withSalvagedResult(
  reason: StoredBlockedReason,
  salvagedOutcome: "completed" | "failed" | "blocked",
  salvagedDetail: string,
): StoredBlockedReason {
  return {
    ...reason,
    salvagedOutcome,
    salvagedDetail,
    salvagedAt: new Date().toISOString(),
  } as StoredBlockedReason;
}

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
