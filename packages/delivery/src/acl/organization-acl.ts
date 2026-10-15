/**
 * Anti-Corruption Layer: Organization (ADR-044, ADR-075).
 *
 * The ONLY file in @ashara/delivery that imports from @ashara/organization.
 * Organization is upstream of Delivery: the loop asks it to derive a roster for
 * each project that has vision v1 and none, before the project's first plan, and
 * reads back what happened; the planner and the staffing of each attempt read the
 * stored roster's roles and who owns each kind of work.
 */

export type { RosterDerivationStep, RosterOutcome } from "@ashara/organization";
export {
  RoleNotInRoster,
  RosterUnreadable,
  WorkKindOwnerUnresolved,
  ownerOf,
  parseStoredRoster,
  roleInRoster,
} from "@ashara/organization";
