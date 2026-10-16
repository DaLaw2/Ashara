import { z } from "zod";
import type { ErrorLayer } from "@ashara/shared";
import { errorEnvelopeSchema, renderChainForBrief } from "./error-envelope.js";

// Replan context injection: the FailureRouter replans a failed item back to Pending and Delivery
// persists the raw failure context on WorkItem.blockedReason.replanContext. Surfacing it in the
// next brief — read BEFORE the agent dispatch, never cleared in between (startWorkItem does not
// touch blockedReason) — is what makes a replan an INFORMED retry instead of a repeat of the exact
// attempt that just failed.

const ReplanContextSchema = z.object({
  attempt: z.number(),
  detail: z.string(),
  raw: z.unknown(),
});

type ReplanContext = z.infer<typeof ReplanContextSchema>;

/**
 * Fail-safe (Discipline A): the replan context is jsonb round-tripped through the DB, so a
 * malformed one must never crash brief assembly — it just means the "Prior Attempt Failure"
 * section is omitted. Absence is the normal (non-replanned) case and is silent; a
 * present-but-malformed shape is unexpected and is logged.
 */
function extractReplanContext(taskId: string, candidate: unknown): ReplanContext | null {
  if (candidate === undefined) return null;
  const parsed = ReplanContextSchema.safeParse(candidate);
  if (!parsed.success) {
    console.warn(
      `[${taskId}] malformed blockedReason.replanContext (expected {attempt: number, detail: string, raw}); ` +
        `omitting Prior Attempt Failure section from brief:`,
      candidate,
    );
    return null;
  }
  return parsed.data;
}

function innermostLayer(layer: ErrorLayer): ErrorLayer {
  let current = layer;
  while (current.cause) {
    current = current.cause;
  }
  return current;
}

function formatPriorAttemptFailure(ctx: ReplanContext): string {
  const envelopeParsed = errorEnvelopeSchema.safeParse(ctx.raw);
  if (envelopeParsed.success) {
    const envelope = envelopeParsed.data;
    const diagnostic = innermostLayer(envelope.chain).message;

    const lines: string[] = [
      `# CRITICAL: Previous attempt FAILED — read this FIRST`,
      ``,
      `Your previous attempt (attempt ${ctx.attempt}) failed. You MUST address this before doing anything else.`,
      ``,
      `## What failed`,
      diagnostic,
      ``,
      `## Do NOT repeat`,
      `YOU MUST fix: ${diagnostic}. Previous attempt failed because ${ctx.detail}.`,
      ``,
      renderChainForBrief(envelope),
    ];
    return lines.join("\n");
  }

  let rawText: string;
  try {
    rawText = JSON.stringify(ctx.raw, null, 2);
  } catch {
    rawText = String(ctx.raw);
  }

  return [
    `# CRITICAL: Previous attempt FAILED — read this FIRST`,
    ``,
    `Your previous attempt (attempt ${ctx.attempt}) failed. You MUST address this before doing anything else.`,
    ``,
    `## What failed`,
    `Detail: ${ctx.detail}`,
    ``,
    `## Do NOT repeat`,
    `Do NOT repeat the same approach that produced this failure.`,
    ``,
    `## Previous attempt's raw failure payload`,
    "```",
    rawText,
    "```",
  ].join("\n");
}

/**
 * The brief's "Prior Attempt Failure" section for a replanned task, from the replan context Delivery
 * recorded with its last failure; undefined when it was not replanned (no context given).
 */
export function priorAttemptFailure(taskId: string, recordedContext: unknown): string | undefined {
  const replanContext = extractReplanContext(taskId, recordedContext);
  return replanContext ? formatPriorAttemptFailure(replanContext) : undefined;
}
