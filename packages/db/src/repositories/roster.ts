import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { parseProjectId, type ProjectId } from "@ashara/shared";
import type { Database, DbHandle } from "../connection.js";
import { projects, rosterRoles, visionDocuments } from "../schema/index.js";
import { noOpenStop, projectAtWork } from "./project.js";

// A project's roster (migration 031): the rows of its latest revision. Derived
// from vision v1 before the first plan; the table is append-only.

/** The vision a first roster is derived from. */
const FIRST_VISION_VERSION = 1;

interface ProjectAwaitingRosterRow {
  readonly projectId: ProjectId;
  readonly vision: typeof visionDocuments.$inferSelect;
}

/** A roster to append: every role of one revision. */
interface RosterWrite {
  readonly projectId: ProjectId;
  readonly revision: number;
  readonly visionVersion: number;
  readonly roles: readonly {
    readonly roleId: string;
    readonly name: string;
    readonly responsibility: string;
    readonly capabilities: readonly string[];
  }[];
}

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

/**
 * Active projects with vision v1, no roster and nothing planned yet, oldest
 * first, each with vision v1. A project with a stop awaiting the Liaison is not
 * listed. A project already planned before rosters existed is not listed either:
 * its items were written without owners, and a roster now would own none of them.
 */
export async function listProjectsAwaitingRoster(db: DbHandle): Promise<ProjectAwaitingRosterRow[]> {
  const rows = await db
    .select({ id: projects.id, vision: visionDocuments })
    .from(projects)
    .innerJoin(
      visionDocuments,
      and(eq(visionDocuments.projectId, projects.id), eq(visionDocuments.version, FIRST_VISION_VERSION)),
    )
    .where(
      and(
        projectAtWork(),
        isNull(projects.firstPlannedAt),
        isNull(projects.planStoppedAt),
        sql`NOT EXISTS (SELECT 1 FROM work_items w WHERE w.project_id = ${projects.id})`,
        noRoster(),
        noOpenStop(projects.id),
      ),
    )
    .orderBy(asc(projects.createdAt), asc(projects.id));
  return rows.map((row) => ({ projectId: parseProjectId(row.id, "projects.id"), vision: row.vision }));
}

/**
 * Appends a project's first roster in one transaction with the project row
 * locked, or nothing when the project already has a roster.
 */
export async function recordFirstRoster(db: Database, write: RosterWrite): Promise<"recorded" | "roster-exists"> {
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
        roleId: role.roleId,
        name: role.name,
        responsibility: role.responsibility,
        capabilities: [...role.capabilities],
        visionVersion: write.visionVersion,
      })),
    );
    return "recorded";
  });
}

/** The rows of the project's latest roster revision, by name; empty when it has none. Rows are never updated (031). */
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
