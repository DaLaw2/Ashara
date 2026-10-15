import { sql } from "drizzle-orm";
import { z } from "zod";
import { ATTEMPT_TERMINALS, TERMINAL_SESSION_PHASES } from "@ashara/shared";
import type { ProjectId } from "@ashara/shared";
import type { DbHandle } from "../connection.js";

/** The project named for a run report does not exist. */
class RunReportProjectMissing extends Error {
  constructor(readonly projectId: ProjectId) {
    super(`run-report: no project ${projectId} in this database`);
    this.name = "RunReportProjectMissing";
  }
}

/**
 * schema_migrations has no row for migration 046, so no session can be dated against it and a
 * session without attempt columns cannot be told apart from one written before they existed.
 */
class RunReportAttemptMigrationUnrecorded extends Error {
  constructor(readonly filename: string) {
    super(`run-report: schema_migrations has no row for ${filename}; cannot tell a session written before it from one with no recorded attempt`);
    this.name = "RunReportAttemptMigrationUnrecorded";
  }
}

/** The migration that added the attempt columns; a session created before it applied cannot have them. */
const ATTEMPT_MIGRATION = "046_dev_session_attempt_evidence.sql";

const count = z.coerce.number().int().nonnegative();
const usd = z.coerce.number().nonnegative();

const ProjectRowSchema = z.object({ id: z.guid(), name: z.string(), status: z.string() });

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
  resolvedBy: z.string().nullable(),
  endOutcome: z.string().nullable(),
  endDetail: z.string().nullable(),
  attemptPromptDigest: z.string().nullable(),
  attemptTerminal: z.string().nullable(),
  attemptTurns: z.number().int().nullable(),
  attemptProvider: z.string().nullable(),
  attemptModel: z.string().nullable(),
  attemptCell: z.string().nullable(),
});

const TaskRowSchema = z.object({ taskId: z.guid(), title: z.string(), status: z.string() });

const CallTotalsRowSchema = z.object({
  taskId: z.guid().nullable(),
  provider: z.string(),
  calls: count,
  measuredCalls: count,
  measuredUsd: usd,
  unmeasuredEstimateUsd: usd,
  pendingCalls: count,
  lostCalls: count,
  zeroCostCalls: count,
  cacheCountedCalls: count,
  inputTokens: count,
  cacheReadTokens: count,
});

/**
 * What a session's row says about its attempt. Absent attempt columns never mean "no model call":
 * each NULL case names only what the row actually shows.
 * - `open`: the phase is not terminal (in flight, or a crash orphan not yet reconciled).
 * - `reconciled`: a reconciler (`by`), not the session itself, wrote its terminal phase.
 * - `predates-attempt-columns`: created before migration 046 applied.
 * - `completed-without-attempt`: it completed with no attempt (its work already delivered on main,
 *   W5 trial D5); `endDetail` is its terminal write's own detail, null on a row written before a
 *   completion recorded one.
 * - `unrecorded`: it ended without an attempt outcome reaching it (before the model, or the attempt
 *   threw); `endOutcome` is its terminal write's outcome, when one was written.
 */
type AttemptRecord =
  | { readonly kind: "recorded"; readonly attempt: z.infer<typeof AttemptSchema> }
  | { readonly kind: "open" }
  | { readonly kind: "reconciled"; readonly by: string }
  | { readonly kind: "predates-attempt-columns" }
  | { readonly kind: "completed-without-attempt"; readonly endDetail: string | null }
  | { readonly kind: "unrecorded"; readonly endOutcome: string | null };

/** One dev session of a task and what its row records about its attempt. */
interface SessionEvidence {
  readonly sessionId: string;
  readonly phase: string;
  readonly environmentVersion: string | null;
  readonly createdAt: Date;
  readonly attempt: AttemptRecord;
}

/**
 * One task's (or, with taskId null, the project's own) llm_calls of one provider. An unmeasured
 * row is one of three (migration 053): `pendingCalls` admitted and not yet recorded, `lostCalls`
 * admitted by a process that ended before recording them (unmeasured_after_crash), and the rest
 * recorded with no cost measured. `zeroCostCalls` counts rows priced at exactly $0, which the
 * ledger must never write; `cacheCountedCalls` are the
 * rows reporting both input and cache-read tokens, the only ones a cache-hit share is taken over.
 */
type CallTotals = z.infer<typeof CallTotalsRowSchema>;

interface TaskEvidence {
  readonly taskId: string;
  readonly title: string;
  readonly status: string;
  readonly sessions: readonly SessionEvidence[];
}

interface RunEvidence {
  readonly project: z.infer<typeof ProjectRowSchema>;
  readonly tasks: readonly TaskEvidence[];
  readonly calls: readonly CallTotals[];
}

function attemptRecord(row: z.infer<typeof SessionRowSchema>, attemptColumnsSince: Date): AttemptRecord {
  const columns = [row.attemptPromptDigest, row.attemptTerminal, row.attemptTurns, row.attemptProvider, row.attemptModel, row.attemptCell];
  // Migration 046's CHECK keeps the six together; parse them only when they are present.
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
  if (row.resolvedBy !== null) return { kind: "reconciled", by: row.resolvedBy };
  if (row.createdAt < attemptColumnsSince) return { kind: "predates-attempt-columns" };
  if (row.phase === "Completed") return { kind: "completed-without-attempt", endDetail: row.endDetail };
  return { kind: "unrecorded", endOutcome: row.endOutcome };
}

function toSession(row: z.infer<typeof SessionRowSchema>, attemptColumnsSince: Date): SessionEvidence {
  return {
    sessionId: row.sessionId,
    phase: row.phase,
    environmentVersion: row.environmentVersion,
    createdAt: row.createdAt,
    attempt: attemptRecord(row, attemptColumnsSince),
  };
}

/**
 * The evidence of one project's run (roadmap M2 exit 7): every task that had a dev session or an
 * llm_calls row, with each session's attempt record, and the project's llm_calls totals per task
 * and provider. Every row is validated on the way out of Postgres.
 */
export async function readRunEvidence(db: DbHandle, projectId: ProjectId): Promise<RunEvidence> {
  const projectRows = await db.execute(sql`SELECT id, name, status FROM projects WHERE id = ${projectId}`);
  const [projectRow] = projectRows.rows;
  if (projectRow === undefined) throw new RunReportProjectMissing(projectId);
  const project = ProjectRowSchema.parse(projectRow);

  const migrationRows = await db.execute(sql`SELECT applied_at AS "appliedAt" FROM schema_migrations WHERE filename = ${ATTEMPT_MIGRATION}`);
  const [migrationRow] = migrationRows.rows;
  if (migrationRow === undefined) throw new RunReportAttemptMigrationUnrecorded(ATTEMPT_MIGRATION);
  const attemptColumnsSince = z.object({ appliedAt: z.coerce.date() }).parse(migrationRow).appliedAt;

  const sessionRows = await db.execute(sql`
    SELECT s.id AS "sessionId", s.task_id AS "taskId", s.phase, s.environment_version AS "environmentVersion",
           s.created_at AS "createdAt", s.verification_result ->> 'resolvedBy' AS "resolvedBy",
           s.verification_result ->> 'outcome' AS "endOutcome",
           s.verification_result ->> 'detail' AS "endDetail",s.attempt_prompt_digest AS "attemptPromptDigest",
           s.attempt_terminal AS "attemptTerminal", s.attempt_turns AS "attemptTurns",
           s.attempt_provider AS "attemptProvider", s.attempt_model AS "attemptModel", s.attempt_cell AS "attemptCell"
    FROM dev_sessions s JOIN work_items w ON w.id = s.task_id
    WHERE w.project_id = ${projectId}
    ORDER BY s.created_at, s.id`);
  const sessions = z.array(SessionRowSchema).parse(sessionRows.rows);

  const taskRows = await db.execute(sql`
    SELECT w.id AS "taskId", w.title, w.status
    FROM work_items w
    WHERE w.project_id = ${projectId}
      AND (EXISTS (SELECT 1 FROM dev_sessions s WHERE s.task_id = w.id)
           OR EXISTS (SELECT 1 FROM llm_calls c WHERE c.task_id = w.id))
    ORDER BY w.created_at, w.id`);
  const tasks = z.array(TaskRowSchema).parse(taskRows.rows);

  const callRows = await db.execute(sql`
    SELECT task_id AS "taskId", provider,
           COUNT(*)::int AS calls,
           COUNT(cost_usd)::int AS "measuredCalls",
           COALESCE(SUM(cost_usd), 0)::float8 AS "measuredUsd",
           COALESCE(SUM(estimated_cost_usd) FILTER (WHERE cost_usd IS NULL), 0)::float8 AS "unmeasuredEstimateUsd",
           COUNT(*) FILTER (WHERE state = 'pending')::int AS "pendingCalls",
           COUNT(*) FILTER (WHERE state = 'unmeasured_after_crash')::int AS "lostCalls",
           COUNT(*) FILTER (WHERE cost_usd = 0)::int AS "zeroCostCalls",
           COUNT(*) FILTER (WHERE input_tokens IS NOT NULL AND cache_read_tokens IS NOT NULL)::int AS "cacheCountedCalls",
           COALESCE(SUM(input_tokens) FILTER (WHERE cache_read_tokens IS NOT NULL), 0)::bigint AS "inputTokens",
           COALESCE(SUM(cache_read_tokens) FILTER (WHERE input_tokens IS NOT NULL), 0)::bigint AS "cacheReadTokens"
    FROM llm_calls
    WHERE project_id = ${projectId}
    GROUP BY task_id, provider
    ORDER BY task_id NULLS FIRST, provider`);
  const calls = z.array(CallTotalsRowSchema).parse(callRows.rows);

  return {
    project,
    tasks: tasks.map((task) => ({
      ...task,
      sessions: sessions.filter((s) => s.taskId === task.taskId).map((s) => toSession(s, attemptColumnsSince)),
    })),
    calls,
  };
}
