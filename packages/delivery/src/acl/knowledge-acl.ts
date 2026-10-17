/**
 * Anti-Corruption Layer: Knowledge.
 *
 * Outside dispatch/, the core loop reads Knowledge only here: a routed failure is recorded as a
 * failed approach with the lesson it teaches.
 */

export type { FailedApproachRepository } from "@ashara/knowledge";
export { recordFailedApproach } from "@ashara/knowledge";
