import { z } from "zod";
import type { ProjectId } from "@ashara/shared";

const CAPABILITY_CLASSES = ["client-comms", "write-source", "author-checks", "write-environment"] as const;

export const CapabilityClassSchema = z.enum(CAPABILITY_CLASSES);

export type CapabilityClass = z.infer<typeof CapabilityClassSchema>;

type NonEmpty<T> = readonly [T, ...T[]];

export interface Role {
  readonly id: string;
  readonly name: string;
  readonly responsibility: string;
  readonly capabilities: NonEmpty<CapabilityClass>;
}

export interface Roster {
  readonly projectId: ProjectId;
  readonly visionVersion: number;
  readonly revision: number;
  readonly roles: NonEmpty<Role>;
}

/** A non-empty array whose parsed type says so. */
export function nonEmptyArray<T extends z.ZodType>(item: T) {
  return z.tuple([item], item);
}

export const RoleSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  responsibility: z.string().min(1),
  capabilities: nonEmptyArray(CapabilityClassSchema),
});

/** The items as a non-empty tuple, or null when there are none. */
export function nonEmptyOrNull<T>(items: readonly T[]): NonEmpty<T> | null {
  const [first, ...rest] = items;
  return items.length === 0 ? null : [first, ...rest];
}

export interface RoleRef {
  readonly id: string;
  readonly name: string;
}

export type RosterViolation =
  | { readonly kind: "empty-roster" }
  | { readonly kind: "role-without-capabilities"; readonly role: RoleRef }
  | { readonly kind: "duplicate-role-id"; readonly id: string; readonly roles: readonly RoleRef[] }
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
  | { readonly kind: "duplicate-role-name"; readonly name: string; readonly roles: readonly RoleRef[] }
  | {
      readonly kind: "work-kind-owner-not-single";
      readonly workKind: string;
      readonly capability: CapabilityClass;
      readonly roles: readonly RoleRef[];
    };

const SINGLE_HOLDER: readonly ("client-comms" | "write-environment")[] = ["client-comms", "write-environment"];

// Separation of duties: whoever authors the checks must not also be judged by them.
const CONFLICTS: readonly (readonly [CapabilityClass, CapabilityClass])[] = [
  ["write-source", "author-checks"],
  ["write-environment", "author-checks"],
];

export function ref(role: Role): RoleRef {
  return { id: role.id, name: role.name };
}

function grouped(roles: readonly Role[], key: (role: Role) => string): [string, Role[]][] {
  const groups = new Map<string, Role[]>();
  for (const role of roles) {
    const k = key(role);
    groups.set(k, [...(groups.get(k) ?? []), role]);
  }
  return [...groups].filter(([, members]) => members.length > 1);
}

/**
 * Every rule a roster must satisfy, as violations; an empty result is the only valid verdict.
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

  for (const role of roles) {
    // The type forbids it too; a role that may do nothing is not a role.
    const capabilities: readonly CapabilityClass[] = role.capabilities;
    if (capabilities.length === 0) violations.push({ kind: "role-without-capabilities", role: ref(role) });
  }

  for (const [id, same] of grouped(roles, (role) => role.id)) {
    violations.push({ kind: "duplicate-role-id", id, roles: same.map(ref) });
  }

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

  for (const [name, named] of grouped(roles, (role) => role.name.trim().toLowerCase())) {
    violations.push({ kind: "duplicate-role-name", name, roles: named.map(ref) });
  }

  return violations;
}

function names(roles: readonly RoleRef[]): string {
  return roles.map((role) => JSON.stringify(role.name)).join(", ");
}

/** One violation as a sentence a model or an operator can act on. */
export function describeViolation(violation: RosterViolation): string {
  switch (violation.kind) {
    case "empty-roster":
      return "The roster has no roles.";
    case "role-without-capabilities":
      return `Role ${JSON.stringify(violation.role.name)} holds no capability class.`;
    case "duplicate-role-id":
      return `Roles ${names(violation.roles)} share the id ${JSON.stringify(violation.id)}.`;
    case "capability-unheld":
      return `No role holds "${violation.capability}"; exactly one role must hold it.`;
    case "capability-held-by-several":
      return `"${violation.capability}" is held by several roles (${names(violation.roles)}); exactly one role may hold it.`;
    case "client-comms-not-exclusive":
      return (
        `Role ${JSON.stringify(violation.role.name)} holds "client-comms" together with ` +
        `${violation.otherCapabilities.map((c) => `"${c}"`).join(", ")}; the client-comms role holds nothing else.`
      );
    case "conflicting-capabilities":
      return (
        `Role ${JSON.stringify(violation.role.name)} holds both "${violation.capabilities[0]}" and ` +
        `"${violation.capabilities[1]}"; no role may hold both.`
      );
    case "duplicate-role-name":
      return `Roles ${names(violation.roles)} share the name ${JSON.stringify(violation.name)}; role names are unique.`;
    case "work-kind-owner-not-single":
      return (
        `"${violation.capability}" (the capability ${violation.workKind} work needs) is held by several roles ` +
        `(${names(violation.roles)}); exactly one role must hold it, so that work has one owner.`
      );
  }
}
