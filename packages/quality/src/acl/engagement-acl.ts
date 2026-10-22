/**
 * Anti-Corruption Layer: Engagement's vision language and published predicates.
 *
 * The suite review judges checks against the vision items their tasks cite, as Engagement
 * publishes them, read here from its published-language entry alone. The acceptance sweep admits a
 * project by its engagement lifecycle and the client's messages awaiting the Liaison, and owes a
 * terminal sweep to each stop that stopped a project, read in Engagement's published message reads. Each
 * guarantee is judged on what Engagement's vision states of it.
 */

export type { Observation, VisionGuarantee, VisionSource } from "@ashara/engagement/vision";
export { visionSourceCitation } from "@ashara/engagement/vision";
export { noOpenAnswer, noOpenStop, projectActive, projectAtWork } from "@ashara/engagement/predicates";
export { stopsThatStopped } from "@ashara/engagement/message-reads";
// The acceptance moves Engagement's lifecycle in the sweep's own transaction, through the port Engagement declares.
export type { AcceptProject } from "@ashara/engagement/ports";
