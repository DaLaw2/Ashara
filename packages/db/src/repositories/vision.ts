import { desc, eq, sql } from "drizzle-orm";

import type { Database } from "../connection.js";
import { visionDocuments } from "../schema.js";

export class VisionRepository {
  constructor(private readonly db: Database) {}

  async create(doc: Omit<typeof visionDocuments.$inferInsert, "id" | "version" | "createdAt">) {
    const [row] = await this.db
      .insert(visionDocuments)
      .values({
        ...doc,
        version: sql`(SELECT COALESCE(MAX(version), 0) + 1 FROM vision_documents)`,
      })
      .returning();
    return row;
  }

  async getLatest() {
    const [row] = await this.db
      .select()
      .from(visionDocuments)
      .orderBy(desc(visionDocuments.version))
      .limit(1);
    return row ?? null;
  }

  async getById(id: string) {
    const [row] = await this.db
      .select()
      .from(visionDocuments)
      .where(eq(visionDocuments.id, id))
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
