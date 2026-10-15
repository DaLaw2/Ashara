/**
 * Anti-Corruption Layer: Quality (ADR-075).
 *
 * Outside dispatch/, the core loop reads Quality only here: the fault class a dispatch result
 * names, the merge record of a task on main, and the acceptance sweep it runs on a project.
 */

export type { FaultClass, TaskVerification } from "@ashara/quality";
export { taskMergeOnMain } from "@ashara/quality";
