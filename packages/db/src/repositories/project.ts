import { eq } from "drizzle-orm";
import { parseProjectId, type ProjectId } from "@ashara/shared";
import type { Database, DbHandle } from "../connection.js";
import { projects, visionDocuments } from "../schema.js";
import { VisionRepository, type VisionInput } from "./vision.js";

export interface ProjectRecord {
  readonly id: ProjectId;
  readonly name: string;
  readonly status: string;
  readonly createdAt: Date;
}

type ProjectRow = typeof projects.$inferSelect;

function toRecord(row: ProjectRow): ProjectRecord {
  return { id: parseProjectId(row.id), name: row.name, status: row.status, createdAt: row.createdAt };
}

/** The Project Record (architecture K3): one row per tender. */
export class ProjectRepository {
  constructor(private readonly db: DbHandle) {}

  async create(name: string): Promise<ProjectRecord> {
    const [row] = await this.db.insert(projects).values({ name }).returning();
    return toRecord(row);
  }

  async get(id: ProjectId): Promise<ProjectRecord | null> {
    const [row] = await this.db.select().from(projects).where(eq(projects.id, id)).limit(1);
    return row ? toRecord(row) : null;
  }
}

export interface CreatedProject {
  readonly project: ProjectRecord;
  readonly vision: typeof visionDocuments.$inferSelect;
}

/**
 * A tender: the project row and its vision version 1, committed together so no
 * project exists without its vision and no vision without its project.
 */
export async function createProjectWithVision(
  db: Database,
  name: string,
  vision: VisionInput,
): Promise<CreatedProject> {
  return db.transaction(async (tx) => {
    const project = await new ProjectRepository(tx).create(name);
    const created = await new VisionRepository(tx).create(project.id, vision);
    return { project, vision: created };
  });
}
