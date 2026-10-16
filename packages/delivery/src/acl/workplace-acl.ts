/**
 * Anti-Corruption Layer: Workplace (ADR-044, ADR-075).
 *
 * Outside dispatch/, the only file in @ashara/delivery that imports from @ashara/workplace. Delivery reads an
 * attempt's Outcome, Workplace's published language, as the claim it is: the verdict on the work
 * is Quality's, never the Outcome's.
 */

import type { AssignmentCharter, ToolProfile } from "@ashara/workplace";
import { UNKINDED_WORK_CHARTER, charterOf } from "./organization-acl.js";
import type { WorkKind } from "./organization-acl.js";
import { PUBLIC_INTERFACE_FILE } from "./quality-acl.js";

export type { DevSessionRepository, ErrorEnvelope, Outcome } from "@ashara/workplace";
export { ORPHANED_SESSION_RESOLVER, TERMINAL_SESSION_PHASES, toRecordedOutcome } from "@ashara/workplace";

/**
 * The tools and Z0 ports an attempt at each kind of work is given, in Workplace's language. Total
 * over WorkKind: a new kind of work does not compile until it is mapped here.
 */
const TOOL_PROFILE: Readonly<Record<WorkKind, ToolProfile>> = {
  environment: "build-environment",
  check: "define-checks",
  implementation: "run-and-dispute-checks",
};

/** What Workplace is told of a task's kind of work: the tools it is given and its role's charter. */
interface AttemptProfile {
  readonly toolProfile: ToolProfile;
  readonly charter: AssignmentCharter;
}

/**
 * The attempt profile of a task of this kind of work. A task with no recorded kind runs the stored
 * checks it has, disputes none, and is worked under the charter of no role's further duties.
 */
export function attemptProfileOf(workKind: WorkKind | null): AttemptProfile {
  if (workKind === null) return { toolProfile: "run-checks", charter: UNKINDED_WORK_CHARTER };
  return { toolProfile: TOOL_PROFILE[workKind], charter: charterOf(workKind, { publicInterfaceFile: PUBLIC_INTERFACE_FILE }) };
}
