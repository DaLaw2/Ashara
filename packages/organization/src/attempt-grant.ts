import type { ToolProfile } from "./acl/workplace-acl.js";
import { UNKINDED_WORK_CHARTER, charterOf } from "./charter.js";
import type { CharterConventions, RoleCharter } from "./charter.js";
import type { WorkKind } from "./work-kind.js";

/**
 * The tools and Z0 ports an attempt at each kind of work is granted, named in Workplace's
 * tool-profile vocabulary: each follows from the capability the kind of work needs. Total over
 * WorkKind: a new kind of work does not compile until it is granted a profile here.
 */
const TOOL_PROFILE_FOR: Readonly<Record<WorkKind, ToolProfile>> = {
  environment: "build-environment",
  check: "define-checks",
  implementation: "run-and-dispute-checks",
};

/** A task with no recorded kind of work runs the stored checks it has and disputes none. */
const UNKINDED_WORK_TOOL_PROFILE: ToolProfile = "run-checks";

/** What an attempt at a task is granted: the tools it is given and the charter of the role it works as. */
export interface AttemptGrant {
  readonly toolProfile: ToolProfile;
  readonly charter: RoleCharter;
}

/** The grant of an attempt at a task of this kind of work, or of a task with no recorded kind (null). */
export function attemptGrantOf(workKind: WorkKind | null, conventions: CharterConventions): AttemptGrant {
  if (workKind === null) return { toolProfile: UNKINDED_WORK_TOOL_PROFILE, charter: UNKINDED_WORK_CHARTER };
  return { toolProfile: TOOL_PROFILE_FOR[workKind], charter: charterOf(workKind, conventions) };
}
