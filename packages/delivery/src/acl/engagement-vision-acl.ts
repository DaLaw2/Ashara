/**
 * Anti-Corruption Layer: Engagement's vision language.
 *
 * The vision items a task cites, as Engagement publishes them, read from its published-language
 * entry alone (never its index): Delivery's own work-item language, which Engagement reads back,
 * is built on them, so loading Engagement's services here would make the two load each other.
 */

export type { InterfaceEntry, PlannedAssumption, VisionGuarantee, VisionSource } from "@ashara/engagement/vision";
export { ASSUMPTION_KIND_LABEL, ASSUMPTION_STANDING_LABEL, VisionSourceSchema, checkDecides, taskMayCite, visionSourceCitation, visionSourceLine } from "@ashara/engagement/vision";
// Whether a project has a vision, which version is in force and that version as stored, read inside
// Delivery's own admitting statement in Engagement's published reads.
export type { PublishedStoredVision } from "@ashara/engagement/vision";
export { currentStoredVision, currentVisionVersion, hasVision, parseStoredVision } from "@ashara/engagement/vision";
