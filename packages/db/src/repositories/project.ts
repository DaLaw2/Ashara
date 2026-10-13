import { desc, eq } from "drizzle-orm";
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
}

type ProjectRow = typeof projects.$inferSelect;

function toRecord(row: ProjectRow): ProjectRecord {
  return {
    id: parseProjectId(row.id),
    name: row.name,
    status: row.status,
    clientId: row.clientId,
    createdAt: row.createdAt,
  };
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
}
