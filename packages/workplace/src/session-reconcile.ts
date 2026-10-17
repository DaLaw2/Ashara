/**
 * The `resolvedBy` the startup reconcile records on every crash-orphaned session it closes.
 * Delivery counts a task's earlier crash-orphaned dispatches by it, so it is published, never restated.
 */
export const ORPHANED_SESSION_RESOLVER = "startup-reconciler";

/**
 * The `resolvedBy` on a session the startup reconcile closes whose dispatch had ended: its task was
 * not InProgress at the start, so only the session's terminal write was lost. Never counted as a
 * crash orphan, so a lost write never takes a later crash orphan's refund away.
 */
const ENDED_SESSION_RESOLVER = "startup-reconciler:dispatch-ended";

/** What closing a session at startup records as its verification result. */
interface StaleSessionResolution {
  readonly outcome: "abandoned";
  readonly detail: string;
  readonly resolvedBy: string;
  readonly resolvedAt: string;
}

/** The session store's view of the startup reconcile; DevSessionRepository satisfies it. */
interface OrphanedSessionStore {
  /**
   * Closes every session still in a non-terminal phase: one of a task in `inProgressTaskIds` with
   * `orphaned`, any other with `ended`; returns how many each.
   */
  failStale(
    orphaned: StaleSessionResolution,
    ended: StaleSessionResolution,
    inProgressTaskIds: readonly string[],
  ): Promise<{ readonly orphaned: number; readonly ended: number }>;
}

/** What the startup reconcile of sessions did: how many it closed, or why it could not. */
type SessionReconcile =
  | { readonly kind: "terminalized"; readonly orphaned: number; readonly ended: number }
  | { readonly kind: "failed"; readonly error: unknown };

/**
 * Startup (Discipline B): closes every session a previous process left in a non-terminal phase.
 * The server is single-process, so at boot no session can legitimately be in flight: an
 * exact classification, not a heuristic timeout. Left open, they are reported as live agents forever.
 *
 * Run after Delivery's reconcile of its work items, which reads a still-open session as evidence
 * that a dispatch never finished. `inProgressTaskIds` are the tasks found InProgress before that
 * reconcile moved them: only their sessions are crash orphans. A store failure does not refuse the
 * start: the rows are already stranded, the next start retries, and the failure is returned and
 * logged as such, never as "nothing to close".
 */
export async function terminalizeOrphanedSessions(store: OrphanedSessionStore, inProgressTaskIds: readonly string[]): Promise<SessionReconcile> {
  const resolvedAt = new Date().toISOString();
  try {
    const closed = await store.failStale(
      {
        outcome: "abandoned",
        detail: "session was still non-terminal at process start; its agent did not survive the previous process",
        resolvedBy: ORPHANED_SESSION_RESOLVER,
        resolvedAt,
      },
      {
        outcome: "abandoned",
        detail: "session was still non-terminal at process start, but its task was not InProgress: its dispatch ended and only this session's terminal write was lost",
        resolvedBy: ENDED_SESSION_RESOLVER,
        resolvedAt,
      },
      inProgressTaskIds,
    );
    console.log(
      `[session-reconcile] terminalized ${closed.orphaned} crash-orphaned session(s) and ${closed.ended} session(s) of an ended dispatch ` +
        `whose terminal write was lost, left non-terminal by a previous process`,
    );
    return { kind: "terminalized", ...closed };
  } catch (error) {
    console.warn("[session-reconcile] the session reconcile failed; leaked sessions stay non-terminal until the next start:", error);
    return { kind: "failed", error };
  }
}
