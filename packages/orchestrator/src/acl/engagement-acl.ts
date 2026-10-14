/**
 * Anti-Corruption Layer: Engagement (ADR-044, ADR-075).
 *
 * The ONLY file in @ashara/orchestrator that imports from @ashara/engagement.
 * Delivery talks to the client only through Engagement: the loop asks the
 * Liaison to act on the client's stops, to take in pending tenders, to read the
 * client's answers into the vision, to report
 * recorded planning outcomes to the client, and to record the stack a merged
 * Sprint 0 task chose as an assumption in the vision and report it, and to
 * report each project halt and resumption, and reads back what happened.
 */

export type {
  AnswerOutcome,
  IntakeOutcome,
  LiaisonAnswers,
  LiaisonBlockReports,
  LiaisonClientStops,
  LiaisonIntake,
  LiaisonPlanReports,
  LiaisonStackChoices,
} from "@ashara/engagement";
