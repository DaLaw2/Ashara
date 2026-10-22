/**
 * Anti-Corruption Layer: Workplace.
 *
 * Outside dispatch/, the only file in @ashara/delivery that imports from @ashara/workplace. Delivery reads an
 * attempt's Outcome, Workplace's published language, as the claim it is: the verdict on the work
 * is Quality's, never the Outcome's.
 */

import { attemptGrantOf } from "./organization-acl.js";
import type { AttemptGrant, WorkKind } from "./organization-acl.js";
import { PUBLIC_INTERFACE_FILE } from "./quality-acl.js";

export type { DevSessionRepository, ErrorEnvelope, Outcome } from "@ashara/workplace";
export { ORPHANED_SESSION_RESOLVER, TERMINAL_SESSION_PHASES, lastCompletedAttempts, toRecordedOutcome } from "@ashara/workplace";

/**
 * What Workplace is told of a task's kind of work: Organization's grant (the tools the attempt is
 * given and its role's charter), passed on as granted. Delivery supplies only the convention the
 * charter names, which Quality owns.
 */
export function attemptProfileOf(workKind: WorkKind | null): AttemptGrant {
  return attemptGrantOf(workKind, { publicInterfaceFile: PUBLIC_INTERFACE_FILE });
}
