/**
 * Anti-Corruption Layer: Quality.
 *
 * Outside dispatch/, Delivery reads Quality only here: the fault class a dispatch result names and
 * its verdict on a failed attempt with the schema it is read back from the database by, the
 * merge record of a task on main and the release of a task found merged there, the release of every
 * settled task's branches, the acceptance sweep it runs on a project, and the public
 * interface file, which Delivery plans the product scaffold to write and every check author to read
 * and Quality's suite review reads: the file is Quality's convention.
 */

export type { FailureVerdict, FaultClass, TaskVerification } from "@ashara/quality";
export {
  PUBLIC_INTERFACE_FILE,
  WORK_FAILED,
  failureVerdictSchema,
  releaseMergedTaskCheckout,
  releaseSettledBranches,
  taskMergeOnMain,
} from "@ashara/quality";
// Which revision of a task's stored checks is in force and what a stored check decides: Quality's
// published language for its task_checks rows, read by Delivery's plan revision.
export { inLatestCheckRevision, StoredDecidesSchema } from "@ashara/quality/stored-checks";
