import { and, desc, eq, inArray, notInArray } from "drizzle-orm";
import { devSessions } from "@ashara/db/schema/workplace";
import type { DbHandle } from "@ashara/db";
import {
  SessionEndSchema,
  parseCompletedSessionEnd,
  parseFailedSessionEnd,
  parseReconciledSessionEnd,
  resolvedByOf,
  type CompletedSessionEnd,
  type FailedSessionEnd,
  type ReconciledSessionEnd,
} from "./session-end.js";
import type { SessionAttempt } from "./session-attempt.js";
import { TERMINAL_SESSION_PHASES } from "./session-vocabulary.js";

/**
 * A terminal write matched no session still open: the id names no session (`phaseFound` null), or
 * its session already ended, and a terminal phase is never rewritten.
 */
class SessionTerminalWriteRefused extends Error {
  constructor(
    readonly sessionId: string,
    readonly phaseWritten: "Completed" | "Failed",
    readonly phaseFound: string | null,
  ) {
    super(
      phaseFound === null
        ? `dev_sessions ${sessionId}: cannot write phase ${phaseWritten}, no session has this id`
        : `dev_sessions ${sessionId}: cannot write phase ${phaseWritten}, the session already ended as ${phaseFound}`,
    );
    this.name = "SessionTerminalWriteRefused";
  }
}

const stillOpen = notInArray(devSessions.phase, [...TERMINAL_SESSION_PHASES]);

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
 * and no record of what was merged, which is work_items.merge_commit: its terminal
 * write is fail-soft (withSessionLifecycle), so no report or decision reads it as delivery.
 */
export class DevSessionRepository {
  constructor(private readonly db: DbHandle) {}

  /**
   * `environmentVersion`: the environment version the session's cells were built from; null on the BaseCell.
   * `traceId`: the trace of the dispatched attempt the session opens in.
   */
  async insert(sessionId: string, taskId: string, brief: unknown, environmentVersion: string | null, traceId: string) {
    await this.db.insert(devSessions).values({
      id: sessionId,
      taskId,
      phase: "Preparing",
      brief,
      environmentVersion,
      traceId,
    });
  }

  /**
   * `attempt`: null when no attempt outcome reached the session (it ended before the model, or its
   * attempt threw). Required, never defaulted: the six attempt columns then stay NULL, and
   * NULL means only "no attempt recorded", never "no model call" (run-report reads it that way).
   * `attemptEnd`: how the session ended, in its own words, as `fail` writes a failure's, so a session
   * that completed without an attempt (work already delivered on main) says why.
   */
  async complete(sessionId: string, attempt: SessionAttempt | null, attemptEnd: CompletedSessionEnd) {
    await this.end(sessionId, attempt, parseCompletedSessionEnd(attemptEnd), "Completed");
  }

  async fail(sessionId: string, attemptEnd: FailedSessionEnd, attempt: SessionAttempt | null) {
    await this.end(sessionId, attempt, parseFailedSessionEnd(attemptEnd), "Failed");
  }

  /** Ends a session still open; a terminal phase is final, so a second end of it is refused, never applied. */
  private async end(
    sessionId: string,
    attempt: SessionAttempt | null,
    attemptEnd: CompletedSessionEnd | FailedSessionEnd,
    phase: "Completed" | "Failed",
  ): Promise<void> {
    const ended = await this.db
      .update(devSessions)
      .set({
        ...attemptColumns(attempt),
        verificationResult: attemptEnd,
        phase,
        updatedAt: new Date(),
      })
      .where(and(eq(devSessions.id, sessionId), stillOpen))
      .returning({ id: devSessions.id });
    if (ended.length > 0) return;
    const [found] = await this.db.select({ phase: devSessions.phase }).from(devSessions).where(eq(devSessions.id, sessionId));
    throw new SessionTerminalWriteRefused(sessionId, phase, found === undefined ? null : found.phase);
  }

  /**
   * Terminalizes every session left in a non-terminal phase, for the startup
   * reconciler (Discipline B). The server is single-process, so at boot
   * no session can legitimately be in flight. Leaving them would keep `listActive()`
   * reporting dead sessions as live agents forever. A session of a task the start found
   * InProgress (`inProgressTaskIds`) is a crash orphan whose agent died with the process, closed
   * with `orphaned`; any other's dispatch ended, its task routed out of InProgress, and only its
   * terminal write was lost, so it is closed with `ended`, which dispatchEvidence never counts as
   * a crash orphan. Returns how many rows each closed, so the reconcile can report them rather
   * than closing them silently.
   */
  async failStale(
    orphanedEnd: ReconciledSessionEnd,
    endedEnd: ReconciledSessionEnd,
    inProgressTaskIds: readonly string[],
  ): Promise<{ readonly orphaned: number; readonly ended: number }> {
    const orphaned = parseReconciledSessionEnd(orphanedEnd);
    const ended = parseReconciledSessionEnd(endedEnd);
    return this.db.transaction(async (tx) => {
      const orphanedRows =
        inProgressTaskIds.length === 0
          ? []
          : await tx
              .update(devSessions)
              .set({ verificationResult: orphaned, phase: "Failed", updatedAt: new Date() })
              .where(and(stillOpen, inArray(devSessions.taskId, [...inProgressTaskIds])))
              .returning({ id: devSessions.id });
      const endedRows = await tx
        .update(devSessions)
        .set({ verificationResult: ended, phase: "Failed", updatedAt: new Date() })
        .where(stillOpen)
        .returning({ id: devSessions.id });
      return { orphaned: orphanedRows.length, ended: endedRows.length };
    });
  }

  /**
   * What the task's sessions say about its last dispatch, for the startup reconciler: the phase
   * of its latest session (null when it has none), and how many of its sessions an earlier startup
   * reconcile already closed as crash orphans (failStale's verification result names
   * `resolvedBy`). Read before failStale closes this start's orphans. Every end record of the task
   * is parsed, so an unreadable one refuses the evidence rather than counting as no orphan.
   */
  async dispatchEvidence(
    taskId: string,
    resolvedBy: string,
  ): Promise<{ readonly latestPhase: string | null; readonly orphanedBefore: number }> {
    const sessions = await this.db
      .select({ phase: devSessions.phase, end: devSessions.verificationResult })
      .from(devSessions)
      .where(eq(devSessions.taskId, taskId))
      .orderBy(desc(devSessions.createdAt));
    const ends = sessions.map((session) => SessionEndSchema.nullable().parse(session.end));
    const [latest] = sessions;
    return {
      latestPhase: latest === undefined ? null : latest.phase,
      orphanedBefore: ends.filter((end) => resolvedByOf(end) === resolvedBy).length,
    };
  }

  async listActive() {
    return this.db
      .select()
      .from(devSessions)
      .where(stillOpen);
  }
}
