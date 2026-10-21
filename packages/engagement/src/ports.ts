import type { DbHandle, DbTransaction } from "@ashara/db";
import type { ProjectId } from "@ashara/shared";

// The ports Engagement declares for the transactional calls that cross into another context, kept
// only where one invariant spans both: the other context implements each, and the composition root
// wires it. The per-project row lock the caller holds is the consistency boundary of each call.

/** One applied correction as Delivery's hold reads it: the version it wrote, the message it answers and the keys it affects. */
interface AppliedCorrection {
  readonly projectId: ProjectId;
  readonly visionVersion: number;
  readonly requestedBy: string;
  readonly affected: readonly string[];
}

/**
 * Delivery's hold on the work an applied correction touches, written in the transaction that records
 * it, so no task citing a key it affects is dispatched after it applies.
 */
export type HoldCorrection = (tx: DbHandle, correction: AppliedCorrection) => Promise<unknown>;

/**
 * Engagement's move of the project to 'accepted', inside Quality's acceptance transaction, which
 * holds the project row locked and records the passed sweep the move requires.
 */
export type AcceptProject = (tx: DbTransaction, projectId: ProjectId) => Promise<void>;

/**
 * Delivery's end of the project's open halt, inside the transaction in which the client's stop moves
 * the project to 'stopped': a stopped project is never halted.
 */
export type EndHaltOnStop = (tx: DbHandle, projectId: ProjectId) => Promise<void>;
