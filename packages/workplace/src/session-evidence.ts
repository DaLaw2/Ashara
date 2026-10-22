import { sql } from "drizzle-orm";
import { z } from "zod";
import type { DbHandle } from "@ashara/db";
import { INIT_MIGRATION, firstAppliedAt, legacyMigrationFile } from "@ashara/db";
import { SessionEndSchema, resolvedByOf } from "./session-end.js";
import { ATTEMPT_TERMINALS, TERMINAL_SESSION_PHASES } from "./session-vocabulary.js";

/**
 * schema_migrations has no row for any migration that created the attempt columns, so no session
 * can be dated against them and a session without attempt columns cannot be told apart from one
 * written before they existed.
 */
class RunReportAttemptMigrationUnrecorded extends Error {
  constructor(readonly filenames: readonly string[]) {
    super(`run-report: schema_migrations has no row for any of ${filenames.join(", ")}; cannot tell a session written before the attempt columns from one with no recorded attempt`);
    this.name = "RunReportAttemptMigrationUnrecorded";
  }
}

/**
 * The migrations that create the attempt columns: the numbered file that added them on a database
 * that ran it, and the init on one built from it. The earliest applied is when the columns began;
 * a session created before it cannot have them. The numbered file is looked up by its change's name
 * in the list the init stands in for, so its number lives in one place.
 * @testseam session-evidence.test.ts checks the lookup without a database
 */
export function attemptMigrations(): readonly [string, string] {
  return [legacyMigrationFile("dev_session_attempt_evidence"), INIT_MIGRATION];
}

const count = z.coerce.number().int().nonnegative();

const AttemptSchema = z.object({
  promptDigest: z.string().regex(/^[0-9a-f]{64}$/),
  terminal: z.enum(ATTEMPT_TERMINALS),
  turns: count,
  provider: z.string().min(1),
  model: z.string().min(1),
  cell: z.enum(["base-cell", "environment"]),
});

const SessionRowSchema = z.object({
  sessionId: z.guid(),
  taskId: z.guid(),
  phase: z.string(),
  environmentVersion: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  end: SessionEndSchema.nullable(),
  attemptPromptDigest: z.string().nullable(),
  attemptTerminal: z.string().nullable(),
  attemptTurns: z.number().int().nullable(),
  attemptProvider: z.string().nullable(),
  attemptModel: z.string().nullable(),
  attemptCell: z.string().nullable(),
});

/**
 * What a session's row says about its attempt. Absent attempt columns never mean "no model call":
 * each NULL case names only what the row actually shows.
 * - `open`: the phase is not terminal (in flight, or a crash orphan not yet reconciled).
 * - `reconciled`: a reconciler (`by`), not the session itself, wrote its terminal phase.
 * - `predates-attempt-columns`: created before its database had the attempt columns.
 * - `completed-without-attempt`: it completed with no attempt (its work already delivered on main,
 *   so it says why); `endDetail` is its terminal write's own detail, null on a row written before a
 *   completion recorded one.
 * - `unrecorded`: it ended without an attempt outcome reaching it (before the model, or the attempt
 *   threw); `endOutcome` is its terminal write's outcome, when one was written.
 */
type SessionAttemptRecord =
  | { readonly kind: "recorded"; readonly attempt: z.infer<typeof AttemptSchema> }
  | { readonly kind: "open" }
  | { readonly kind: "reconciled"; readonly by: string }
  | { readonly kind: "predates-attempt-columns" }
  | { readonly kind: "completed-without-attempt"; readonly endDetail: string | null }
  | { readonly kind: "unrecorded"; readonly endOutcome: string | null };

/** One dev session of a task and what its row records about its attempt. */
export interface SessionEvidence {
  readonly sessionId: string;
  readonly phase: string;
  readonly environmentVersion: string | null;
  readonly createdAt: Date;
  /** Its row's last write: for a terminal session the terminal write, after every call its attempt made. */
  readonly updatedAt: Date;
  readonly attempt: SessionAttemptRecord;
}

function attemptRecord(row: z.infer<typeof SessionRowSchema>, attemptColumnsSince: Date): SessionAttemptRecord {
  const columns = [row.attemptPromptDigest, row.attemptTerminal, row.attemptTurns, row.attemptProvider, row.attemptModel, row.attemptCell];
  // The attempt columns' CHECK keeps the six together; parse them only when they are present.
  if (!columns.every((c) => c === null)) {
    return {
      kind: "recorded",
      attempt: AttemptSchema.parse({
        promptDigest: row.attemptPromptDigest,
        terminal: row.attemptTerminal,
        turns: row.attemptTurns,
        provider: row.attemptProvider,
        model: row.attemptModel,
        cell: row.attemptCell,
      }),
    };
  }
  if (!TERMINAL_SESSION_PHASES.some((phase) => phase === row.phase)) return { kind: "open" };
  const resolvedBy = resolvedByOf(row.end);
  if (resolvedBy !== null) return { kind: "reconciled", by: resolvedBy };
  if (row.createdAt < attemptColumnsSince) return { kind: "predates-attempt-columns" };
  if (row.phase === "Completed") return { kind: "completed-without-attempt", endDetail: row.end === null ? null : row.end.detail };
  return { kind: "unrecorded", endOutcome: row.end === null ? null : row.end.outcome };
}

/**
 * Every dev session of the tasks `taskIds` names, oldest first, each with the task it belongs to and
 * what its row records about its attempt. Every row is validated on the way out of Postgres. Fails
 * when the database records no migration that created the attempt columns, whether or not any
 * session exists, since no session could then be dated against them.
 */
export async function sessionEvidenceOf(
  db: DbHandle,
  taskIds: readonly string[],
): Promise<ReadonlyArray<{ readonly taskId: string; readonly session: SessionEvidence }>> {
  const [columnsFile, initFile] = attemptMigrations();
  const attemptColumnsSince = await firstAppliedAt(db, [columnsFile, initFile]);
  if (attemptColumnsSince === null) throw new RunReportAttemptMigrationUnrecorded([columnsFile, initFile]);
  const sessionRows =
    taskIds.length === 0
      ? { rows: [] }
      : await db.execute(sql`
    SELECT s.id AS "sessionId", s.task_id AS "taskId", s.phase, s.environment_version AS "environmentVersion",
           s.created_at AS "createdAt", s.updated_at AS "updatedAt", s.verification_result AS "end",
           s.attempt_prompt_digest AS "attemptPromptDigest",
           s.attempt_terminal AS "attemptTerminal", s.attempt_turns AS "attemptTurns",
           s.attempt_provider AS "attemptProvider", s.attempt_model AS "attemptModel", s.attempt_cell AS "attemptCell"
    FROM dev_sessions s
    WHERE s.task_id IN (${sql.join(taskIds.map((id) => sql`${id}::uuid`), sql`, `)})
    ORDER BY s.created_at, s.id`);
  return z.array(SessionRowSchema).parse(sessionRows.rows).map((row) => ({
    taskId: row.taskId,
    session: {
      sessionId: row.sessionId,
      phase: row.phase,
      environmentVersion: row.environmentVersion,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      attempt: attemptRecord(row, attemptColumnsSince),
    },
  }));
}
