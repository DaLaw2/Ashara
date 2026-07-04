import { eq, notInArray } from "drizzle-orm";

import type { Database } from "../connection.js";
import { devSessions } from "../schema.js";

export class DevSessionRepository {
  constructor(private readonly db: Database) {}

  async insert(sessionId: string, taskId: string, brief: unknown) {
    await this.db.insert(devSessions).values({
      id: sessionId,
      taskId,
      phase: "Preparing",
      brief,
    });
  }

  async complete(sessionId: string) {
    await this.db
      .update(devSessions)
      .set({
        verificationResult: { passed: true },
        phase: "Completed",
        updatedAt: new Date(),
      })
      .where(eq(devSessions.id, sessionId));
  }

  async fail(sessionId: string, verificationResult: unknown) {
    await this.db
      .update(devSessions)
      .set({
        verificationResult,
        phase: "Failed",
        updatedAt: new Date(),
      })
      .where(eq(devSessions.id, sessionId));
  }

  async listActive() {
    return this.db
      .select()
      .from(devSessions)
      .where(notInArray(devSessions.phase, ["Completed", "Failed"]));
  }
}
