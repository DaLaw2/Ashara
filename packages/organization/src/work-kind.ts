import type { ProjectId } from "@ashara/shared";
import type { CapabilityClass, Role, RoleRef, Roster, RosterViolation } from "./roster.js";
import { ref } from "./roster.js";

// Who owns a WorkKind (ADR-075 context map: Organization is upstream of Delivery).
// The owner is the role holding the capability the kind of work needs; M1 assigns
// deterministically, so that capability must have exactly one holder.

const WORK_KINDS = ["environment", "implementation", "check"] as const;

export type WorkKind = (typeof WORK_KINDS)[number];

const CAPABILITY_FOR: Readonly<Record<WorkKind, CapabilityClass>> = {
  environment: "write-environment",
  implementation: "write-source",
  check: "author-checks",
};

/** A work kind's capability has no holder, or several, so no owner can be assigned. */
export class WorkKindOwnerUnresolved extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly rosterRevision: number,
    readonly workKind: WorkKind,
    readonly capability: CapabilityClass,
    readonly holders: readonly RoleRef[],
  ) {
    super(
      `project ${projectId} roster revision ${rosterRevision}: ${workKind} work needs "${capability}", ` +
        `held by ${holders.length} role(s) [${holders.map((h) => h.name).join(", ")}]; exactly one is required`,
    );
    this.name = "WorkKindOwnerUnresolved";
  }
}

function holdersOf(roster: Roster, workKind: WorkKind): readonly Role[] {
  return roster.roles.filter((role) => role.capabilities.includes(CAPABILITY_FOR[workKind]));
}

/** The one role that owns work of this kind in the roster. */
export function ownerOf(roster: Roster, workKind: WorkKind): Role {
  const holders = holdersOf(roster, workKind);
  const [only] = holders;
  if (holders.length !== 1 || only === undefined) {
    throw new WorkKindOwnerUnresolved(
      roster.projectId,
      roster.revision,
      workKind,
      CAPABILITY_FOR[workKind],
      holders.map(ref),
    );
  }
  return only;
}

/**
 * Every work kind whose capability several roles hold, so no single owner can be
 * assigned. An unheld capability is validateRoster's violation, not repeated here.
 */
export function assignmentViolations(roster: Roster): readonly RosterViolation[] {
  return WORK_KINDS.flatMap((workKind): RosterViolation[] => {
    const holders = holdersOf(roster, workKind);
    return holders.length <= 1
      ? []
      : [{ kind: "work-kind-owner-not-single", workKind, capability: CAPABILITY_FOR[workKind], roles: holders.map(ref) }];
  });
}
