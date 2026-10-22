/**
 * Anti-Corruption Layer: Engagement's published predicates and message reads.
 *
 * The facts about a project's engagement lifecycle and the client's messages that Delivery's reads
 * admit projects by (at work, a stop or an answer awaiting the Liaison, the first plan told), and
 * what the Liaison has told of Delivery's halts and plans (its told record), read from Engagement's
 * predicates entry, and the words of the client message a correction answers, read from its
 * message-reads entry (never its index). Each entry reads Delivery's halt from Delivery's own
 * predicates, which import nothing of Delivery, so the two load without a cycle.
 */

export { clientMessageBodies } from "@ashara/engagement/message-reads";
export {
  firstPlanTold,
  firstPlanUnreported,
  haltReported,
  noOpenAnswer,
  noOpenStop,
  noUnverifiableContractHeld,
  planningStoppedTold,
  planRevisionTold,
  projectActive,
  projectAtWork,
} from "@ashara/engagement/predicates";
