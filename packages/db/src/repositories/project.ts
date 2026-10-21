import { and, asc, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { z } from "zod";
import { parseProjectId, type ProjectId } from "@ashara/shared";
import type { DbHandle } from "../connection.js";
import { insertedRow } from "../inserted-row.js";
import { PROJECT_LIFECYCLES, projects } from "../schema/index.js";

/**
 * A project row as stored: Engagement's lifecycle (active, stopped, accepted) and the identity
 * every context reads. Delivery's halt is not read here: Delivery's ProjectHaltRepository reads the
 * state the client sees, the halt included.
 */
export interface ProjectRow {
  readonly id: ProjectId;
  readonly name: string;
  readonly lifecycle: (typeof PROJECT_LIFECYCLES)[number];
  /** The client this project belongs to. */
  readonly clientId: string;
  readonly createdAt: Date;
  /** The target workspace Delivery works in; null until first minted. */
  readonly workspacePath: string | null;
}

const LifecycleSchema = z.enum(PROJECT_LIFECYCLES);

/** The columns a ProjectRow is read from. */
export const projectRowColumns = {
  id: projects.id,
  name: projects.name,
  lifecycle: projects.lifecycle,
  clientId: projects.clientId,
  createdAt: projects.createdAt,
  workspacePath: projects.workspacePath,
};

interface StoredProjectRow {
  readonly id: string;
  readonly name: string;
  readonly lifecycle: string;
  readonly clientId: string;
  readonly createdAt: Date;
  readonly workspacePath: string | null;
}

/** A row read by projectRowColumns, its lifecycle checked against Engagement's vocabulary. */
export function toProjectRow(row: StoredProjectRow): ProjectRow {
  return {
    id: parseProjectId(row.id, "projects.id"),
    name: row.name,
    lifecycle: LifecycleSchema.parse(row.lifecycle),
    clientId: row.clientId,
    createdAt: row.createdAt,
    workspacePath: row.workspacePath,
  };
}

/** A workspace path could not be recorded on the project. */
class WorkspacePathNotRecorded extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly candidatePath: string,
    readonly reason: string,
  ) {
    super(`cannot record workspace path ${candidatePath} on project ${projectId}: ${reason}`);
    this.name = "WorkspacePathNotRecorded";
  }
}

/**
 * The Project Record: one row per tender, owned by one client. Its lifecycle is
 * Engagement's (its project-lifecycle guard); its halt, the open block episode, is Delivery's:
 * Delivery's repository extends this one with the reads of it and the only writes of it.
 */
export class ProjectRepository {
  constructor(protected readonly db: DbHandle) {}

  async create(name: string, clientId: string): Promise<ProjectRow> {
    const rows = await this.db.insert(projects).values({ name, clientId }).returning(projectRowColumns);
    return toProjectRow(insertedRow(rows, "projects", `create project ${JSON.stringify(name)} for client ${clientId}`));
  }

  async get(id: ProjectId): Promise<ProjectRow | null> {
    const [row] = await this.db.select(projectRowColumns).from(projects).where(eq(projects.id, id)).limit(1);
    return row ? toProjectRow(row) : null;
  }

  /** This client's projects, newest first. There is no unscoped listing. */
  async listByClient(clientId: string): Promise<ProjectRow[]> {
    const rows = await this.db
      .select(projectRowColumns)
      .from(projects)
      .where(eq(projects.clientId, clientId))
      .orderBy(desc(projects.createdAt), desc(projects.id));
    return rows.map(toProjectRow);
  }

  /**
   * Stores `path` as the project's workspace unless one is already stored, and
   * returns whichever is stored. The first writer wins inside the UPDATE itself,
   * so two racing dispatches cannot leave one project with two workspaces.
   */
  async recordWorkspacePath(id: ProjectId, path: string): Promise<string> {
    const [claimed] = await this.db
      .update(projects)
      .set({ workspacePath: path })
      .where(and(eq(projects.id, id), isNull(projects.workspacePath)))
      .returning({ workspacePath: projects.workspacePath });
    if (claimed?.workspacePath) return claimed.workspacePath;
    const existing = await this.get(id);
    if (!existing) throw new WorkspacePathNotRecorded(id, path, "the project does not exist");
    if (existing.workspacePath === null) {
      throw new WorkspacePathNotRecorded(id, path, "the conditional UPDATE matched no row yet the path is still unset");
    }
    return existing.workspacePath;
  }

  /** Every project with a target workspace, whatever its status: what startup prunes environment images of. */
  async listWithWorkspace(): Promise<Array<{ readonly id: ProjectId; readonly workspacePath: string }>> {
    const rows = await this.db
      .select({ id: projects.id, workspacePath: projects.workspacePath })
      .from(projects)
      .where(isNotNull(projects.workspacePath))
      .orderBy(asc(projects.createdAt), asc(projects.id));
    const listed: Array<{ readonly id: ProjectId; readonly workspacePath: string }> = [];
    for (const row of rows) {
      if (row.workspacePath !== null) listed.push({ id: parseProjectId(row.id, "projects.id"), workspacePath: row.workspacePath });
    }
    return listed;
  }
}
