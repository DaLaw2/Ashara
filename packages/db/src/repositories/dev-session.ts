import { eq, notInArray } from "drizzle-orm";
import { TERMINAL_SESSION_PHASES } from "@ashara/shared";
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

  /**
   * Terminalizes every session left in a non-terminal phase, for the startup
   * reconciler (Discipline B). The server is single-process (ADR-022), so at boot
   * no session can legitimately be in flight: every surviving `Preparing` row is a
   * crash orphan whose agent is gone. Leaving them would keep `listActive()`
   * reporting dead sessions as live agents forever, which is exactly what E2E Run
   * 39 did. Returns the number of rows resolved so the reconcile summary can
   * report it rather than closing them silently.
   */
  async failStale(verificationResult: unknown): Promise<number> {
    const rows = await this.db
      .update(devSessions)
      .set({
        verificationResult,
        phase: "Failed",
        updatedAt: new Date(),
      })
      .where(notInArray(devSessions.phase, [...TERMINAL_SESSION_PHASES]))
      .returning({ id: devSessions.id });
    return rows.length;
  }

  async listActive() {
    return this.db
      .select()
      .from(devSessions)
      .where(notInArray(devSessions.phase, [...TERMINAL_SESSION_PHASES]));
  }
}
