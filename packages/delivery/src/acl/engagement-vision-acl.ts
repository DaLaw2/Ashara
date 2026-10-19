/**
 * Anti-Corruption Layer: Engagement's vision language.
 *
 * The vision items a task cites, as Engagement publishes them, read from its published-language
 * entry alone (never its index): Delivery's own work-item language, which Engagement reads back,
 * is built on them, so loading Engagement's services here would make the two load each other.
 */

export type { InterfaceEntry, VisionGuarantee, VisionSource } from "@ashara/engagement/vision";
export { ASSUMPTION_KIND_LABEL, ASSUMPTION_STANDING_LABEL, VisionSourceSchema, checkDecides, taskMayCite, visionSourceCitation, visionSourceLine } from "@ashara/engagement/vision";
