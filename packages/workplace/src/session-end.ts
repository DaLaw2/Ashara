import { z } from "zod";
import { errorEnvelopeSchema } from "./error-envelope.js";

const COMPLETED = "completed";
const ABANDONED = "abandoned";

/** A session that completed, in its own words, so one with no attempt says why. */
const CompletedSessionEndSchema = z.strictObject({
  outcome: z.literal(COMPLETED),
  detail: z.string(),
});

/**
 * A session the startup reconcile closed: `resolvedBy` names which classification closed it, and
 * Delivery counts crash orphans by it.
 */
const ReconciledSessionEndSchema = z.strictObject({
  outcome: z.literal(ABANDONED),
  detail: z.string(),
  resolvedBy: z.string().min(1),
  resolvedAt: z.iso.datetime(),
});

/**
 * A session whose dispatch ended in anything but completion. The outcome is the dispatch's status,
 * a vocabulary Delivery owns downstream of Workplace, so it is any non-empty word but the two the
 * other ends own: a failure can never read as a completion or a reconcile.
 */
const FailedSessionEndSchema = z.strictObject({
  outcome: z
    .string()
    .min(1)
    .refine((outcome) => outcome !== COMPLETED && outcome !== ABANDONED, { message: `a failed session's outcome is neither "${COMPLETED}" nor "${ABANDONED}"` }),
  detail: z.string(),
  errorEnvelope: errorEnvelopeSchema.optional(),
});

/** How a dev_sessions row ended: its verification_result, written with its terminal phase and parsed on every read. */
export const SessionEndSchema = z.union([CompletedSessionEndSchema, ReconciledSessionEndSchema, FailedSessionEndSchema]);

export type SessionEnd = z.infer<typeof SessionEndSchema>;
export type CompletedSessionEnd = z.infer<typeof CompletedSessionEndSchema>;
export type ReconciledSessionEnd = z.infer<typeof ReconciledSessionEndSchema>;
export type FailedSessionEnd = z.infer<typeof FailedSessionEndSchema>;

export function parseCompletedSessionEnd(end: CompletedSessionEnd): CompletedSessionEnd {
  return CompletedSessionEndSchema.parse(end);
}

export function parseReconciledSessionEnd(end: ReconciledSessionEnd): ReconciledSessionEnd {
  return ReconciledSessionEndSchema.parse(end);
}

export function parseFailedSessionEnd(end: FailedSessionEnd): FailedSessionEnd {
  return FailedSessionEndSchema.parse(end);
}

/** The reconcile that closed the session, or null when the session's own terminal write did (or none has yet). */
export function resolvedByOf(end: SessionEnd | null): string | null {
  return end !== null && "resolvedBy" in end ? end.resolvedBy : null;
}
