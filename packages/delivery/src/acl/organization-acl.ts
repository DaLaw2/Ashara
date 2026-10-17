/**
 * Anti-Corruption Layer: Organization.
 *
 * The ONLY file in @ashara/delivery that imports from @ashara/organization.
 * Organization is upstream of Delivery: the loop asks it to derive a roster for
 * each project that has vision v1 and none, before the project's first plan, and
 * reads back what happened; the planner and the staffing of each attempt read the
 * stored roster's roles and who owns each kind of work, and each attempt is handed the charter
 * of the role that owns its kind of work.
 */

export type { RosterDerivationStep, RosterOutcome, WorkKind } from "@ashara/organization";
export {
  UNKINDED_WORK_CHARTER,
  charterOf,
  parseWorkKind,
  RoleNotInRoster,
  RosterUnreadable,
  WorkKindOwnerUnresolved,
  ownerOf,
  parseStoredRoster,
  roleInRoster,
} from "@ashara/organization";
