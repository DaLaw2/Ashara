import { z } from "zod";

/**
 * Subdirectory of `workdirBase` that holds each task's records, written Z0-side and never into
 * the worktree: `records/<taskId>/<sessionId>/` carries the dispatch's brief and the attempt's
 * conversation, locatable by task id after the worktree is gone.
 */
export const CONVERSATION_RECORDS_DIR = "records";

/**
 * Every typed end a Workplace attempt can record on its dev_sessions row: the Outcome kind, with a
 * finished attempt's status. The `attempt_terminal` CHECK (migrations/046_dev_session_attempt_evidence.sql, widened by 050)
 * admits exactly these; integration's lifecycle-lists.test.ts compares the two.
 */
export const ATTEMPT_TERMINALS = [
  "finished:done",
  "finished:blocked",
  "disputed",
  "model_stopped_without_finish",
  "output_truncated",
  "turn_cap",
  "wall_clock",
  "transport_exhausted",
  "refused",
  "environment_failure",
  "cancelled",
] as const;

export type AttemptTerminal = (typeof ATTEMPT_TERMINALS)[number];

/**
 * The phases a dev_sessions row can hold. Only these three are ever written, and
 * the `dev_sessions.phase` CHECK constraint (migrations/001_initial.sql) refuses
 * anything else, so a phase the code cannot produce cannot reach the DB either.
 * `Preparing` is the only non-terminal phase; a session in it after a restart is
 * a crash orphan, not a live agent.
 */
type SessionPhase = "Preparing" | "Completed" | "Failed";

export const TERMINAL_SESSION_PHASES: readonly SessionPhase[] = ["Completed", "Failed"] as const;

/** A dev_sessions.id, a uuid column. */
const SessionIdSchema = z.guid().brand<"SessionId">();

type SessionId = z.infer<typeof SessionIdSchema>;

export function createSessionId(): SessionId {
  return SessionIdSchema.parse(crypto.randomUUID());
}
