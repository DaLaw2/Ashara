import { and, count, desc, eq, notInArray, sql } from "drizzle-orm";
import { devSessions } from "@ashara/db";
import type { Database } from "@ashara/db";
import { TERMINAL_SESSION_PHASES, type AttemptTerminal } from "./session-vocabulary.js";

/** A COUNT over dev_sessions returned no row: the evidence cannot be read, so nothing is decided on it. */
class DispatchEvidenceUnread extends Error {
  constructor(readonly taskId: string) {
    super(`dev_sessions of task ${taskId}: the count of crash-orphaned sessions returned no row`);
    this.name = "DispatchEvidenceUnread";
  }
}

/**
 * What the session's Workplace attempt was (migration 046), written with its terminal phase. The
 * terminal is the attempt's typed end ("finished:done", "turn_cap", ...); `cell` says whether it
 * ran on the BaseCell or on the session's environment version.
 */
interface SessionAttempt {
  readonly promptDigest: string;
  readonly terminal: AttemptTerminal;
  readonly turns: number;
  readonly provider: string;
  readonly model: string;
  readonly cell: "base-cell" | "environment";
}

function attemptColumns(attempt: SessionAttempt | null) {
  return {
    attemptPromptDigest: attempt?.promptDigest ?? null,
    attemptTerminal: attempt?.terminal ?? null,
    attemptTurns: attempt?.turns ?? null,
    attemptProvider: attempt?.provider ?? null,
    attemptModel: attempt?.model ?? null,
    attemptCell: attempt?.cell ?? null,
  };
}

/**
 * dev_sessions is an attempt log: when each attempt opened and how it ended (`phase`, and the end's
 * outcome and detail in verification_result). It holds no verdict on the task
 * and no record of what was merged, which is work_items.merge_commit (migration 041): its terminal
 * write is fail-soft (withSessionLifecycle), so no report or decision reads it as delivery.
 */
export class DevSessionRepository {
  constructor(private readonly db: Database) {}

  /** `environmentVersion`: the environment version the session's cells were built from; null on the BaseCell (migration 034). */
  async insert(sessionId: string, taskId: string, brief: unknown, environmentVersion: string | null) {
    await this.db.insert(devSessions).values({
      id: sessionId,
      taskId,
      phase: "Preparing",
      brief,
      environmentVersion,
    });
  }

  /**
   * `attempt`: null when no attempt outcome reached the session (it ended before the model, or its
   * attempt threw). Required, never defaulted: the six columns of migration 046 then stay NULL, and
   * NULL means only "no attempt recorded", never "no model call" (run-report reads it that way).
   * `attemptEnd`: how the session ended, in its own words, as `fail` writes a failure's, so a session
   * that completed without an attempt (work already delivered on main) says why.
   */
  async complete(sessionId: string, attempt: SessionAttempt | null, attemptEnd: { readonly outcome: "completed"; readonly detail: string }) {
    await this.db
      .update(devSessions)
      .set({
        ...attemptColumns(attempt),
        verificationResult: attemptEnd,
        phase: "Completed",
        updatedAt: new Date(),
      })
      .where(eq(devSessions.id, sessionId));
  }

  async fail(sessionId: string, attemptEnd: unknown, attempt: SessionAttempt | null) {
    await this.db
      .update(devSessions)
      .set({
        ...attemptColumns(attempt),
        verificationResult: attemptEnd,
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
   * reporting dead sessions as live agents forever. Returns the number of rows resolved so the reconcile summary can
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

  /**
   * What the task's sessions say about its last dispatch, for the startup reconciler: the phase
   * of its latest session (null when it has none), and how many of its sessions an earlier startup
   * reconcile already closed as crash orphans (failStale's verification result names
   * `resolvedBy`). Read before failStale closes this start's orphans.
   */
  async dispatchEvidence(
    taskId: string,
    resolvedBy: string,
  ): Promise<{ readonly latestPhase: string | null; readonly orphanedBefore: number }> {
    const [latest] = await this.db
      .select({ phase: devSessions.phase })
      .from(devSessions)
      .where(eq(devSessions.taskId, taskId))
      .orderBy(desc(devSessions.createdAt))
      .limit(1);
    const [orphaned] = await this.db
      .select({ count: count() })
      .from(devSessions)
      .where(
        and(
          eq(devSessions.taskId, taskId),
          sql`${devSessions.verificationResult} ->> 'resolvedBy' = ${resolvedBy}`,
        ),
      );
    if (orphaned === undefined) throw new DispatchEvidenceUnread(taskId);
    return { latestPhase: latest?.phase ?? null, orphanedBefore: orphaned.count };
  }

  async listActive() {
    return this.db
      .select()
      .from(devSessions)
      .where(notInArray(devSessions.phase, [...TERMINAL_SESSION_PHASES]));
  }
}
