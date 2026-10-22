/**
 * Anti-Corruption Layer: Organization.
 *
 * With organization-roster-acl.ts (the stored roster), the only file in @ashara/delivery that
 * imports from @ashara/organization.
 * Organization is upstream of Delivery: the loop asks it to derive a roster for
 * each project that has vision v1 and none, before the project's first plan, and
 * reads back what happened; the planner and the staffing of each attempt read the
 * stored roster's roles and who owns each kind of work, and each attempt is handed Organization's
 * grant for its kind of work: its tool profile and the charter of the role that owns it.
 */

export type { AttemptGrant, RosterDerivationStep, RosterOutcome, WorkKind } from "@ashara/organization";
export {
  attemptGrantOf,
  parseWorkKind,
  RoleNotInRoster,
  RosterUnreadable,
  WorkKindOwnerUnresolved,
  ownerOf,
  parseStoredRoster,
  roleInRoster,
} from "@ashara/organization";
