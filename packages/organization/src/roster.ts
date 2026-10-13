import { z } from "zod";
import type { ProjectId } from "@ashara/shared";

/** @testseam adopted by t-roster-derivation (s-team-roster-m1) */
export const CAPABILITY_CLASSES = ["client-comms", "write-source", "author-checks", "write-environment"] as const;

/** @testseam adopted by t-roster-derivation (s-team-roster-m1) */
export const CapabilityClassSchema = z.enum(CAPABILITY_CLASSES);

/** @testseam adopted by t-roster-derivation (s-team-roster-m1) */
export type CapabilityClass = z.infer<typeof CapabilityClassSchema>;

type NonEmpty<T> = readonly [T, ...T[]];

/** @testseam adopted by t-roster-derivation (s-team-roster-m1) */
export interface Role {
  readonly id: string;
  readonly name: string;
  readonly responsibility: string;
  readonly capabilities: NonEmpty<CapabilityClass>;
}

/** @testseam adopted by t-roster-derivation (s-team-roster-m1) */
export interface Roster {
  readonly projectId: ProjectId;
  readonly visionVersion: number;
  readonly revision: number;
  readonly roles: NonEmpty<Role>;
}

/** @testseam adopted by t-roster-derivation (s-team-roster-m1) */
export interface RoleRef {
  readonly id: string;
  readonly name: string;
}

/** @testseam adopted by t-roster-derivation (s-team-roster-m1) */
export type RosterViolation =
  | { readonly kind: "empty-roster" }
  | { readonly kind: "capability-unheld"; readonly capability: CapabilityClass }
  | {
      readonly kind: "capability-held-by-several";
      readonly capability: "client-comms" | "write-environment";
      readonly roles: readonly RoleRef[];
    }
  | {
      readonly kind: "client-comms-not-exclusive";
      readonly role: RoleRef;
      readonly otherCapabilities: readonly CapabilityClass[];
    }
  | {
      readonly kind: "conflicting-capabilities";
      readonly role: RoleRef;
      readonly capabilities: readonly [CapabilityClass, CapabilityClass];
    }
  | { readonly kind: "duplicate-role-name"; readonly name: string; readonly roles: readonly RoleRef[] };

const SINGLE_HOLDER: readonly ("client-comms" | "write-environment")[] = ["client-comms", "write-environment"];

// Separation of duties: whoever authors the checks must not also be judged by them.
const CONFLICTS: readonly (readonly [CapabilityClass, CapabilityClass])[] = [
  ["write-source", "author-checks"],
  ["write-environment", "author-checks"],
];

function ref(role: Role): RoleRef {
  return { id: role.id, name: role.name };
}

/**
 * Every rule a roster must satisfy, as violations; an empty result is the only valid verdict.
 * @testseam adopted by t-roster-derivation (s-team-roster-m1)
 */
export function validateRoster(roster: Roster): readonly RosterViolation[] {
  // The type forbids it, but a roster read back from an LLM or a row must still not pass as "no violations".
  const roles: readonly Role[] = roster.roles;
  if (roles.length === 0) {
    return [{ kind: "empty-roster" }];
  }

  const violations: RosterViolation[] = [];
  const holders = (capability: CapabilityClass): readonly Role[] =>
    roles.filter((role) => role.capabilities.includes(capability));

  for (const capability of CAPABILITY_CLASSES) {
    if (holders(capability).length === 0) {
      violations.push({ kind: "capability-unheld", capability });
    }
  }

  for (const capability of SINGLE_HOLDER) {
    const held = holders(capability);
    if (held.length > 1) {
      violations.push({ kind: "capability-held-by-several", capability, roles: held.map(ref) });
    }
  }

  for (const role of holders("client-comms")) {
    const others = [...new Set(role.capabilities.filter((capability) => capability !== "client-comms"))];
    if (others.length > 0) {
      violations.push({ kind: "client-comms-not-exclusive", role: ref(role), otherCapabilities: others });
    }
  }

  for (const role of roles) {
    for (const pair of CONFLICTS) {
      if (role.capabilities.includes(pair[0]) && role.capabilities.includes(pair[1])) {
        violations.push({ kind: "conflicting-capabilities", role: ref(role), capabilities: pair });
      }
    }
  }

  const byName = new Map<string, Role[]>();
  for (const role of roles) {
    const key = role.name.trim().toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), role]);
  }
  for (const [name, named] of byName) {
    if (named.length > 1) {
      violations.push({ kind: "duplicate-role-name", name, roles: named.map(ref) });
    }
  }

  return violations;
}
