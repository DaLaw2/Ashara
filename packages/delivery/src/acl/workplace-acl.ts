/**
 * Anti-Corruption Layer: Workplace (ADR-044, ADR-075).
 *
 * The ONLY file in @ashara/delivery that imports from @ashara/workplace. Delivery reads an
 * attempt's Outcome, Workplace's published language, as the claim it is: the verdict on the work
 * is Quality's, never the Outcome's.
 */

export type { Outcome } from "@ashara/workplace";
export { ORPHANED_SESSION_RESOLVER, toRecordedOutcome } from "@ashara/workplace";
