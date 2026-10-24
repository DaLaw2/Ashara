import { and, asc, desc, eq, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { parseProjectId, type ProjectId } from "@ashara/shared";
import { projects, qualifiedColumn, type Database, type DbHandle } from "@ashara/db";
import { rosterRoles } from "@ashara/db/schema/organization";
import { storedVisionVersion } from "./acl/engagement-vision-acl.js";
import type { VisionAwaitingRoster } from "./derivation.js";
import type { Roster } from "./roster.js";

// A project's roster: the rows of its latest revision. Derived
// from vision v1 before the first plan; the table is append-only.

/** The vision a first roster is derived from. */
const FIRST_VISION_VERSION = 1;

/** A first roster was asked to be written with a revision other than the first. */
class RosterRevisionNotFirst extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly revision: number,
  ) {
    super(`cannot record a first roster for project ${projectId} as revision ${revision}; a first roster is revision 1`);
    this.name = "RosterRevisionNotFirst";
  }
}

/** The project the roster is for does not exist. */
class RosterProjectMissing extends Error {
  constructor(readonly projectId: ProjectId) {
    super(`cannot record a roster: no project ${projectId}`);
    this.name = "RosterProjectMissing";
  }
}

const noRoster = () => sql`NOT EXISTS (SELECT 1 FROM roster_roles r WHERE r.project_id = ${projects.id})`;

/** The project has a roster: a row of any revision. */
export const hasRoster = (projectId: AnyColumn): SQL => sql`EXISTS (SELECT 1 FROM roster_roles r WHERE r.project_id = ${qualifiedColumn(projectId)})`;

/** The role `roleId` names is a role of the project's latest roster revision. */
export const roleOfLatestRoster = (projectId: string, roleId: AnyColumn): SQL => sql`EXISTS (
  SELECT 1 FROM roster_roles r
  WHERE r.project_id = ${projectId} AND r.role_id = ${roleId}
    AND r.revision = (SELECT MAX(l.revision) FROM roster_roles l WHERE l.project_id = ${projectId}))`;

/**
 * Projects every condition of `admitted` admits, with vision v1 and no roster, oldest first, each
 * with vision v1 as stored. The caller states which projects a roster is derived for in the words of
 * the contexts that own the facts (a project at work, no stop awaiting the Liaison, nothing planned
 * yet and no planning outcome stamped), which Organization reads only through their published reads. A
 * project already planned before rosters existed is not listed: its items were written without
 * owners, and a roster now would own none.
 */
export async function listProjectsAwaitingRoster(db: DbHandle, admitted: readonly [SQL, ...SQL[]]): Promise<VisionAwaitingRoster[]> {
  const firstVision = storedVisionVersion(projects.id, FIRST_VISION_VERSION);
  const rows = await db
    .select({ id: projects.id, vision: firstVision })
    .from(projects)
    .where(and(...admitted, sql`${firstVision} IS NOT NULL`, noRoster()))
    .orderBy(asc(projects.createdAt), asc(projects.id));
  return rows.map((row) => ({ projectId: parseProjectId(row.id, "projects.id"), vision: row.vision }));
}

/**
 * Appends a project's first roster in one transaction with the project row
 * locked, or nothing when the project already has a roster.
 */
export async function recordFirstRoster(db: Database, write: Roster): Promise<"recorded" | "roster-exists"> {
  if (write.revision !== 1) throw new RosterRevisionNotFirst(write.projectId, write.revision);
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, write.projectId))
      .for("update");
    if (!locked) throw new RosterProjectMissing(write.projectId);

    const [existing] = await tx
      .select({ revision: rosterRoles.revision })
      .from(rosterRoles)
      .where(eq(rosterRoles.projectId, write.projectId))
      .limit(1);
    if (existing) return "roster-exists";

    await tx.insert(rosterRoles).values(
      write.roles.map((role) => ({
        projectId: write.projectId,
        revision: write.revision,
        roleId: role.id,
        name: role.name,
        responsibility: role.responsibility,
        capabilities: [...role.capabilities],
        visionVersion: write.visionVersion,
      })),
    );
    return "recorded";
  });
}

/** The rows of the project's latest roster revision, by name; empty when it has none. Rows are never updated. */
export async function latestRosterRoles(db: DbHandle, projectId: ProjectId) {
  const revision = await latestRosterRevision(db, projectId);
  if (revision === null) return [];
  return db
    .select({
      revision: rosterRoles.revision,
      visionVersion: rosterRoles.visionVersion,
      roleId: rosterRoles.roleId,
      name: rosterRoles.name,
      responsibility: rosterRoles.responsibility,
      capabilities: rosterRoles.capabilities,
    })
    .from(rosterRoles)
    .where(and(eq(rosterRoles.projectId, projectId), eq(rosterRoles.revision, revision)))
    .orderBy(asc(rosterRoles.name));
}

/** The project's latest roster revision; null when it has no roster. */
export async function latestRosterRevision(db: DbHandle, projectId: ProjectId): Promise<number | null> {
  const [latest] = await db
    .select({ revision: rosterRoles.revision })
    .from(rosterRoles)
    .where(eq(rosterRoles.projectId, projectId))
    .orderBy(desc(rosterRoles.revision))
    .limit(1);
  return latest?.revision ?? null;
}
