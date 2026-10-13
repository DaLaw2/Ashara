import { desc, eq, sql } from "drizzle-orm";
import type { ProjectId } from "@ashara/shared";
import type { DbHandle } from "../connection.js";
import { visionDocuments } from "../schema.js";

export type VisionInput = Omit<typeof visionDocuments.$inferInsert, "id" | "projectId" | "version" | "createdAt">;

export class VisionRepository {
  constructor(private readonly db: DbHandle) {}

  /**
   * Appends the project's next vision version (its first is 1). The version is
   * computed in the INSERT itself; two racing writers that compute the same
   * number fail on UNIQUE (project_id, version) rather than sharing it.
   */
  async create(projectId: ProjectId, doc: VisionInput) {
    const [row] = await this.db
      .insert(visionDocuments)
      .values({
        ...doc,
        projectId,
        version: sql`(SELECT COALESCE(MAX(version), 0) + 1 FROM vision_documents WHERE project_id = ${projectId})`,
      })
      .returning();
    return row;
  }

  /** The project's highest vision version, or null when the project has none. */
  async getCurrent(projectId: ProjectId) {
    const [row] = await this.db
      .select()
      .from(visionDocuments)
      .where(eq(visionDocuments.projectId, projectId))
      .orderBy(desc(visionDocuments.version))
      .limit(1);
    return row ?? null;
  }

  async getProjectPath(visionId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ projectPath: visionDocuments.projectPath })
      .from(visionDocuments)
      .where(eq(visionDocuments.id, visionId))
      .limit(1);
    return row?.projectPath ?? null;
  }

  async setProjectPath(visionId: string, path: string): Promise<void> {
    await this.db
      .update(visionDocuments)
      .set({ projectPath: path })
      .where(eq(visionDocuments.id, visionId));
  }
}
