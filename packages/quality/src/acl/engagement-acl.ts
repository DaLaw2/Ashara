/**
 * Anti-Corruption Layer: Engagement's vision language and published predicates.
 *
 * The suite review judges checks against the vision items their tasks cite, as Engagement
 * publishes them, read here from its published-language entry alone. The acceptance sweep admits a
 * project by its engagement lifecycle and the client's messages awaiting the Liaison, read in
 * Engagement's published predicates, and knows a stop told by its report's subject, named in
 * Engagement's report-subject vocabulary.
 */

export type { VisionSource } from "@ashara/engagement/vision";
export { visionSourceCitation } from "@ashara/engagement/vision";
export { noOpenAnswer, noOpenStop, projectActive, projectAtWork } from "@ashara/engagement/predicates";
export { REPORT_SUBJECT } from "@ashara/engagement/report-subjects";
// The acceptance moves Engagement's lifecycle in the sweep's own transaction, through the port Engagement declares.
export type { AcceptProject } from "@ashara/engagement/ports";
