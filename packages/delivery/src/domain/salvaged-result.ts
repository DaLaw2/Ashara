import { parseStoredBlockedReason } from "../work-item-language/blocked-reason.js";
import type { StoredBlockedReason } from "../work-item-language/blocked-reason.js";

/**
 * A reason augmented with a salvaged result: the result of an attempt whose item was preempted to
 * Abandoned while it ran, kept on the item's existing reason so cascade-completion (deliveredItsWork) can
 * see the work's outcome without reopening the terminal status. The augmented reason is validated
 * again through the stored schema, so it is never written in a shape no reader can parse.
 */
export function salvagedReason(
  reason: StoredBlockedReason,
  salvagedOutcome: "completed" | "failed" | "blocked",
  salvagedDetail: string,
): StoredBlockedReason {
  const augmented = parseStoredBlockedReason({ ...reason, salvagedOutcome, salvagedDetail, salvagedAt: new Date().toISOString() });
  // Unreachable for an object: parseStoredBlockedReason returns undefined only for null or undefined.
  if (augmented === undefined) throw new SalvagedReasonEmpty(reason.source);
  return augmented;
}

class SalvagedReasonEmpty extends Error {
  constructor(readonly source: StoredBlockedReason["source"]) {
    super(`salvaging a result onto a '${source}' reason produced no reason`);
    this.name = "SalvagedReasonEmpty";
  }
}
