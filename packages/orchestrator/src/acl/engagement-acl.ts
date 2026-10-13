/**
 * Anti-Corruption Layer: Engagement (ADR-044, ADR-075).
 *
 * The ONLY file in @ashara/orchestrator that imports from @ashara/engagement.
 * Delivery talks to the client only through Engagement: the loop asks the
 * Liaison to act on the client's stops, to take in pending tenders, to report
 * recorded planning outcomes to the client, and to record the stack a merged
 * Sprint 0 task chose as an assumption in the vision and report it, and reads
 * back what happened.
 */

export type { IntakeOutcome, LiaisonClientStops, LiaisonIntake, LiaisonPlanReports, LiaisonStackChoices } from "@ashara/engagement";
