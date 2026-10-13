import { z } from "zod";
import type { ProjectId } from "@ashara/shared";
import { CapabilityClassSchema, RoleSchema, describeViolation, nonEmptyArray, validateRoster } from "./roster.js";
import type { Roster } from "./roster.js";
import { assignmentViolations } from "./work-kind.js";

// A roster read back from roster_roles (migration 031): the rows of one revision,
// parsed, never cast, and held to the same rules derivation enforced.

const RosterSchema = z.strictObject({
  visionVersion: z.number().int().min(1),
  revision: z.number().int().min(1),
  roles: nonEmptyArray(RoleSchema),
});

const RosterRowSchema = z.object({
  revision: z.number(),
  visionVersion: z.number(),
  roleId: z.string(),
  name: z.string(),
  responsibility: z.string(),
  capabilities: z.array(CapabilityClassSchema),
});

/** The stored roster of a project cannot be read as a valid roster. */
export class RosterUnreadable extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly problem: string,
  ) {
    super(`project ${projectId}: the stored roster is not a valid roster: ${problem}`);
    this.name = "RosterUnreadable";
  }
}

/** The project's roster from the rows of its latest revision. */
export function parseStoredRoster(projectId: ProjectId, rows: unknown): Roster {
  const parsedRows = nonEmptyArray(RosterRowSchema).safeParse(rows);
  if (!parsedRows.success) throw new RosterUnreadable(projectId, z.prettifyError(parsedRows.error));

  const revisions = new Set(parsedRows.data.map((row) => row.revision));
  const visionVersions = new Set(parsedRows.data.map((row) => row.visionVersion));
  if (revisions.size !== 1 || visionVersions.size !== 1) {
    throw new RosterUnreadable(
      projectId,
      `rows mix revisions [${[...revisions].join(", ")}] or vision versions [${[...visionVersions].join(", ")}]`,
    );
  }

  const [first] = parsedRows.data;
  const parsed = RosterSchema.safeParse({
    revision: first.revision,
    visionVersion: first.visionVersion,
    roles: parsedRows.data.map((row) => ({
      id: row.roleId,
      name: row.name,
      responsibility: row.responsibility,
      capabilities: row.capabilities,
    })),
  });
  if (!parsed.success) throw new RosterUnreadable(projectId, z.prettifyError(parsed.error));

  const roster: Roster = { projectId, ...parsed.data };
  const violations = [...validateRoster(roster), ...assignmentViolations(roster)];
  if (violations.length > 0) throw new RosterUnreadable(projectId, violations.map(describeViolation).join(" "));
  return roster;
}
