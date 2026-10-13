import { and, desc, eq, isNull } from "drizzle-orm";
import { parseProjectId, type ProjectId } from "@ashara/shared";
import type { DbHandle } from "../connection.js";
import { projects } from "../schema.js";

export interface ProjectRecord {
  readonly id: ProjectId;
  readonly name: string;
  readonly status: string;
  /** The client this project belongs to (migration 018). */
  readonly clientId: string;
  readonly createdAt: Date;
  /** The target workspace Delivery works in (migration 024); null until first minted. */
  readonly workspacePath: string | null;
}

type ProjectRow = typeof projects.$inferSelect;

function toRecord(row: ProjectRow): ProjectRecord {
  return {
    id: parseProjectId(row.id),
    name: row.name,
    status: row.status,
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

/** The Project Record (architecture K3): one row per tender, owned by one client. */
export class ProjectRepository {
  constructor(private readonly db: DbHandle) {}

  async create(name: string, clientId: string): Promise<ProjectRecord> {
    const [row] = await this.db.insert(projects).values({ name, clientId }).returning();
    return toRecord(row);
  }

  async get(id: ProjectId): Promise<ProjectRecord | null> {
    const [row] = await this.db.select().from(projects).where(eq(projects.id, id)).limit(1);
    return row ? toRecord(row) : null;
  }

  /** This client's projects, newest first. There is no unscoped listing. */
  async listByClient(clientId: string): Promise<ProjectRecord[]> {
    const rows = await this.db
      .select()
      .from(projects)
      .where(eq(projects.clientId, clientId))
      .orderBy(desc(projects.createdAt), desc(projects.id));
    return rows.map(toRecord);
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
}
