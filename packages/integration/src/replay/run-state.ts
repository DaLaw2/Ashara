import { sql } from "drizzle-orm";
import pg from "pg";
import { z } from "zod";
import type { createDb } from "@ashara/db";
import { formatTaskSpec, loadProjectIntent } from "@ashara/workplace";
import type { ProjectIntentSource } from "@ashara/workplace";
import { assignmentIntentOf } from "@ashara/delivery";
import { parseWorkItemId } from "@ashara/shared";
import { parseStoredTaskSpec } from "@ashara/delivery";
import type { RecomposedBrief } from "../simulator/stored-text.js";

/**
 * The store side of run-state replay (scripts/replay-run-state.ts): a scratch database for a kept
 * run's dump, and today's composers run again over its records. Not an oracle: what is composed
 * here is judged by the simulator's I4 and I9 (stored-text.ts), which import nothing of it.
 */

type Db = ReturnType<typeof createDb>;

const PREFIX = "ashara_replay_";

/** A replay database name that is not a plain `ashara_replay_*` identifier is refused, never quoted around. */
class ReplayDatabaseNameRefused extends Error {
  constructor(readonly name: string) {
    super(`replay database name ${JSON.stringify(name)} is not ${PREFIX} followed by lower-case letters, digits and underscores`);
    this.name = "ReplayDatabaseNameRefused";
  }
}

export function replayDatabaseUrl(server: string, database: string): string {
  const url = new URL(server);
  url.pathname = `/${database}`;
  return url.toString();
}

async function admin(server: string, statement: (name: string) => string, name: string): Promise<void> {
  if (!new RegExp(`^${PREFIX}[a-z0-9_]+$`).test(name)) throw new ReplayDatabaseNameRefused(name);
  const client = new pg.Client({ connectionString: replayDatabaseUrl(server, "postgres"), application_name: "ashara-replay-admin" });
  await client.connect();
  try {
    await client.query(statement(name));
  } finally {
    await client.end();
  }
}

/** Creates an empty scratch database on the server; returns its name. Never the shared database. */
export async function createReplayDatabase(server: string): Promise<string> {
  const name = `${PREFIX}${Date.now()}_${process.pid}`;
  await admin(server, (each) => `CREATE DATABASE ${each}`, name);
  return name;
}

export async function dropReplayDatabase(server: string, name: string): Promise<void> {
  await admin(server, (each) => `DROP DATABASE IF EXISTS ${each} WITH (FORCE)`, name);
}

const projectRow = z.object({ id: z.string(), name: z.string() });

export async function replayProjects(db: Db): Promise<Array<z.infer<typeof projectRow>>> {
  return z.array(projectRow).parse((await db.execute(sql`SELECT id, name FROM projects ORDER BY created_at, id`)).rows);
}

const sessionRow = z.object({ id: z.string(), taskId: z.string(), title: z.string(), taskSpec: z.unknown(), visionAtCreation: z.number().nullable() });
const visionAt = z.object({
  projectId: z.string(),
  version: z.number(),
  visionText: z.string(),
  summary: z.string(),
  scopeBoundaries: z.unknown(),
  inferences: z.unknown(),
  openQuestions: z.unknown(),
});

/** The vision current when one session was recorded: today's intent composer reads it as the run's composer then would. */
function visionWhenRecorded(db: Db, sessionId: string): ProjectIntentSource {
  return {
    async loadIntent(taskId) {
      const rows = z.array(visionAt).parse(
        (
          await db.execute(sql`
            SELECT v.project_id AS "projectId", v.version, v.vision_text AS "visionText", v.summary,
                   v.scope_boundaries AS "scopeBoundaries", v.inferences, v.open_questions AS "openQuestions"
            FROM vision_documents v JOIN work_items w ON w.project_id = v.project_id
            WHERE w.id = ${taskId} AND v.created_at <= (SELECT created_at FROM dev_sessions WHERE id = ${sessionId})
            ORDER BY v.version DESC LIMIT 1`)
        ).rows,
      );
      const [row] = rows;
      return row === undefined ? null : assignmentIntentOf(row);
    },
  };
}

/**
 * Today's statement of each recorded session's brief facts: the goal and task section Delivery's
 * buildBrief takes from the task's task_spec, and the intent today's loadProjectIntent states. Its
 * other sections need the run's checkout and are not composed. A task_spec without a goal, end
 * state, scope or deliverables gets no task section, as today's dispatch refuses it: I9 names that
 * brief. A session whose intent cannot be composed throws ProjectIntentUnavailable: the replay
 * fails, never judges less.
 */
export async function recomposeBriefs(db: Db, projectId: string): Promise<RecomposedBrief[]> {
  const sessions = z.array(sessionRow).parse(
    (
      await db.execute(sql`
        SELECT s.id, s.task_id AS "taskId", w.title, w.task_spec AS "taskSpec",
               (SELECT max(v.version) FROM vision_documents v WHERE v.project_id = w.project_id AND v.created_at <= s.created_at) AS "visionAtCreation"
        FROM dev_sessions s JOIN work_items w ON w.id = s.task_id
        WHERE w.project_id = ${projectId} AND s.brief IS NOT NULL
        ORDER BY s.created_at, s.id`)
    ).rows,
  );
  const briefs: RecomposedBrief[] = [];
  for (const session of sessions) {
    const intent = await loadProjectIntent(visionWhenRecorded(db, session.id), parseWorkItemId(session.taskId, "dev_sessions.task_id"));
    const { goal, endState, scope, deliverables } = parseStoredTaskSpec(session.taskSpec) ?? {};
    const context =
      goal === undefined || endState === undefined || scope === undefined || deliverables === undefined
        ? ""
        : formatTaskSpec({ goal, endState, scope, deliverables });
    briefs.push({
      title: session.title,
      visionAtCreation: session.visionAtCreation,
      taskSpec: session.taskSpec,
      brief: { goal: goal ?? "", context, visionVersion: intent.visionVersion, assumptions: intent.assumptions },
    });
  }
  return briefs;
}

/** A record whose kept report was set aside for today's Engagement to report on again. */
interface SetAside {
  readonly table: "acceptance_sweeps" | "project_blocks";
  readonly id: string;
  readonly projectId: string;
  readonly reportId: string;
}

const setAsideRow = z.object({ id: z.string(), projectId: z.string(), reportId: z.string() });
const statusRow = z.object({ id: z.string(), status: z.string() });

export interface ReportsSetAside {
  readonly records: readonly SetAside[];
  /** The projects accepted again for the while, with the lifecycle state each had. */
  readonly statuses: ReadonlyArray<z.infer<typeof statusRow>>;
}

/**
 * Sets aside the kept delivered report of every passed sweep and the kept report of every blocked
 * project's open episode, so today's Engagement reports on them again. A project accepted and later
 * stopped or reopened is accepted again for the while: its delivered report was composed while it was.
 */
export async function setAsideReports(db: Db): Promise<ReportsSetAside> {
  return await db.transaction(async (tx) => {
    const sweeps = z.array(setAsideRow).parse(
      (
        await tx.execute(sql`
          UPDATE acceptance_sweeps s SET report_id = NULL FROM acceptance_sweeps o
          WHERE o.id = s.id AND s.passed AND s.report_id IS NOT NULL
          RETURNING s.id, s.project_id AS "projectId", o.report_id AS "reportId"`)
      ).rows,
    );
    const episodes = z.array(setAsideRow).parse(
      (
        await tx.execute(sql`
          UPDATE project_blocks b SET report_id = NULL FROM project_blocks o
          WHERE o.id = b.id AND b.ended_at IS NULL AND b.report_id IS NOT NULL
          RETURNING b.id, b.project_id AS "projectId", o.report_id AS "reportId"`)
      ).rows,
    );
    const statuses: Array<z.infer<typeof statusRow>> = [];
    for (const projectId of new Set(sweeps.map((sweep) => sweep.projectId))) {
      statuses.push(...z.array(statusRow).parse((await tx.execute(sql`SELECT id, lifecycle AS status FROM projects WHERE id = ${projectId} AND lifecycle <> 'accepted'`)).rows));
    }
    for (const { id } of statuses) await tx.execute(sql`UPDATE projects SET lifecycle = 'accepted' WHERE id = ${id}`);
    return {
      records: [...sweeps.map((row) => ({ table: "acceptance_sweeps" as const, ...row })), ...episodes.map((row) => ({ table: "project_blocks" as const, ...row }))],
      statuses,
    };
  });
}

/**
 * After today's Engagement ran: a record it reported on again loses its kept report; one it did not
 * (a project with a stop awaiting the Liaison is not reported on) gets its kept report back, judged
 * as kept. Project statuses are put back. Returns the records reported on again.
 */
export async function settleReports(db: Db, setAside: ReportsSetAside): Promise<SetAside[]> {
  return await db.transaction(async (tx) => {
    const recomposed: SetAside[] = [];
    for (const record of setAside.records) {
      const table = sql.identifier(record.table);
      const [now] = z.array(z.object({ reportId: z.string().nullable() })).parse((await tx.execute(sql`SELECT report_id AS "reportId" FROM ${table} WHERE id = ${record.id}`)).rows);
      if (now === undefined || now.reportId === null) {
        await tx.execute(sql`UPDATE ${table} SET report_id = ${record.reportId} WHERE id = ${record.id}`);
        continue;
      }
      await tx.execute(sql`DELETE FROM client_messages WHERE id = ${record.reportId}`);
      recomposed.push(record);
    }
    for (const { id, status } of setAside.statuses) await tx.execute(sql`UPDATE projects SET lifecycle = ${status} WHERE id = ${id}`);
    return recomposed;
  });
}

/** Whether a violation's key is about a text today's code composed again for this project, not one judged as kept. */
export function composedAgain(key: string, projectId: string, recomposed: readonly SetAside[]): boolean {
  if (key.startsWith("brief-")) return true;
  const of = (table: SetAside["table"]): boolean => recomposed.some((record) => record.table === table && record.projectId === projectId);
  if (key.startsWith("delivered-") || key.startsWith("accepted-")) return of("acceptance_sweeps");
  if (key.startsWith("halt-")) return of("project_blocks");
  return false;
}
