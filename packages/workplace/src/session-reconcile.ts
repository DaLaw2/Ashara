/**
 * The `resolvedBy` the startup reconcile records on every session it closes. Delivery counts a
 * task's earlier crash-orphaned dispatches by it, so it is published, never restated.
 */
export const ORPHANED_SESSION_RESOLVER = "startup-reconciler";

/** What closing a crash-orphaned session records as its verification result. */
interface OrphanedSessionResolution {
  readonly outcome: "abandoned";
  readonly detail: string;
  readonly resolvedBy: string;
  readonly resolvedAt: string;
}

/** The session store's view of the startup reconcile; DevSessionRepository satisfies it. */
interface OrphanedSessionStore {
  /** Closes every session still in a non-terminal phase with `resolution`; returns how many. */
  failStale(resolution: OrphanedSessionResolution): Promise<number>;
}

/** What the startup reconcile of sessions did: how many it closed, or why it could not. */
type SessionReconcile =
  | { readonly kind: "terminalized"; readonly count: number }
  | { readonly kind: "failed"; readonly error: unknown };

/**
 * Startup (Discipline B): closes every session a crash left in a non-terminal phase. The server is
 * single-process (ADR-022), so at boot no session can legitimately be in flight: an exact
 * classification, not a heuristic timeout. Left open, they are reported as live agents forever.
 *
 * Run after Delivery's reconcile of its work items, which reads a still-open session as evidence
 * that a dispatch never finished. A store failure does not refuse the start: the rows are already
 * stranded, the next start retries, and the failure is returned and logged as such, never as
 * "nothing to close".
 */
export async function terminalizeOrphanedSessions(store: OrphanedSessionStore): Promise<SessionReconcile> {
  try {
    const count = await store.failStale({
      outcome: "abandoned",
      detail: "session was still non-terminal at process start; its agent did not survive the previous process",
      resolvedBy: ORPHANED_SESSION_RESOLVER,
      resolvedAt: new Date().toISOString(),
    });
    console.log(`[session-reconcile] terminalized ${count} crash-orphaned session(s) left non-terminal by a previous process`);
    return { kind: "terminalized", count };
  } catch (error) {
    console.warn("[session-reconcile] the session reconcile failed; leaked sessions stay non-terminal until the next start:", error);
    return { kind: "failed", error };
  }
}
