import { describeErrorChain } from "@ashara/shared";
import type { AgentBrief } from "./agent-brief.js";
import type { ErrorEnvelope } from "./error-envelope.js";
import type { SessionAttempt } from "./session-attempt.js";

/**
 * The dev_sessions attempt log: when an attempt opened and how it ended. Not a verdict on the
 * task and not a record of what was merged (that is the work item's merge commit, migration
 * 041): its terminal write is fail-soft. One decision reads it: the startup reconcile refunds a
 * crash-orphaned dispatch whose latest session is still open, and counts the sessions it closed as
 * crash orphans; a session a lost terminal write left open is counted as one only when its task is
 * still InProgress at the next start (terminalizeOrphanedSessions).
 */
export interface SessionStore {
  /** `environmentVersion` is the version the dispatch's cells were built from; null on the BaseCell. */
  insert(sessionId: string, taskId: string, brief: unknown, environmentVersion: string | null): Promise<void>;
  /**
   * `attempt`: the session's Workplace attempt, or null when no attempt outcome reached it (ended before the model, or the attempt threw).
   * `attemptEnd`: the completion's own detail, so a session that completed with no attempt says why.
   */
  complete(sessionId: string, attempt: SessionAttempt | null, attemptEnd: { readonly outcome: "completed"; readonly detail: string }): Promise<void>;
  fail(sessionId: string, attemptEnd: unknown, attempt: SessionAttempt | null): Promise<void>;
}

/** Where the session's body leaves its attempt for the terminal write; null until the attempt returns. */
export interface AttemptSlot {
  attempt: SessionAttempt | null;
}

/** How a session's dispatch ended, as its terminal write records it. */
interface SessionEnd {
  readonly status: string;
  readonly detail: string;
  readonly errorEnvelope?: ErrorEnvelope;
}

/**
 * Opens the dev_sessions row and OWNS its terminal write. Every exit from
 * `body` — every return, every throw — lands on a `complete` or a `fail`, so a
 * failure return added to the dispatch later cannot leak a `Preparing` row that
 * `listActive()` would report as a live agent indefinitely. This is the ONLY
 * writer of a terminal phase, so "success transitions, failure does not" cannot
 * be expressed.
 *
 * The terminal write itself is fail-SOFT: a DB error here must not un-complete a
 * task that already passed its gates. A row left non-terminal by such an error is
 * resolved by the startup reconciler, the durable backstop Discipline B requires
 * — no in-process handler survives a crash.
 */
export async function withSessionLifecycle<R extends SessionEnd>(
  sessionStore: SessionStore,
  session: { readonly sessionId: string; readonly taskId: string; readonly brief: AgentBrief; readonly environmentVersion: string | null },
  body: (slot: AttemptSlot) => Promise<R>,
): Promise<R> {
  const { sessionId, taskId } = session;
  await sessionStore.insert(sessionId, taskId, session.brief, session.environmentVersion);

  // The attempt, when body ran one, is written with the terminal phase on every exit, a throw included.
  const slot: AttemptSlot = { attempt: null };
  let outcome: R;
  try {
    outcome = await body(slot);
  } catch (e) {
    await closeSession(taskId, sessionId, () =>
      sessionStore.fail(
        sessionId,
        {
          outcome: "errored",
          detail: describeErrorChain(e),
        },
        slot.attempt,
      ),
    );
    throw e;
  }

  if (outcome.status === "completed") {
    await closeSession(taskId, sessionId, () =>
      sessionStore.complete(sessionId, slot.attempt, { outcome: "completed", detail: outcome.detail }),
    );
  } else {
    await closeSession(taskId, sessionId, () =>
      sessionStore.fail(
        sessionId,
        {
          outcome: outcome.status,
          detail: outcome.detail,
          ...(outcome.errorEnvelope !== undefined ? { errorEnvelope: outcome.errorEnvelope } : {}),
        },
        slot.attempt,
      ),
    );
  }
  return outcome;
}

async function closeSession(taskId: string, sessionId: string, write: () => Promise<void>): Promise<void> {
  try {
    await write();
  } catch (e) {
    // eslint-disable-next-line ashara/catch-continue -- best effort: the dispatch's outcome is returned and routed as it is; the next start closes the open row as a crash orphan only when its task is still InProgress there, so the lost write takes no refund away and changes no verdict
    console.warn(
      `[${taskId}] failed to write the terminal dev_session phase for ${sessionId}; ` +
        `the row stays non-terminal until startup reconciliation resolves it:`,
      e,
    );
  }
}
